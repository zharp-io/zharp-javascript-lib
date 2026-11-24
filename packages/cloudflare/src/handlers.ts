/**
 * The entry points: Workers (`withZharp`), Durable Objects (`instrumentDurableObject`) and Pages
 * Functions (`zharpPagesPlugin`).
 *
 * Each invocation — a request, a cron run, a queue batch, an alarm, an RPC call — is one span
 * (SERVER, or CONSUMER for a queue) that continues the caller's `traceparent`. What it throws is
 * reported, as unhandled, and thrown on, so Cloudflare answers as it would have. Everything is
 * sent with `waitUntil` once the invocation's own `waitUntil` work has settled: the response
 * isn't held up.
 */
import { headerAttributes } from '@zharp/internal/headers';
import { redactUrl } from '@zharp/internal/bodies';
import { ROOT_CONTEXT, trace, type Context } from '@opentelemetry/api';
import { safely } from '../../browser/src/util';
import { instrumentEnv, wrapBinding } from './bindings';
import { hookHonoErrors, honoRoute, isHono } from './hono';
import { runtimeFor, type RequestState, type Runtime } from './state';
import { contextManager, parseTraceparent, SpanKind, SpanStatusCode, withRequest, ZharpSpan } from './tracing';
import type { ZharpConfig } from './types';

const WORKER = { service: 'worker', platform: 'cloudflare.workers' };
const PAGES = { service: 'pages', platform: 'cloudflare.pages' };

/** A path as a route when nothing better is known: identifiers as `:id`, the way the dashboard groups them. */
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|[A-Za-z0-9_-]{24,})$/i;
export const routeFromPath = (path: string) => path.split('/').map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment)).join('/') || '/';

interface Invocation {
  name: string;
  kind: SpanKind;
  attributes: Record<string, unknown>;
  /** The caller's trace, from a `traceparent` header. */
  traceparent?: string | null;
  mechanism: string;
}

interface Waiter {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Run one invocation in its span and request state. `after` sees the result (a Response) before
 * the span ends.
 */
async function invoke<T>(
  runtime: Runtime,
  invocation: Invocation,
  waiter: Waiter | undefined,
  run: (state: RequestState, span: ZharpSpan) => Promise<T> | T,
  after?: (result: T, span: ZharpSpan) => void,
): Promise<T> {
  const state = runtime.newRequest();
  const parent = parseTraceparent(invocation.traceparent);
  const span = new ZharpSpan(invocation.name, invocation.kind, parent, state, invocation.attributes as any);
  const ctx: Context = trace.setSpan(withRequest(ROOT_CONTEXT, state), span);
  try {
    const result = await contextManager.with(ctx, () => run(state, span));
    if (after) safely(() => after(result, span));
    return result;
  } catch (error) {
    runtime.report(error, false, { 'zharp.mechanism': invocation.mechanism }, span);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error)?.message ?? String(error) });
    if (invocation.attributes['http.request.method'] && !span.attributes['http.response.status_code']) {
      span.setAttribute('http.response.status_code', 500);
    }
    throw error;
  } finally {
    span.end();
    const done = runtime.finish(state);
    if (waiter) safely(() => waiter.waitUntil(done));
  }
}

