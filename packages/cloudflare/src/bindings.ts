/**
 * The Worker's bindings, traced: D1 (see d1.ts), KV, R2, Queue producers, service bindings and
 * Durable Object stubs. The handler gets an `env` whose bindings are wrapped as they are used;
 * everything else in it (vars, secrets, bindings Zharp doesn't know) is handed over untouched.
 *
 * Bindings are told apart by their class (`D1Database`, `KvNamespace`, …). Not by their methods:
 * a service binding answers every method name (each is an RPC call), so it would look like all
 * of them.
 */
import { safely } from '../../browser/src/util';
import { wrapD1 } from './d1';
import { tracedFetch } from './fetch';
import { activeContext, requestOf, SpanKind, SpanStatusCode, startSpan } from './tracing';
import type { Runtime } from './state';

type Kind = 'd1' | 'kv' | 'r2' | 'queue' | 'service' | 'durable-object';

const CLASSES: Record<string, Kind> = {
  D1Database: 'd1',
  D1DatabaseSession: 'd1',
  KvNamespace: 'kv',
  R2Bucket: 'r2',
  WorkerQueue: 'queue',
  Fetcher: 'service',
  DurableObjectNamespace: 'durable-object',
};

const fn = (value: any, ...names: string[]) => names.every((name) => typeof safely(() => value[name]) === 'function');

/** What kind of binding `value` is, or undefined for anything Zharp leaves alone. */
export function bindingKind(value: unknown): Kind | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const name = safely(() => Object.getPrototypeOf(value)?.constructor?.name) as string | undefined;
  if (name && CLASSES[name]) return CLASSES[name];
  // Plain objects only below this point: a class we don't know (an RPC stub above all) is left alone.
  if (name && name !== 'Object') return undefined;
  if (fn(value, 'prepare', 'batch', 'exec')) return 'd1';
  if (fn(value, 'head', 'get', 'put', 'list', 'delete', 'createMultipartUpload')) return 'r2';
  if (fn(value, 'get', 'put', 'list', 'delete', 'getWithMetadata')) return 'kv';
  if (fn(value, 'send', 'sendBatch')) return 'queue';
  if (fn(value, 'idFromName', 'get')) return 'durable-object';
  return undefined;
}

const MARK = Symbol.for('zharp.cloudflare.wrapped');
const cache = new WeakMap<object, Map<string, object>>();

/** `env` with its bindings traced. The same binding object gets the same wrapper every time. */
export function instrumentEnv<E>(env: E, runtime: Runtime): E {
  if (!env || typeof env !== 'object' || (env as any)[MARK]) return env;
  return new Proxy(env as object, {
    get(target, prop, receiver) {
      if (prop === MARK) return true;
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string') return value;
      return wrapBinding(value, prop, runtime) ?? value;
    },
  }) as E;
}

/** The traced form of one binding, or undefined when it is not one Zharp traces. */
export function wrapBinding(value: unknown, name: string, runtime: Runtime): object | undefined {
  if (!value || typeof value !== 'object' || (value as any)[MARK]) return undefined;
  const kind = bindingKind(value);
  if (!kind) return undefined;
  let byName = cache.get(value);
  if (!byName) cache.set(value, (byName = new Map()));
  const cached = byName.get(name);
  if (cached) return cached;
  const wrapped = marked(build(kind, value, name, runtime));
  byName.set(name, wrapped);
  return wrapped;
}

