/**
 * @zharp/node: the OpenTelemetry Node SDK, configured for Zharp.
 *
 * Everything that makes spans is OpenTelemetry's — the Node SDK, the auto-instrumentations for
 * http, express, fastify, pg, redis, prisma's driver and the rest, the W3C propagators, the
 * pino/winston/bunyan log bridges. What is here is the configuration (where to send, with what
 * key, under which service), the two processors that put user and session on everything, a
 * console bridge, error capture, and a small API in the same shape as every other Zharp SDK.
 */
import { register as registerLoader } from 'node:module';
import {
  type Context,
  type DiagLogger,
  DiagLogLevel,
  diag,
  INVALID_SPAN_CONTEXT,
  logs,
  SeverityNumber,
  SpanStatusCode,
  trace,
  type Logger,
  type TextMapGetter,
  type TextMapPropagator,
  type Span,
  type SpanOptions,
} from '@opentelemetry/api';
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { envDetector, hostDetector, resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  SamplingDecision,
  TraceIdRatioBasedSampler,
  type Sampler,
  type SamplingResult,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import { BatchLogRecordProcessor, type LogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { announce, describeTarget, disabledByEnv, nodeEnv, packageName, pick, warn } from '@zharp/internal/env';
import { ContextLogProcessor, ContextSpanProcessor, ContextStore, userAttributes } from './context';
import { captureConsole } from './console';
import { asError, exceptionAttributes, SEVERITY, type Level } from './errors';
import type { Attributes, NodeOptions, ZharpUser } from './types';
import { VERSION } from './version';

export const DEFAULT_ENDPOINT = 'https://api.zharp.io/api/v1/otlp';

/** How long a flush on the way out may hold the process up. */
const EXIT_FLUSH_MS = 2_000;

type LogFn = (message: unknown, attributes?: Attributes) => void;

export class ZharpNode {
  private sdk: NodeSDK | null = null;
  private spanProcessors: SpanProcessor[] = [];
  private logProcessors: LogRecordProcessor[] = [];
  private logger: Logger | null = null;
  private readonly store = new ContextStore();
  private teardowns: Array<() => void> = [];
  /** False in logs-only mode (`tracing: false` / `ZHARP_TRACING=false`). */
  private tracing = true;
  /** Errors already sent, so one that is both rejected and then thrown is reported once. */
  private readonly reported = new WeakSet<object>();

  /** `Zharp.log.info("Order placed", { orderId })` — and debug, warn, error, fatal, trace. */
  readonly log: Record<Level, LogFn> = {
    trace: (m, a) => this.emit('trace', m, a),
    debug: (m, a) => this.emit('debug', m, a),
    info: (m, a) => this.emit('info', m, a),
    warn: (m, a) => this.emit('warn', m, a),
    error: (m, a) => this.emit('error', m, a),
    fatal: (m, a) => this.emit('fatal', m, a),
  };

  /** Whether `init()` started the SDK. */
  get isActive(): boolean {
    return this.sdk !== null;
  }

  /**
   * Start sending traces, logs and errors. Call it once, before the application's own modules
   * load — from a file preloaded with `node --import` (see the README) — so that http, the
   * database drivers and the frameworks are instrumented when they are first imported.
   */
  init(options: NodeOptions = {}): void {
    try {
      this.start(options);
    } catch (error) {
      warn(`Could not start: ${(error as Error)?.message ?? error}`);
    }
  }

  private start(options: NodeOptions): void {
    if (this.sdk) {
      warn('Zharp.init() was called again — the first call\'s settings stay in effect.');
      return;
    }
    if (disabledByEnv()) {
      announce('Disabled by ZHARP_DISABLED — nothing will be sent');
      return;
    }
    const key = pick(options.key, nodeEnv('ZHARP_API_KEY'), nodeEnv('ZHARP_KEY'));
    if (!key) {
      warn('No key found — pass Zharp.init({ key }) or set ZHARP_API_KEY. Nothing will be sent.');
      return;
    }
    const service = pick(options.service, nodeEnv('ZHARP_SERVICE'), nodeEnv('OTEL_SERVICE_NAME'), packageName()) ?? 'node-app';
    const environment = pick(options.environment, nodeEnv('ZHARP_ENV'), nodeEnv('NODE_ENV'));
    const release = pick(options.release, nodeEnv('ZHARP_RELEASE'), nodeEnv('ZHARP_VERSION'));
    const endpoint = (pick(options.endpoint, nodeEnv('ZHARP_ENDPOINT')) ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
    const tracing = tracingEnabled(options.tracing);
    this.tracing = tracing;

    if (options.debug) {
      // Bound to the console as it is now, before the bridge patches it: OpenTelemetry's own
      // messages about a failed export must not become log records that fail to export.
      const out = { error: console.error, warn: console.warn, info: console.info, debug: console.debug, verbose: console.debug };
      const prefixed = Object.fromEntries(
        Object.entries(out).map(([level, fn]) => [level, (message: string, ...args: unknown[]) => fn.call(console, `[Zharp][otel] ${message}`, ...args)]),
      ) as unknown as DiagLogger;
      diag.setLogger(prefixed, DiagLogLevel.DEBUG);
    }

    // ES modules can only be instrumented through a loader hook, and it has to be in place
    // before the application's first import — which is why init() belongs in a preloaded file.
    registerEsmHook();

    const headers = { Authorization: `Bearer ${key}` };
    const exporterOptions = { headers, compression: 'gzip' as any };
    // Logs only: no span exporter at all. The context processor stays, because it is what keeps
    // a user set with setUser() to its own request (see RecordOnlySampler).
    this.spanProcessors = tracing
      ? [
          new ContextSpanProcessor(this.store),
          new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ ...exporterOptions, url: `${endpoint}/v1/traces` }) }),
        ]
      : [new ContextSpanProcessor(this.store)];
    this.logProcessors = [
      new ContextLogProcessor(this.store),
      new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ ...exporterOptions, url: `${endpoint}/v1/logs` }) }),
    ];

    const resource = resourceFromAttributes({
      'service.name': service,
      ...(release ? { 'service.version': release } : {}),
      ...(environment ? { 'deployment.environment.name': environment } : {}),
      'telemetry.sdk.name': 'zharp',
      'telemetry.sdk.language': 'nodejs',
      'telemetry.sdk.version': VERSION,
      'process.runtime.name': 'nodejs',
      'process.runtime.version': process.versions.node,
    });

    const propagator = new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    });
    const rate = typeof options.sampleRate === 'number' ? Math.min(1, Math.max(0, options.sampleRate)) : 1;

    this.sdk = new NodeSDK({
      resource,
      // Host and OTEL_RESOURCE_ATTRIBUTES only. The process detector would send the command line,
      // which is where secrets passed as arguments live.
      resourceDetectors: [envDetector, hostDetector],
      sampler: tracing ? new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(rate) }) : new RecordOnlySampler(),
      textMapPropagator: tracing ? propagator : new ExtractOnlyPropagator(propagator),
      spanProcessors: this.spanProcessors,
      logRecordProcessors: this.logProcessors,
      // Without this the SDK would start an OTLP metrics exporter pointed at localhost:4318.
      metricReaders: [],
      instrumentations: [
        ...(tracing
          ? getNodeAutoInstrumentations({
              // A span per DNS lookup, socket and file read buries the requests that matter.
              '@opentelemetry/instrumentation-dns': { enabled: false },
              '@opentelemetry/instrumentation-net': { enabled: false },
              '@opentelemetry/instrumentation-fs': { enabled: false },
              ...options.instrumentations,
            })
          : logsOnlyInstrumentations(options)),
        ...(options.extraInstrumentations ?? []),
      ],
    });
    this.sdk.start();
    this.logger = logs.getLogger('@zharp/node', VERSION);

    if (options.captureConsole !== false) this.teardowns.push(captureConsole(this.logger));
    if (options.captureUncaught !== false) this.teardowns.push(this.captureProcessErrors());
    this.teardowns.push(this.flushOnExit());

    announce(`Application monitoring active${tracing ? '' : ' (logs only)'} — ${describeTarget(service, environment)}`);
  }

  /**
   * The user the current request is for: `enduser.id` (and `enduser.email`, `enduser.name`) on
   * every span and log of the request from here on, and on the request's own span. Outside a
   * request it applies to everything the process sends — for a script or a worker that runs as
   * one user.
   *
   * Requests from a page running @zharp/browser already carry the user in their baggage; this
   * is for servers that know the user themselves.
   */
  setUser(user: ZharpUser | null): void {
    try {
      this.store.setUser(user && user.id != null && user.id !== '' ? userAttributes(user) : null);
    } catch {
      // Never throw into the application.
    }
  }

  /** Forget the user — for the current request, or the process's when called outside one. */
  clearUser(): void {
    this.setUser(null);
  }

  /** An attribute on every span and log sent from now on, e.g. `setTag("region", "eu-west-1")`. */
  setTag(key: string, value: string | number | boolean | null | undefined): void {
    if (value === null || value === undefined) delete this.store.tags[key];
    else this.store.tags[key] = value;
  }

  /**
   * Report an error you caught. It is sent as handled, in the trace of the request it happened
   * in, and grouped into an issue with every other occurrence.
   */
  captureError(error: unknown, attributes?: Attributes): void {
    this.report(error, true, 'error', attributes);
  }

  /**
   * Run `fn` inside a span named `name`, which ends when `fn` returns or its promise settles. A
   * throw or rejection marks the span as failed and is passed on unchanged.
   */
  startSpan<T>(name: string, fn: (span: Span) => T, options: SpanOptions = {}): T {
    // Logs only: no span — the callback runs as it is, handed a non-recording stand-in with the
    // current trace's ids (so ending or annotating it touches nothing).
    if (!this.tracing) return fn(trace.wrapSpanContext(trace.getActiveSpan()?.spanContext() ?? INVALID_SPAN_CONTEXT));
    const tracer = trace.getTracer('@zharp/node', VERSION);
    return tracer.startActiveSpan(name, options, (span) => {
      const fail = (error: unknown) => {
        span.setStatus({ code: SpanStatusCode.ERROR, message: asError(error).message });
        span.end();
      };
      let result: T;
      try {
        result = fn(span);
      } catch (error) {
        fail(error);
        throw error;
      }
      if (result && typeof (result as any).then === 'function') {
        return (result as any).then(
          (value: unknown) => {
            span.end();
            return value;
          },
          (error: unknown) => {
            fail(error);
            throw error;
          },
        ) as T;
      }
      span.end();
      return result;
    });
  }

  /** Send everything waiting now. Await it before a serverless function returns. */
  async flush(timeoutMs = 5_000): Promise<void> {
    const all = Promise.all([...this.spanProcessors, ...this.logProcessors].map((p) => p.forceFlush().catch(() => {})));
    await Promise.race([all, new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  }

  /** Flush, stop, and put back everything that was patched. */
  async shutdown(): Promise<void> {
    const sdk = this.sdk;
    if (!sdk) return;
    this.sdk = null;
    for (const undo of this.teardowns.splice(0)) undo();
    await sdk.shutdown().catch(() => {});
  }

  // ── internals ─────────────────────────────────────────────────────────

  private emit(level: Level, message: unknown, attributes?: Attributes): void {
    try {
      if (!this.logger) return;
      const extra: Record<string, unknown> = {};
      // An Error among the attributes is the reason for the log: it is sent as the exception,
      // so `Zharp.log.error("Payment failed", { error })` becomes an issue with its stack.
      for (const [key, value] of Object.entries(attributes ?? {})) {
        if (value instanceof Error && (level === 'error' || level === 'fatal') && !extra['exception.type']) {
          Object.assign(extra, exceptionAttributes(value, true));
        } else {
          extra[key] = value instanceof Error ? `${value.name}: ${value.message}` : value;
        }
      }
      this.logger.emit({
        severityNumber: SEVERITY[level] as SeverityNumber,
        severityText: level.toUpperCase(),
        body: typeof message === 'string' ? message : message instanceof Error ? message.message : safeJson(message),
        attributes: extra as any,
      });
    } catch {
      // Never throw into the application.
    }
  }

  private report(value: unknown, handled: boolean, level: Level, attributes?: Attributes): void {
    try {
      if (!this.logger) return;
      const error = asError(value);
      if (value && typeof value === 'object') {
        if (this.reported.has(value)) return;
        this.reported.add(value);
      }
      const exception = exceptionAttributes(error, handled);
      this.logger.emit({
        severityNumber: SEVERITY[level] as SeverityNumber,
        severityText: level.toUpperCase(),
        body: `${exception['exception.type']}: ${exception['exception.message']}`,
        attributes: { ...(attributes as any), ...exception },
      });
      // An error in a request fails that request's span, so the trace shows where it broke.
      if (!handled) trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    } catch {
      // As above.
    }
  }

  /**
   * Uncaught exceptions and unhandled rejections, reported as unhandled.
   *
   * Listening for either changes what Node does — it no longer exits — so when Zharp's listener
   * is the only one, it finishes the job the way Node would have: print the error, then exit
   * with code 1, after the error has been sent. When the application has listeners of its own,
   * they decide, and Zharp only reports.
   */
  private captureProcessErrors(): () => void {
    const onException = (error: unknown, origin?: string) => {
      this.report(error, false, 'fatal', origin ? { 'zharp.mechanism': origin } : undefined);
      if (process.listenerCount('uncaughtException') > 1) return;
      this.crash(error);
    };
    const onRejection = (reason: unknown) => {
      this.report(reason, false, 'error', { 'zharp.mechanism': 'unhandledRejection' });
      if (process.listenerCount('unhandledRejection') > 1) return;
      const mode = unhandledRejectionsMode();
      if (mode === 'warn' || mode === 'none') return;
      if (mode === 'warn-with-error-code') {
        process.exitCode = 1;
        return;
      }
      this.crash(reason);
    };
    process.on('uncaughtException', onException);
    process.on('unhandledRejection', onRejection);
    return () => {
      process.off('uncaughtException', onException);
      process.off('unhandledRejection', onRejection);
    };
  }

  private crashing = false;

  private crash(error: unknown): void {
    if (this.crashing) return;
    this.crashing = true;
    try {
      // Straight to stderr, not console.error: the console is captured, and this is already sent.
      const text = error instanceof Error ? error.stack || String(error) : `Uncaught ${safeJson(error)}`;
      process.stderr.write(`${text}\n\nNode.js ${process.version}\n`);
    } catch {
      // Exit regardless.
    }
    this.flush(EXIT_FLUSH_MS).finally(() => process.exit(1));
  }

  /**
   * Send what is waiting when the process ends on its own (the event loop drains) or is told to
   * stop. A signal listener also replaces Node's default of exiting, so once the flush is done,
   * if no one else is listening, the signal is raised again with Zharp's listener gone.
   */
  private flushOnExit(): () => void {
    let flushing = false;
    const onBeforeExit = () => {
      if (flushing) return;
      flushing = true;
      this.flush(EXIT_FLUSH_MS).finally(() => (flushing = false));
    };
    process.on('beforeExit', onBeforeExit);

    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
    const handlers = signals.map((signal) => {
      const handler = () => {
        this.flush(EXIT_FLUSH_MS).finally(() => {
          process.off(signal, handler);
          if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
        });
      };
      process.on(signal, handler);
      return [signal, handler] as const;
    });

    return () => {
      process.off('beforeExit', onBeforeExit);
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
  }
}

/** `--unhandled-rejections=…` from the command line or NODE_OPTIONS; `throw` when unset. */
function unhandledRejectionsMode(): string {
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)];
  for (const flag of flags) {
    const match = /^--unhandled-rejections=(.+)$/.exec(flag);
    if (match) return match[1];
  }
  return 'throw';
}