/** `ctx` whose `waitUntil` work is watched: what it rejects with is reported, and the flush waits for it. */
function watchWaitUntil<C extends object>(ctx: C, state: RequestState, runtime: Runtime): C {
  if (!ctx || typeof (ctx as any).waitUntil !== 'function') return ctx;
  return new Proxy(ctx, {
    get(target, prop) {
      const member = Reflect.get(target, prop, target);
      if (prop === 'waitUntil' && typeof member === 'function') {
        return (promise: Promise<unknown>) => {
          const watched = Promise.resolve(promise).catch((error) => {
            runtime.report(error, false, { 'zharp.mechanism': 'waitUntil' });
            throw error;
          });
          state.pending.push(watched);
          return member.call(target, watched);
        };
      }
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
}

/** The span for an incoming request. */
function requestInvocation(request: Request, runtime: Runtime, mechanism: string, extra: Record<string, unknown> = {}): Invocation {
  const url = safely(() => new URL(request.url));
  const method = request.method.toUpperCase();
  const cf = (request as any).cf as Record<string, unknown> | undefined;
  const headers = request.headers;
  return {
    name: `${method} ${routeFromPath(url?.pathname ?? '/')}`,
    kind: SpanKind.SERVER,
    traceparent: headers.get('traceparent'),
    mechanism,
    attributes: {
      'faas.trigger': 'http',
      'http.request.method': method,
      'url.full': redactUrl(request.url),
      'url.path': url?.pathname,
      'url.scheme': url?.protocol.replace(':', ''),
      'server.address': url?.hostname,
      'user_agent.original': headers.get('user-agent') ?? undefined,
      'client.address': headers.get('cf-connecting-ip') ?? undefined,
      'cloudflare.ray_id': headers.get('cf-ray') ?? undefined,
      'cloudflare.colo': typeof cf?.colo === 'string' ? cf.colo : undefined,
      'geo.country.iso_code': typeof cf?.country === 'string' ? cf.country : undefined,
      ...(runtime.headers ? headerAttributes('request', headers, runtime.headers) : {}),
      ...extra,
    },
  };
}

function responseDone(runtime: Runtime) {
  return (response: unknown, span: ZharpSpan) => {
    if (!(response instanceof Response)) return;
    span.setAttribute('http.response.status_code', response.status);
    if (runtime.headers) span.setAttributes(headerAttributes('response', response.headers, runtime.headers));
    if (response.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${response.status}` });
  };
}

// ── Workers ─────────────────────────────────────────────────────────────

type AnyHandler = Record<string, any>;

/** Each handler of a Worker's default export, traced. */
function workerMethod(name: string, original: Function, thisArg: unknown, config: ZharpConfig | undefined, app: unknown) {
  return function (this: unknown, ...args: any[]) {
    const self = thisArg ?? this;
    const env = name === 'fetch' || name === 'scheduled' || name === 'queue' || name === 'email' || name === 'tail' || name === 'trace' ? args[1] : undefined;
    const ctx = args[2];
    const runtime = env !== undefined ? runtimeFor(env, config, WORKER) : null;
    if (!runtime) return original.apply(self, args);
    const wrappedEnv = instrumentEnv(env, runtime);

    if (name === 'fetch') {
      const request = args[0] as Request;
      if (isHono(app)) hookHonoErrors(app, runtime);
      const invocation = requestInvocation(request, runtime, 'cloudflare.fetch');
      return invoke(runtime, invocation, ctx, (state) => original.call(self, request, wrappedEnv, watchWaitUntil(ctx, state, runtime), ...args.slice(3)), (response, span) => {
        responseDone(runtime)(response, span);
        const route = isHono(app) ? honoRoute(app, request) : undefined;
        if (route) {
          span.setAttribute('http.route', route);
          span.updateName(`${request.method.toUpperCase()} ${route}`);
        }
      });
    }

    if (name === 'scheduled') {
      const controller = args[0] ?? {};
      const invocation: Invocation = {
        name: `cron ${controller.cron ?? ''}`.trim(),
        kind: SpanKind.SERVER,
        mechanism: 'cloudflare.scheduled',
        attributes: {
          'faas.trigger': 'timer',
          'faas.cron': controller.cron,
          'faas.time': typeof controller.scheduledTime === 'number' ? new Date(controller.scheduledTime).toISOString() : undefined,
        },
      };
      return invoke(runtime, invocation, ctx, (state) => original.call(self, controller, wrappedEnv, watchWaitUntil(ctx, state, runtime)));
    }

    if (name === 'queue') {
      const batch = args[0] ?? {};
      const invocation: Invocation = {
        name: `${batch.queue ?? 'queue'} process`,
        kind: SpanKind.CONSUMER,
        mechanism: 'cloudflare.queue',
        attributes: {
          'faas.trigger': 'pubsub',
          'messaging.system': 'cloudflare_queues',
          'messaging.operation.type': 'process',
          'messaging.destination.name': batch.queue,
          'messaging.batch.message_count': Array.isArray(batch.messages) ? batch.messages.length : undefined,
        },
      };
      return invoke(runtime, invocation, ctx, (state) => original.call(self, batch, wrappedEnv, watchWaitUntil(ctx, state, runtime)));
    }

    // email, tail and the rest: one span named after the handler.
    const invocation: Invocation = { name, kind: SpanKind.SERVER, mechanism: `cloudflare.${name}`, attributes: { 'faas.trigger': 'other' } };
    return invoke(runtime, invocation, ctx, (state) => original.call(self, args[0], wrappedEnv, watchWaitUntil(ctx, state, runtime), ...args.slice(3)));
  };
}

const HANDLERS = new Set(['fetch', 'scheduled', 'queue', 'email', 'tail', 'trace', 'test']);

/**
 * A Worker's default export, traced:
 *
 *     export default withZharp((env) => ({ key: env.ZHARP_KEY }), {
 *       async fetch(request, env, ctx) { … },
 *       async scheduled(controller, env, ctx) { … },
 *     });
 *
 * The handler can be an object (`{ fetch, scheduled, queue }`), a Hono app, or a
 * `WorkerEntrypoint` class. With no config, settings come from `env` (`ZHARP_KEY`, …).
 */
export function withZharp<H>(handler: H): H;
export function withZharp<H, E = any>(config: ZharpConfig<E> | undefined, handler: H): H;
export function withZharp(configOrHandler: any, maybeHandler?: any): any {
  const [config, handler] = maybeHandler === undefined ? [undefined, configOrHandler] : [configOrHandler, maybeHandler];
  if (typeof handler === 'function') return instrumentClass(handler, config, WORKER, 'worker');
  if (!handler || typeof handler !== 'object') return handler;
  const wrapped = new Map<string, Function>();
  return new Proxy(handler, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || !HANDLERS.has(prop) || typeof value !== 'function') return value;
      let fn = wrapped.get(prop);
      if (!fn) wrapped.set(prop, (fn = workerMethod(prop, value, target, config, target)));
      return fn;
    },
  });
}

// ── Durable Objects and WorkerEntrypoint classes ────────────────────────

const WEBSOCKET: Record<string, string> = { webSocketMessage: 'websocket message', webSocketClose: 'websocket close', webSocketError: 'websocket error' };
const NOT_RPC = new Set(['constructor', 'then', 'toJSON', 'dup', 'ctx', 'env', 'state', 'storage']);

/**
 * A Durable Object class, traced: each `fetch`, RPC method, `alarm` and WebSocket message is a
 * span, and errors are reported.
 *
 *     export const Cart = instrumentDurableObject(CartObject);
 *
 * Settings come from `config`, else from the config given to `withZharp`, else from `env`.
 */
export function instrumentDurableObject<C extends new (...args: any[]) => any>(cls: C, config?: ZharpConfig): C {
  return instrumentClass(cls, config, WORKER, 'durable-object');
}

function instrumentClass<C extends new (...args: any[]) => any>(cls: C, config: ZharpConfig | undefined, defaults: typeof WORKER, kind: 'durable-object' | 'worker'): C {
  return new Proxy(cls, {
    construct(target, args, newTarget) {
      const [state, env] = args;
      const runtime = runtimeFor(env, config, defaults);
      if (!runtime) return Reflect.construct(target, args, newTarget);
      const instance = Reflect.construct(target, [state, instrumentEnv(env, runtime), ...args.slice(2)], newTarget);
      const className = (target as any).name || (kind === 'durable-object' ? 'DurableObject' : 'Worker');
      const id = safely(() => state?.id?.toString?.()) as string | undefined;
      const wrapped = new Map<PropertyKey, Function>();

      const method = (prop: string, original: Function) =>
        function (this: unknown, ...callArgs: any[]) {
          const base = {
            'cloudflare.durable_object.class': kind === 'durable-object' ? className : undefined,
            'cloudflare.durable_object.id': kind === 'durable-object' ? id : undefined,
          };
          let invocation: Invocation;
          let after: ((result: any, span: ZharpSpan) => void) | undefined;
          if (prop === 'fetch' && callArgs[0] instanceof Request) {
            invocation = requestInvocation(callArgs[0], runtime, kind === 'durable-object' ? 'cloudflare.durable_object' : 'cloudflare.fetch', base);
            after = responseDone(runtime);
          } else if (prop === 'alarm') {
            invocation = { name: `${className} alarm`, kind: SpanKind.SERVER, mechanism: 'cloudflare.alarm', attributes: { 'faas.trigger': 'timer', ...base } };
          } else if (WEBSOCKET[prop]) {
            invocation = { name: `${className} ${WEBSOCKET[prop]}`, kind: SpanKind.SERVER, mechanism: 'cloudflare.websocket', attributes: { 'faas.trigger': 'other', ...base } };
          } else if (prop === 'scheduled' || prop === 'queue') {
            invocation = {
              name: prop === 'scheduled' ? `cron ${callArgs[0]?.cron ?? ''}`.trim() : `${callArgs[0]?.queue ?? 'queue'} process`,
              kind: prop === 'queue' ? SpanKind.CONSUMER : SpanKind.SERVER,
              mechanism: `cloudflare.${prop}`,
              attributes: { 'faas.trigger': prop === 'queue' ? 'pubsub' : 'timer', 'faas.cron': callArgs[0]?.cron, 'messaging.destination.name': callArgs[0]?.queue },
            };
          } else {
            invocation = {
              name: `${className}.${prop}`,
              kind: SpanKind.SERVER,
              mechanism: 'cloudflare.rpc',
              attributes: { 'rpc.system': 'cloudflare_rpc', 'rpc.service': className, 'rpc.method': prop, ...base },
            };
          }
          const waiter: Waiter | undefined = typeof state?.waitUntil === 'function' ? state : undefined;
          // On the object itself, not this proxy: a method calling another through `this` is not a
          // new invocation, and private fields work.
          return invoke(runtime, invocation, waiter, () => original.apply(instance, callArgs), after);
        };

      return new Proxy(instance, {
        get(obj, prop, receiver) {
          const value = Reflect.get(obj, prop, receiver);
          if (typeof prop !== 'string' || typeof value !== 'function' || NOT_RPC.has(prop) || prop.startsWith('_')) return value;
          // Only what the class (or a parent below DurableObject) defines: not Object's own methods.
          if (value === (Object.prototype as any)[prop]) return value;
          let fn = wrapped.get(prop);
          if (!fn) wrapped.set(prop, (fn = method(prop, value)));
          return fn;
        },
      });
    },
  });
}

// ── Pages Functions ─────────────────────────────────────────────────────

interface PagesContext {
  request: Request;
  env: Record<string, unknown>;
  waitUntil(promise: Promise<unknown>): void;
  next(input?: Request | string, init?: RequestInit): Promise<Response>;
  functionPath?: string;
  [key: string]: unknown;
}

/**
 * Pages Functions: in `functions/_middleware.ts`,
 *
 *     export const onRequest = zharpPagesPlugin((context) => ({ key: context.env.ZHARP_KEY }));
 *
 * Every request through the project's Functions is a span, errors they throw are reported, and
 * D1, KV, R2 and the rest of `context.env` are traced for the functions after it.
 */
export function zharpPagesPlugin<E = any>(config?: ZharpConfig<E> | ((context: PagesContext) => ReturnType<Extract<ZharpConfig<E>, Function>>)) {
  return async (context: PagesContext): Promise<Response> => {
    const settingsFrom = typeof config === 'function' ? (env: E) => (config as Function)({ ...context, env }) : config;
    const runtime = runtimeFor(context.env, settingsFrom as ZharpConfig | undefined, PAGES);
    if (!runtime) return context.next();
    // The functions after this one get their own context, built from the same env object.
    safely(() => {
      for (const key of Object.keys(context.env)) {
        const wrapped = wrapBinding(context.env[key], key, runtime);
        if (wrapped) context.env[key] = wrapped;
      }
    });
    const invocation = requestInvocation(context.request, runtime, 'cloudflare.pages');
    return invoke(runtime, invocation, context, (state) => {
      // Their waitUntil work, watched like a Worker's.
      const watched = watchWaitUntil({ waitUntil: context.waitUntil.bind(context) }, state, runtime);
      safely(() => {
        (context as any).waitUntil = watched.waitUntil;
      });
      return context.next();
    }, responseDone(runtime));
  };
}
