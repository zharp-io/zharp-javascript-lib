/**
 * @zharp/cloudflare: errors, traces, D1 queries and (when asked for) logs from Cloudflare
 * Workers, Durable Objects and Pages Functions, sent to Zharp as OTLP.
 *
 *     import { withZharp } from '@zharp/cloudflare';
 *
 *     export default withZharp((env) => ({ key: env.ZHARP_KEY }), {
 *       async fetch(request, env, ctx) { … },
 *     });
 */
import { SpanStatusCode } from '@opentelemetry/api';
import { asError } from '../../browser/src/instrument/errors';
import { safely } from '../../browser/src/util';
import { currentRuntime, setTag, setUser, type Level } from './state';
import { activeSpan, startSpan as startZharpSpan, withSpan } from './tracing';
import type { Attributes, ZharpUser } from './types';

export { withZharp, instrumentDurableObject, zharpPagesPlugin } from './handlers';
export type { Attributes, ZharpCloudflareOptions, ZharpConfig, ZharpUser } from './types';
export { VERSION } from './version';

type LogFn = (message: unknown, attributes?: Attributes) => void;

/** A span made with `Zharp.startSpan`. */
export interface ZharpSpanHandle {
  readonly traceId: string;
  readonly spanId: string;
  setAttribute(key: string, value: unknown): ZharpSpanHandle;
  setAttributes(attributes: Attributes): ZharpSpanHandle;
}

const log = (level: Level): LogFn => (message, attributes) => currentRuntime()?.emit(level, message, attributes);

const noopSpan: ZharpSpanHandle = {
  traceId: '',
  spanId: '',
  setAttribute: () => noopSpan,
  setAttributes: () => noopSpan,
};

/**
 * The API, as in the other Zharp JavaScript SDKs. Inside a request, tags and the user belong to
 * that request only; outside one (at module scope) they apply to everything this isolate sends.
 */
export const Zharp = {
  /** Report an error you caught. Sent as handled, grouped with its other occurrences. */
  captureError(error: unknown, attributes?: Attributes): void {
    currentRuntime()?.report(error, true, attributes);
  },

  /** Who the request is for: `enduser.id` (and email, name) on its spans, logs and errors. */
  setUser(user: ZharpUser | null): void {
    safely(() => setUser(user));
  },

  /** An attribute on the request's spans, logs and errors. `null` removes it. */
  setTag(key: string, value: string | number | boolean | null | undefined): void {
    safely(() => setTag(key, value));
  },

  /** Logs, sent whatever `ZHARP_LOGS` says, with the active request's trace. */
  log: {
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    fatal: log('fatal'),
  } as Record<Level, LogFn>,

  /**
   * Run `fn` in a span named `name`. Fetches, queries and logs inside it belong to it; a promise
   * it returns ends the span when it settles. Errors pass through unchanged.
   */
  startSpan<T>(name: string, fn: (span: ZharpSpanHandle) => T, attributes?: Attributes): T {
    if (!currentRuntime()) return fn(noopSpan);
    const span = startZharpSpan(name, { attributes: attributes as any });
    const fail = (error: unknown) => {
      span.setStatus({ code: SpanStatusCode.ERROR, message: asError(error).message });
      span.end();
    };
    try {
      const result = withSpan(span, () => fn(span));
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
        );
      }
      span.end();
      return result;
    } catch (error) {
      fail(error);
      throw error;
    }
  },

  /** The active span's trace ID, e.g. to show on an error page. */
  get traceId(): string | undefined {
    return activeSpan()?.traceId;
  },

  /** Send everything queued now. The wrappers already do this at the end of each request. */
  async flush(): Promise<void> {
    await currentRuntime()?.flush();
  },
};

export default Zharp;
