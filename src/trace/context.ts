import { SpanContext } from './types';
import { loadBuiltin } from './builtins';

/**
 * Where the currently active span lives.
 *
 * Two runtimes, two answers. In Node an incoming request and everything it awaits must stay
 * associated even though the event loop interleaves other requests in between — `AsyncLocalStorage`
 * is the only thing that survives an `await`, so it is used when present. In a browser there is
 * one call stack and no concurrency to untangle, so a single variable is both sufficient and
 * cheaper.
 *
 * The Node import is guarded rather than static: this bundle is neutral-platform and must load
 * in a browser, where `node:async_hooks` does not exist. It goes through `loadBuiltin` so the
 * ESM build finds it too — see builtins.ts.
 */

interface Storage {
  active(): SpanContext | null;
  run<T>(context: SpanContext | null, fn: () => T): T;
}

/** Browser and any runtime without async context: one current span, restored on the way out. */
function fallbackStorage(): Storage {
  let current: SpanContext | null = null;
  return {
    active: () => current,
    run(context, fn) {
      const previous = current;
      current = context;
      try {
        return fn();
      } finally {
        // Restored in `finally` so a throw does not leave an ended span active, which would
        // silently reparent everything that ran afterwards.
        current = previous;
      }
    },
  };
}

function nodeStorage(): Storage | null {
  try {
    const AsyncLocalStorage = loadBuiltin('async_hooks')?.AsyncLocalStorage;
    if (!AsyncLocalStorage) return null;

    // The module is deliberately untyped so this file does not depend on @types/node being present
    // in the consuming project, which means the store is typed at the boundary instead.
    const als: {
      getStore(): SpanContext | null | undefined;
      run<T>(store: SpanContext | null, fn: () => T): T;
    } = new AsyncLocalStorage();
    return {
      active: () => als.getStore() ?? null,
      run: (context, fn) => als.run(context, fn),
    };
  } catch {
    return null;
  }
}

const storage: Storage = nodeStorage() ?? fallbackStorage();

/** The span currently in scope, if any. */
export function activeContext(): SpanContext | null {
  return storage.active();
}

/** Run `fn` with `context` as the active span. */
export function withContext<T>(context: SpanContext | null, fn: () => T): T {
  return storage.run(context, fn);
}

// ── W3C Trace Context ───────────────────────────────────────────────────────

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * Serialise a span context into a `traceparent` header.
 * @param context - The span the outgoing request is made from
 */
export function toTraceparent(context: SpanContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? '01' : '00'}`;
}

/**
 * Parse an incoming `traceparent` header.
 *
 * @param header - Raw header value
 * @returns The caller's span context, or null if the header is absent or malformed
 */
export function fromTraceparent(header: string | null | undefined): SpanContext | null {
  if (!header) return null;
  const match = TRACEPARENT.exec(header.trim());
  if (!match) return null;

  const [, traceId, spanId, flags] = match;
  if (traceId === '0'.repeat(32) || spanId === '0'.repeat(16)) return null;

  // Only the low bit of the flags byte is defined, and it is the sampled flag.
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 0x01) === 1 };
}