function build(kind: Kind, value: any, name: string, runtime: Runtime): object {
  switch (kind) {
    case 'd1':
      return wrapD1(value, name, runtime.settings.captureQueryErrors);
    case 'kv':
      return methods(value, ['get', 'getWithMetadata', 'put', 'list', 'delete'], (method, args) => ({
        name: `KV ${method} ${name}`,
        kind: SpanKind.CLIENT,
        attributes: {
          'db.system': 'cloudflare_kv',
          'db.namespace': name,
          'db.operation.name': method,
          'cloudflare.binding.type': 'kv',
          'cloudflare.kv.key': typeof args[0] === 'string' ? args[0] : undefined,
          'cloudflare.kv.keys': Array.isArray(args[0]) ? args[0].length : undefined,
        },
        result: method.startsWith('get') ? (result) => ({ 'cloudflare.kv.hit': method === 'get' ? result !== null : (result as any)?.value !== null }) : undefined,
      }));
    case 'r2':
      return methods(value, ['head', 'get', 'put', 'list', 'delete', 'createMultipartUpload', 'resumeMultipartUpload'], (method, args) => ({
        name: `R2 ${method} ${name}`,
        kind: SpanKind.CLIENT,
        attributes: {
          'cloudflare.binding.type': 'r2',
          'cloudflare.r2.bucket': name,
          'cloudflare.r2.operation': method,
          'cloudflare.r2.key': typeof args[0] === 'string' ? args[0] : undefined,
        },
        result: method === 'get' || method === 'head' ? (result) => ({ 'cloudflare.r2.hit': result !== null }) : undefined,
      }));
    case 'queue':
      return methods(value, ['send', 'sendBatch'], (method, args) => ({
        name: `${name} send`,
        kind: SpanKind.PRODUCER,
        attributes: {
          'messaging.system': 'cloudflare_queues',
          'messaging.operation.type': 'send',
          'messaging.destination.name': name,
          'messaging.batch.message_count': method === 'sendBatch' && Array.isArray(args[0]) ? args[0].length : undefined,
        },
      }));
    case 'service':
      return fetcher(value, { name, type: 'service' }, runtime);
    case 'durable-object':
      return new Proxy(value, {
        get(target, prop) {
          const member = Reflect.get(target, prop, target);
          if (typeof member !== 'function') return member;
          // get(id) and getByName(name) hand out stubs; their fetch carries the trace on.
          if (prop === 'get' || prop === 'getByName') {
            return (...args: unknown[]) => fetcher(member.apply(target, args), { name, type: 'durable-object' }, runtime);
          }
          return member.bind(target);
        },
      });
  }
}

function marked<T extends object>(value: T): T {
  return new Proxy(value, {
    get(target, prop, receiver) {
      if (prop === MARK) return true;
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** A service binding or Durable Object stub whose `fetch` is traced; its RPC methods are left as they are. */
function fetcher(value: any, binding: { name: string; type: string }, runtime: Runtime): any {
  if (!value || typeof value !== 'object') return value;
  return new Proxy(value, {
    get(target, prop) {
      const member = Reflect.get(target, prop, target);
      if (prop !== 'fetch' || typeof member !== 'function') return member;
      return (input: RequestInfo | URL, init?: RequestInit) => tracedFetch(runtime, member, target, input, init, binding);
    },
  });
}

interface Call {
  name: string;
  kind: SpanKind;
  attributes: Record<string, unknown>;
  result?: (result: unknown) => Record<string, unknown>;
}

/** Each of `names` in a span of its own, while a request is running. */
function methods(value: any, names: string[], describe: (method: string, args: unknown[]) => Call): any {
  const traced = new Set(names);
  return new Proxy(value, {
    get(target, prop) {
      const member = Reflect.get(target, prop, target);
      if (typeof member !== 'function') return member;
      if (typeof prop !== 'string' || !traced.has(prop)) return member.bind(target);
      return (...args: unknown[]) => {
        const ctx = activeContext();
        if (!requestOf(ctx)) return member.apply(target, args);
        const call = describe(prop, args);
        const span = startSpan(call.name, { kind: call.kind, attributes: call.attributes as any }, ctx);
        let result: unknown;
        try {
          result = member.apply(target, args);
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error)?.message });
          span.end();
          throw error;
        }
        return Promise.resolve(result).then(
          (value) => {
            if (call.result) safely(() => span.setAttributes(call.result!(value)));
            span.end();
            return value;
          },
          (error) => {
            span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error)?.message ?? String(error) });
            span.end();
            throw error;
          },
        );
      };
    },
  });
}