function safeJson(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Register OpenTelemetry's ES module loader hook, once per process. */
function registerEsmHook(): void {
  const g = globalThis as any;
  if (g.__ZHARP_ESM_HOOK__) return;
  g.__ZHARP_ESM_HOOK__ = true;
  try {
    // Resolved from this package, which depends on @opentelemetry/instrumentation directly.
    registerLoader?.('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  } catch {
    // Older Node without module.register: CommonJS is still instrumented.
  }
}

/**
 * `tracing` from the option, else `ZHARP_TRACING` (`false`, `0`, `no`, `off` turn it off).
 * On unless one of them says otherwise.
 */
function tracingEnabled(option: boolean | undefined): boolean {
  if (typeof option === 'boolean') return option;
  const value = nodeEnv('ZHARP_TRACING');
  return !(value && /^(false|0|no|off)$/i.test(value));
}

/**
 * Logs only: the log bridges (pino, winston, bunyan) and the http *server* instrumentation —
 * nothing else. The http server side is there only to give each incoming request a context: it
 * reads the caller's `traceparent` and `baggage`, so the request's logs carry the caller's trace
 * id, session and user (and a fresh trace id of their own when the caller sent none). Its one
 * span per request is never exported. Outgoing requests are not patched at all, and nothing is
 * injected into them.
 */
function logsOnlyInstrumentations(options: NodeOptions) {
  // getNodeAutoInstrumentations has no "only these" option, but it honours this variable — set
  // for the duration of the call alone.
  const previous = process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS;
  process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS = 'http,pino,winston,bunyan';
  try {
    return getNodeAutoInstrumentations({
      ...options.instrumentations,
      '@opentelemetry/instrumentation-http': {
        ...options.instrumentations?.['@opentelemetry/instrumentation-http'],
        disableOutgoingRequestInstrumentation: true,
      },
    });
  } finally {
    if (previous === undefined) delete process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS;
    else process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS = previous;
  }
}

/**
 * Logs only: every span is recorded (so the context processor sees it start and end, which is
 * what scopes setUser() to a request) and none is sampled (so nothing could export it, and the
 * flags say so). Spans live in memory for the length of the request and are then dropped.
 */
class RecordOnlySampler implements Sampler {
  shouldSample(): SamplingResult {
    return { decision: SamplingDecision.RECORD };
  }

  toString(): string {
    return 'ZharpRecordOnlySampler';
  }
}

/** Reads `traceparent` and `baggage` from incoming requests; never writes them anywhere. */
class ExtractOnlyPropagator implements TextMapPropagator {
  constructor(private readonly inner: TextMapPropagator) {}

  inject(): void {}

  extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
    return this.inner.extract(context, carrier, getter);
  }

  fields(): string[] {
    return [];
  }
}
