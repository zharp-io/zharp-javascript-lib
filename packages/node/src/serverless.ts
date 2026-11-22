/**
 * Serverless functions: AWS Lambda, Azure Functions and Google Cloud Functions.
 *
 * A function's process is frozen (or ended) as soon as the handler returns, so whatever the
 * batch processors still hold would be sent at some later invocation, or never. The wrappers in
 * ZharpNode (`lambda`, `azureFunction`, `cloudFunction`) make each invocation one SERVER span
 * with the OpenTelemetry FaaS attributes, report what the handler threw, and flush before the
 * result goes back. What is here is the part that reads each platform's event and context:
 * the span's name, its attributes, the headers to continue the caller's trace from, and the
 * status the result stands for.
 */
import { randomUUID } from 'node:crypto';
import type { TextMapGetter } from '@opentelemetry/api';

export interface ServerlessOptions {
  /**
   * How long the flush after each invocation may hold the function up, in milliseconds.
   * Default 2000. On Lambda it is also kept inside the invocation's remaining time.
   */
  flushTimeout?: number;
}

export const DEFAULT_FLUSH_MS = 2_000;

type Attrs = Record<string, string | number | boolean>;

/** One invocation, as the span that covers it. */
export interface Invocation {
  name: string;
  attributes: Attrs;
  /** Headers (or a CloudEvent's extensions) carrying the caller's `traceparent`. */
  carrier?: unknown;
  /** Whether the trigger is an HTTP request: its result is read as a response. */
  http: boolean;
  mechanism: string;
}

// ── headers ─────────────────────────────────────────────────────────────

/** Reads a header from a plain object (any case) or from a Fetch `Headers`. */
export const headerGetter: TextMapGetter<unknown> = {
  get(carrier, key) {
    return header(carrier, key);
  },
  keys(carrier) {
    if (!carrier || typeof carrier !== 'object') return [];
    if (typeof (carrier as any).keys === 'function' && typeof (carrier as any).get === 'function') {
      try {
        return [...(carrier as any).keys()];
      } catch {
        return [];
      }
    }
    return Object.keys(carrier);
  },
};

export function header(carrier: unknown, name: string): string | undefined {
  if (!carrier || typeof carrier !== 'object') return undefined;
  const c = carrier as any;
  if (typeof c.get === 'function' && typeof c.has === 'function') {
    try {
      return c.get(name) ?? undefined;
    } catch {
      return undefined;
    }
  }
  const wanted = name.toLowerCase();
  for (const key of Object.keys(c)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = c[key];
    if (Array.isArray(value)) return value.join(',');
    return value == null ? undefined : String(value);
  }
  return undefined;
}

function pathOf(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url) return undefined;
  try {
    return new URL(url, 'http://x').pathname;
  } catch {
    return url.split('?')[0];
  }
}

function clean(attrs: Record<string, unknown>): Attrs {
  const out: Attrs = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = typeof value === 'number' || typeof value === 'boolean' ? value : String(value);
  }
  return out;
}

// ── AWS Lambda ──────────────────────────────────────────────────────────

/** Lambda's own `streamifyResponse` handlers: (event, responseStream, context). */
const STREAMING = Symbol.for('aws.lambda.runtime.handler.streaming');
export const isStreamingLambda = (handler: unknown) => (handler as any)?.[STREAMING] === 'response';

export function lambdaInvocation(event: any, ctx: any, coldstart: boolean): Invocation {
  const rc = event?.requestContext;
  const v2 = rc?.http && typeof rc.http.method === 'string';
  const v1 = typeof event?.httpMethod === 'string' && (rc || event.headers);
  const http = !!(v2 || v1);
  const functionName = ctx?.functionName ?? process.env.AWS_LAMBDA_FUNCTION_NAME;
  const arn: string | undefined = ctx?.invokedFunctionArn;
  const base = {
    'faas.trigger': lambdaTrigger(event, http),
    'faas.invocation_id': ctx?.awsRequestId,
    'faas.coldstart': coldstart,
    'faas.name': functionName,
    'faas.version': ctx?.functionVersion ?? process.env.AWS_LAMBDA_FUNCTION_VERSION,
    'cloud.provider': 'aws',
    'cloud.platform': 'aws_lambda',
    'cloud.region': process.env.AWS_REGION,
    'cloud.resource_id': arn,
    'cloud.account.id': arn?.split(':')[4],
  };
  if (!http) {
    const source = lambdaSource(event);
    return {
      name: functionName ?? 'lambda',
      attributes: clean({ ...base, ...(source ? { 'faas.event_source': source } : {}) }),
      http: false,
      mechanism: 'aws-lambda',
    };
  }
  const method = v2 ? rc.http.method : event.httpMethod;
  const path = v2 ? rc.http.path ?? event.rawPath : event.path;
  // `GET /items/{id}` (HTTP API) or `/items/{id}` (REST API); `$default` is no route at all.
  const routeKey: string | undefined = rc?.routeKey && rc.routeKey !== '$default' ? rc.routeKey.split(' ').slice(-1)[0] : undefined;
  const route = routeKey ?? (typeof event.resource === 'string' && !event.resource.includes('{proxy+}') ? event.resource : undefined);
  return {
    name: `${method} ${route ?? path ?? '/'}`,
    attributes: clean({
      ...base,
      'http.request.method': method,
      'url.path': path,
      'http.route': route,
      'url.scheme': header(event.headers, 'x-forwarded-proto'),
      'server.address': header(event.headers, 'host') ?? rc?.domainName,
      'user_agent.original': v2 ? rc.http.userAgent : header(event.headers, 'user-agent'),
      'client.address': v2 ? rc.http.sourceIp : rc?.identity?.sourceIp,
    }),
    // REST API events may carry the same header in both maps; the single-value one is enough.
    carrier: event.headers ?? event.multiValueHeaders,
    http: true,
    mechanism: 'aws-lambda',
  };
}

