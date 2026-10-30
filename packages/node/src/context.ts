/**
 * Who a request is for, and the tags set on everything.
 *
 * Zharp joins a back end's spans and logs to the user and browser session that caused them
 * through two attributes, `enduser.id` and `session.id`. The browser SDK sends both in the W3C
 * `baggage` header next to `traceparent`; the processors here copy them from the baggage onto
 * every span and log written while handling that request, so nothing in the application has to
 * know about them.
 *
 * `Zharp.setUser()` covers the other case — a back end that knows the user itself (a session
 * cookie, an API token). OpenTelemetry's context is immutable, so the user cannot be put into
 * the request's context from inside a handler; it is kept per trace instead, and every span and
 * log in that trace picks it up from then on.
 */
import { context as otelContext, propagation, trace, type Context } from '@opentelemetry/api';
import type { ReadWriteLogRecord, LogRecordProcessor } from '@opentelemetry/sdk-logs';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace';
import type { ZharpUser } from './types';

/** Baggage entries copied onto spans and logs, unchanged in name. */
const BAGGAGE_KEYS = ['enduser.id', 'session.id'] as const;

/** The user as attributes, ready to set. */
export type UserAttributes = Record<string, string>;

export function userAttributes(user: ZharpUser): UserAttributes {
  const out: UserAttributes = { 'enduser.id': String(user.id) };
  if (user.email) out['enduser.email'] = String(user.email);
  if (user.name) out['enduser.name'] = String(user.name);
  return out;
}

/**
 * Users and tags, and which trace each user belongs to.
 *
 * A trace's user is dropped when the span that began the trace in this process ends — its
 * SERVER span, for a request — so the map holds only requests in flight.
 */
export class ContextStore {
  /** Set outside any request: a script or worker that is one user's work throughout. */
  globalUser: UserAttributes | null = null;
  readonly tags: Record<string, string | number | boolean> = {};
  private readonly byTrace = new Map<string, UserAttributes>();
  /** The first span of each trace in this process, which the user is also written onto. */
  private readonly localRoots = new Map<string, { spanId: string; span: Span }>();

  /** Set the user for the request in progress, or for the whole process outside one. */
  setUser(user: UserAttributes | null): void {
    const span = trace.getActiveSpan();
    const traceId = span?.spanContext().traceId;
    if (!span || !traceId) {
      this.globalUser = user;
      return;
    }
    if (user) {
      this.byTrace.set(traceId, user);
      // The spans already open learn it too: the request's own span is the one the dashboard
      // lists, and it is still open while the handler runs.
      span.setAttributes(user);
      this.localRoots.get(traceId)?.span.setAttributes(user);
    } else {
      this.byTrace.delete(traceId);
    }
  }

  /** What every span and log in `traceId` should carry, before baggage. */
  attributesFor(traceId: string | undefined): Record<string, string | number | boolean> {
    const user = (traceId && this.byTrace.get(traceId)) || this.globalUser;
    return user ? { ...this.tags, ...user } : { ...this.tags };
  }

  noteStart(span: Span, parent: Context): void {
    const parentSpan = trace.getSpanContext(parent);
    // No parent, or one from another process: this span starts the trace here.
    if (!parentSpan || parentSpan.isRemote) {
      const { traceId, spanId } = span.spanContext();
      if (!this.localRoots.has(traceId)) this.localRoots.set(traceId, { spanId, span });
    }
  }

  noteEnd(span: ReadableSpan): void {
    const { traceId, spanId } = span.spanContext();
    if (this.localRoots.get(traceId)?.spanId !== spanId) return;
    this.localRoots.delete(traceId);
    this.byTrace.delete(traceId);
  }
}

/** `enduser.id` and `session.id` from the baggage in `ctx`, when the caller sent them. */
function fromBaggage(ctx: Context): Record<string, string> {
  const out: Record<string, string> = {};
  const baggage = propagation.getBaggage(ctx);
  if (!baggage) return out;
  for (const key of BAGGAGE_KEYS) {
    const value = baggage.getEntry(key)?.value;
    if (value) out[key] = value;
  }
  return out;
}

/** Puts the user, session and tags on every span as it starts. Exports nothing itself. */
export class ContextSpanProcessor implements SpanProcessor {
  constructor(private readonly store: ContextStore) {}

  onStart(span: Span, parentContext: Context): void {
    try {
      this.store.noteStart(span, parentContext);
      // The store first, baggage over it: the browser's word on its own session is final, and
      // a user the server set itself is already in the store's entry for this trace.
      span.setAttributes({ ...this.store.attributesFor(span.spanContext().traceId), ...fromBaggage(parentContext) });
    } catch {
      // Never let telemetry break a request.
    }
  }

  onEnd(span: ReadableSpan): void {
    this.store.noteEnd(span);
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** The same for log records — those written through Zharp.log, the console, pino and winston alike. */
export class ContextLogProcessor implements LogRecordProcessor {
  constructor(private readonly store: ContextStore) {}

  onEmit(record: ReadWriteLogRecord, ctx?: Context): void {
    try {
      const active = ctx ?? otelContext.active();
      const traceId = record.spanContext?.traceId ?? trace.getSpanContext(active)?.traceId;
      const add = { ...this.store.attributesFor(traceId), ...fromBaggage(active) };
      // An attribute the call itself set (a log naming a different user, say) is kept.
      for (const [key, value] of Object.entries(add)) {
        if (record.attributes[key] === undefined) record.setAttribute(key, value);
      }
    } catch {
      // As above.
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
