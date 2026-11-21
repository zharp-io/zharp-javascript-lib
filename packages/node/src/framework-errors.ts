/**
 * Errors a web framework catches for the app and answers with a 5xx. They never reach
 * `uncaughtException` — the framework turned them into a response — so without these hooks a
 * NestJS service that fails on every request reports nothing.
 *
 * - NestJS: `ExceptionsHandler.prototype.next`, which every exception thrown in a controller,
 *   guard, pipe or interceptor goes through (custom exception filters included). An
 *   `HttpException` below 500 (a 401, a 404, a validation 400) is the app answering, not failing,
 *   and isn't reported.
 * - Express: `finalhandler`, where an error passed to `next(err)` ends when no error middleware
 *   of the app's own answered it.
 *
 * Both report in the request's context, so the error is in the request's trace.
 */
import { InstrumentationBase, InstrumentationNodeModuleDefinition, InstrumentationNodeModuleFile } from '@opentelemetry/instrumentation';
import { VERSION } from './version';

export type FrameworkErrorSink = (error: unknown, mechanism: 'nestjs' | 'express') => void;

/** The status an error will be answered with: its own, else 500. */
export function statusOf(error: unknown): number {
  if (!error || typeof error !== 'object') return 500;
  const e = error as { getStatus?: () => unknown; status?: unknown; statusCode?: unknown };
  try {
    if (typeof e.getStatus === 'function') {
      const status = Number(e.getStatus());
      if (Number.isFinite(status)) return status;
    }
  } catch {
    // A getStatus that throws: treat as a crash.
  }
  for (const value of [e.status, e.statusCode]) {
    const status = Number(value);
    if (Number.isInteger(status) && status >= 100 && status < 600) return status;
  }
  return 500;
}

const WRAPPED = Symbol.for('zharp.frameworkErrors');

export class FrameworkErrorsInstrumentation extends InstrumentationBase {
  constructor(private readonly sink: FrameworkErrorSink) {
    super('@zharp/node/framework-errors', VERSION, {});
  }

  protected init() {
    // Read when an error comes, not now: the base class calls init() before this class's fields are set.
    const report = (error: unknown, mechanism: 'nestjs' | 'express') => {
      try {
        if (statusOf(error) >= 500) this.sink(error, mechanism);
      } catch {
        // Never break the app's error handling over its telemetry.
      }
    };

    const nest = new InstrumentationNodeModuleFile(
      '@nestjs/core/exceptions/exceptions-handler.js',
      ['>=8 <13'],
      (moduleExports: any) => {
        const proto = moduleExports?.ExceptionsHandler?.prototype;
        if (proto?.next && !proto.next[WRAPPED]) {
          const original = proto.next;
          const next = function (this: unknown, exception: unknown, ...rest: unknown[]) {
            report(exception, 'nestjs');
            return original.call(this, exception, ...rest);
          };
          (next as any)[WRAPPED] = original;
          proto.next = next;
        }
        return moduleExports;
      },
      (moduleExports: any) => {
        const proto = moduleExports?.ExceptionsHandler?.prototype;
        if (proto?.next?.[WRAPPED]) proto.next = proto.next[WRAPPED];
      },
    );

    const finalhandler = new InstrumentationNodeModuleDefinition(
      'finalhandler',
      ['>=1 <3'],
      (moduleExports: any) => {
        if (typeof moduleExports !== 'function' || moduleExports[WRAPPED]) return moduleExports;
        const original = moduleExports;
        const wrapped = function (this: unknown, ...args: unknown[]) {
          const done = original.apply(this, args);
          return function (this: unknown, err: unknown, ...rest: unknown[]) {
            if (err) report(err, 'express');
            return done.call(this, err, ...rest);
          };
        };
        Object.assign(wrapped, original);
        (wrapped as any)[WRAPPED] = original;
        return wrapped;
      },
      (moduleExports: any) => moduleExports?.[WRAPPED] ?? moduleExports,
    );

    return [new InstrumentationNodeModuleDefinition('@nestjs/core', ['>=8 <13'], undefined, undefined, [nest]), finalhandler];
  }
}

/**
 * Exceptions OpenTelemetry's instrumentations record on their spans (NestJS's handler spans,
 * Express's layers, …). Each stays on its span — the trace shows where it was thrown — marked
 * `zharp.deferred`, so the server doesn't make an error of the event: the SDK reports errors
 * itself, once. A recorded exception is reported when the request it happened in is answered
 * with a 5xx (an app's own error middleware answering 500 included) and nothing reported it
 * already; one in a request that ended well was handled by the app. Query spans are left to
 * the database processor.
 */
export class RecordedExceptionsProcessor {
  private readonly pending = new Map<string, Array<{ error: unknown; spanContext: import('@opentelemetry/api').SpanContext; scope: string }>>();

  constructor(private readonly report: (error: unknown, spanContext: import('@opentelemetry/api').SpanContext, mechanism: string) => void) { }

  onStart(span: any): void {
    const scope: string = span.instrumentationScope?.name ?? span.instrumentationLibrary?.name ?? '';
    // OpenTelemetry's instrumentations, and Next.js's own tracing (its spans record what a route throws).
    if (!scope.startsWith('@opentelemetry/instrumentation-') && scope !== 'next.js') return;
    if (span.attributes?.['db.system'] || span.attributes?.['db.system.name']) return;
    const original = span.recordException.bind(span);
    span.recordException = (exception: any, time?: any) => {
      try {
        if (!exception || typeof exception !== 'object') return original(exception, time);
        const name = typeof exception.name === 'string' && exception.name !== 'error' ? exception.name : exception.constructor?.name || 'Error';
        span.addEvent('exception', {
          'exception.type': name,
          'exception.message': String(exception.message ?? ''),
          ...(typeof exception.stack === 'string' ? { 'exception.stacktrace': exception.stack } : {}),
          'zharp.deferred': 'true',
        }, time);
        const traceId = span.spanContext().traceId;
        const list = this.pending.get(traceId) ?? [];
        if (!list.some((p) => p.error === exception)) list.push({ error: exception, spanContext: span.spanContext(), scope: mechanismOf(scope) });
        this.pending.set(traceId, list);
        if (this.pending.size > 500) this.pending.delete(this.pending.keys().next().value!);
      } catch {
        original(exception, time);
      }
    };
  }

  onEnd(span: any): void {
    const parent = span.parentSpanContext;
    const isRoot = span.kind === 1 /* SERVER */ || !parent || parent.isRemote;
    if (!isRoot) return;
    const traceId = span.spanContext().traceId;
    const list = this.pending.get(traceId);
    if (!list) return;
    this.pending.delete(traceId);
    const status = Number(span.attributes?.['http.response.status_code'] ?? span.attributes?.['http.status_code']);
    const failed = Number.isFinite(status) && status > 0 ? status >= 500 : span.status?.code === 2;
    if (!failed) return;
    // The outermost recorded error is what the request failed with; the rest are the same one on its way up.
    const seen = new Set<unknown>();
    for (const p of list) {
      if (seen.has(p.error)) continue;
      seen.add(p.error);
      if (statusOf(p.error) < 500) continue;
      this.report(p.error, p.spanContext, p.scope);
      break;
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.pending.clear();
    return Promise.resolve();
  }
}

/** "@opentelemetry/instrumentation-nestjs-core" → "nestjs"; Express's router → "express". */
export function mechanismOf(scope: string): string {
  const name = scope.replace('@opentelemetry/instrumentation-', '').replace(/-core$/, '');
  if (name === 'router') return 'express';
  return name === 'next.js' ? 'nextjs' : name;
}