function lambdaSource(event: any): string | undefined {
  const record = Array.isArray(event?.Records) ? event.Records[0] : undefined;
  return record?.eventSource ?? record?.EventSource ?? (typeof event?.source === 'string' ? event.source : undefined);
}

function lambdaTrigger(event: any, http: boolean): string {
  if (http || event?.requestContext?.elb) return 'http';
  const source = lambdaSource(event) ?? '';
  if (/^aws:(sqs|sns|kinesis|kafka)$/.test(source) || source === 'aws:mq' || event?.eventSource === 'aws:kafka') return 'pubsub';
  if (/^aws:(s3|dynamodb)$/.test(source)) return 'datasource';
  if (event?.['detail-type'] === 'Scheduled Event' || source === 'aws.scheduler') return 'timer';
  return 'other';
}

/** The response status a Lambda HTTP result stands for (API Gateway's own rules). */
export function lambdaStatus(result: any, event: any): number | undefined {
  if (result && typeof result === 'object' && typeof result.statusCode === 'number') return result.statusCode;
  // HTTP API (payload 2.0): anything without a statusCode is a 200 with that as the body.
  if (event?.requestContext?.http) return 200;
  return undefined;
}

// ── Azure Functions ─────────────────────────────────────────────────────

/** v4 programming model: (triggerInput, context). v3: (context, ...inputs). */
export function azureInvocation(args: any[], coldstart: boolean): Invocation | null {
  const v4 = args[1] && typeof args[1] === 'object' && typeof args[1].invocationId === 'string';
  const v3 = !v4 && args[0] && typeof args[0] === 'object' && typeof args[0].invocationId === 'string';
  if (!v4 && !v3) return null;
  const ctx = v4 ? args[1] : args[0];
  const triggerType: string | undefined = v4
    ? ctx.options?.trigger?.type
    : (ctx.bindingDefinitions ?? []).find((b: any) => b?.direction === 'in' && /Trigger$/.test(b?.type ?? ''))?.type;
  const functionName = ctx.functionName ?? ctx.executionContext?.functionName;
  const request = v4 ? (triggerType === 'httpTrigger' ? args[0] : undefined) : ctx.req ?? (triggerType === 'httpTrigger' ? args[1] : undefined);
  const http = !!request && typeof request.method === 'string';
  const base = {
    'faas.trigger': azureTrigger(triggerType, http),
    'faas.invocation_id': ctx.invocationId,
    'faas.coldstart': coldstart,
    'faas.name': functionName,
    'cloud.provider': 'azure',
    'cloud.platform': 'azure_functions',
    'cloud.region': process.env.REGION_NAME,
  };
  if (!http) {
    return { name: functionName ?? 'function', attributes: clean(base), http: false, mechanism: 'azure-functions' };
  }
  const path = pathOf(request.url) ?? pathOf(request.originalUrl);
  return {
    name: `${request.method} ${path ?? '/'}`,
    attributes: clean({
      ...base,
      'http.request.method': request.method,
      'url.path': path,
      'user_agent.original': header(request.headers, 'user-agent'),
    }),
    carrier: request.headers,
    http: true,
    mechanism: 'azure-functions',
  };
}

function azureTrigger(type: string | undefined, http: boolean): string {
  if (http || type === 'httpTrigger') return 'http';
  if (type === 'timerTrigger') return 'timer';
  if (type && /^(queue|serviceBus|eventHub|eventGrid|kafka|rabbitMQ|webPubSub|signalR)/i.test(type)) return 'pubsub';
  if (type && /^(blob|cosmosDB|sql|mysql)/i.test(type)) return 'datasource';
  return 'other';
}

/** v4: the returned response's status (200 when it has none). v3: `context.res`. */
export function azureStatus(result: any, args: any[]): number {
  const v4 = args[1] && typeof args[1]?.invocationId === 'string';
  const response = v4 ? result : args[0]?.res ?? result;
  const status = response?.status ?? response?.statusCode;
  const n = typeof status === 'string' ? Number(status) : status;
  return typeof n === 'number' && Number.isFinite(n) ? n : 200;
}

// ── Google Cloud Functions ──────────────────────────────────────────────

const gcfName = () => process.env.K_SERVICE ?? process.env.FUNCTION_TARGET ?? process.env.FUNCTION_NAME;

const gcfBase = (coldstart: boolean) => ({
  'faas.coldstart': coldstart,
  'faas.name': gcfName(),
  'faas.version': process.env.K_REVISION,
  'cloud.provider': 'gcp',
  'cloud.platform': 'gcp_cloud_functions',
  'cloud.region': process.env.FUNCTION_REGION,
});

export const isHttpPair = (req: any, res: any) =>
  !!req && typeof req === 'object' && typeof req.method === 'string' && !!req.headers && !!res && typeof res.end === 'function';

export function gcfHttpInvocation(req: any, coldstart: boolean): Invocation {
  const path = pathOf(req.originalUrl ?? req.url);
  // Gen 1 sends the execution id; gen 2 (Cloud Run) has only the trace header.
  const id = header(req.headers, 'function-execution-id') ?? header(req.headers, 'x-cloud-trace-context')?.split('/')[0] ?? randomUUID();
  return {
    name: `${req.method} ${path ?? '/'}`,
    attributes: clean({
      ...gcfBase(coldstart),
      'faas.trigger': 'http',
      'faas.invocation_id': id,
      'http.request.method': req.method,
      'url.path': path,
      'server.address': header(req.headers, 'host'),
      'user_agent.original': header(req.headers, 'user-agent'),
    }),
    carrier: req.headers,
    http: true,
    mechanism: 'gcp-functions',
  };
}

/** A CloudEvent (`functions.cloudEvent`) or a legacy background event `(data, context)`. */
export function gcfEventInvocation(args: any[], coldstart: boolean): Invocation {
  const ce = args[0] && typeof args[0] === 'object' && typeof args[0].specversion === 'string' ? args[0] : undefined;
  const legacy = !ce && args[1] && typeof args[1] === 'object' ? args[1] : undefined;
  const type: string = ce?.type ?? legacy?.eventType ?? legacy?.type ?? '';
  const trigger = /pubsub/i.test(type) ? 'pubsub' : /storage|firestore|firebase|datastore|database/i.test(type) ? 'datasource' : /scheduler/i.test(type) ? 'timer' : 'other';
  return {
    name: gcfName() ?? 'function',
    attributes: clean({
      ...gcfBase(coldstart),
      'faas.trigger': trigger,
      'faas.invocation_id': ce?.id ?? legacy?.eventId ?? randomUUID(),
      'cloudevents.event_type': type || undefined,
      'cloudevents.event_source': ce?.source,
    }),
    // The CloudEvents distributed tracing extension.
    carrier: ce ? { traceparent: ce.traceparent, tracestate: ce.tracestate } : undefined,
    http: false,
    mechanism: 'gcp-functions',
  };
}

// ── resource ────────────────────────────────────────────────────────────

/** The platform's resource attributes, read from the environment each one sets. */
export function serverlessResource(): Attrs {
  const env = process.env;
  if (env.AWS_LAMBDA_FUNCTION_NAME) {
    const memory = Number(env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE);
    return clean({
      'cloud.provider': 'aws',
      'cloud.platform': 'aws_lambda',
      'cloud.region': env.AWS_REGION,
      'faas.name': env.AWS_LAMBDA_FUNCTION_NAME,
      'faas.version': env.AWS_LAMBDA_FUNCTION_VERSION,
      'faas.instance': env.AWS_LAMBDA_LOG_STREAM_NAME,
      'faas.max_memory': Number.isFinite(memory) && memory > 0 ? memory * 1024 * 1024 : undefined,
    });
  }
  if (env.FUNCTIONS_WORKER_RUNTIME && (env.WEBSITE_SITE_NAME || env.AzureWebJobsStorage || env.FUNCTIONS_EXTENSION_VERSION)) {
    return clean({
      'cloud.provider': 'azure',
      'cloud.platform': 'azure_functions',
      'cloud.region': env.REGION_NAME,
      'faas.instance': env.WEBSITE_INSTANCE_ID,
    });
  }
  if (env.FUNCTION_TARGET && (env.K_SERVICE || env.FUNCTION_NAME)) {
    return clean({
      'cloud.provider': 'gcp',
      'cloud.platform': 'gcp_cloud_functions',
      'cloud.region': env.FUNCTION_REGION,
      'faas.name': gcfName(),
      'faas.version': env.K_REVISION,
    });
  }
  return {};
}

/** The function's own name, for `service.name` when nothing else gives one. */
export function serverlessName(): string | undefined {
  return process.env.AWS_LAMBDA_FUNCTION_NAME ?? process.env.WEBSITE_SITE_NAME ?? (process.env.FUNCTION_TARGET ? gcfName() : undefined);
}

/** Keep a wrapper's arity, name and any marker the platform reads off the handler. */
export function sameShape<H extends Function>(wrapper: Function, handler: H): H {
  try {
    Object.defineProperty(wrapper, 'length', { value: handler.length });
    Object.defineProperty(wrapper, 'name', { value: handler.name });
    for (const key of Object.getOwnPropertySymbols(handler)) (wrapper as any)[key] = (handler as any)[key];
  } catch {
    // Cosmetic only.
  }
  return wrapper as unknown as H;
}
