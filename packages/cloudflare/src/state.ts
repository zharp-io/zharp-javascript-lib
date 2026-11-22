/**
 * The SDK in one isolate: settings read from the first `env` it sees, the queues of spans and
 * logs, and how errors are reported. And the state of each request (or alarm, queue batch,
 * cron run) it handles: its tags, its user, and what it still has to send when it ends.
 *
 * An isolate lives across many requests, so nothing about a request is kept outside its state;
 * and there is no timer to send things later — each request flushes with `ctx.waitUntil`, so the
 * response is not held up and the work still finishes.
 */
import { headerSettings, type HeaderSettings } from '@zharp/internal/headers';
import { asError, exceptionAttributes, watchConsole } from '../../browser/src/instrument/errors';
import { Exporter, type Endpoint } from '../../browser/src/transport';
import { keyValues, now, safely, safeString, toNanos } from '../../browser/src/util';
import { DEFAULT_ENDPOINT, resolveSettings, type Settings } from './settings';
import { activeSpan, registerOpenTelemetry, requestOf, setRecordedExceptionHandler, setSpanSink, type ZharpSpan } from './tracing';
import type { Attributes, ZharpConfig, ZharpUser } from './types';
import { VERSION } from './version';
import { claimQueryFailure, unclaimedQueryFailures, type QueryFailure } from './d1';
import { instrumentGlobalFetch } from './fetch';

export const SEVERITY = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 } as const;
export type Level = keyof typeof SEVERITY;

export interface RequestState {
  runtime: Runtime;
  tags: Record<string, unknown>;
  user: ZharpUser | null;
  /** Failed queries not yet reported: reported as handled when the request ends, unless what it threw claims them first. */
  queryFailures: QueryFailure[];
  /** Work handed to `ctx.waitUntil`: the request is flushed once it has settled. */
  pending: Promise<unknown>[];
}

/** Tags and user set outside any request: on everything this isolate sends. */
const globalTags: Record<string, unknown> = {};
let globalUser: ZharpUser | null = null;

export class Runtime {
  readonly endpoint: Endpoint;
  readonly spans: Exporter<unknown>;
  readonly logs: Exporter<unknown>;
  readonly headers: HeaderSettings | null;
  /** Errors already reported, so one rethrown, caught again or logged is sent once. */
  private readonly reported = new WeakSet<object>();

  constructor(readonly settings: Settings) {
    const original = globalThis.fetch;
    this.endpoint = {
      url: settings.endpoint,
      key: settings.key,
      fetch: original,
      rejectedHint: 'nothing more will be sent from this isolate. Check the ZHARP_KEY secret (the app key from the Zharp dashboard).',
    };
    this.headers = headerSettings(settings.captureHeaders);
    const resource = keyValues(settings.resource);
    const scope = { name: '@zharp/cloudflare', version: VERSION };
    this.spans = new Exporter<unknown>(
      this.endpoint,
      'traces',
      (records) => ({ resourceSpans: [{ resource: { attributes: resource }, scopeSpans: [{ scope, spans: records }] }] }),
      false,
    );
    this.logs = new Exporter<unknown>(
      this.endpoint,
      'logs',
      (records) => ({ resourceLogs: [{ resource: { attributes: resource }, scopeLogs: [{ scope, logRecords: records }] }] }),
      false,
    );

    setSpanSink({
      sampleRate: settings.sampleRate,
      export: (span) => {
        if (settings.tracing) this.spans.add(span.toOtlp(contextAttributes(span.request)));
      },
    });
    setRecordedExceptionHandler((exception, span) => this.report(exception, true, { 'zharp.mechanism': 'opentelemetry' }, span));
    registerOpenTelemetry();
    if (settings.tracing) instrumentGlobalFetch(this);
    if (settings.logs) {
      watchConsole(['debug', 'log', 'info', 'warn', 'error'], (level, message) => this.emit(level, message, { 'log.source': 'console' }));
    }
  }

  newRequest(): RequestState {
    return { runtime: this, tags: {}, user: null, queryFailures: [], pending: [] };
  }

  /**
   * Report an error once: what a handler threw, what the app caught and passed to
   * `captureError`, a failed query. A failed D1 query that reaches here is reported with its SQL
   * and the line of the app that ran it.
   */
  report(value: unknown, handled: boolean, attributes: Attributes = {}, span: ZharpSpan | undefined = activeSpan()): void {
    safely(() => {
      if (value && typeof value === 'object') {
        if (this.reported.has(value)) return;
        this.reported.add(value);
      }
      const query = claimQueryFailure(value);
      const exception = query ? query.exception(handled) : exceptionAttributes(asError(value), handled);
      this.emit(
        'error',
        `${exception['exception.type']}: ${exception['exception.message']}`,
        { ...(query?.attributes ?? {}), ...attributes },
        exception,
        span,
      );
    });
  }

  /** Whether `value` was reported already. */
  wasReported(value: unknown): boolean {
    return !!value && typeof value === 'object' && this.reported.has(value);
  }

  emit(level: Level, message: unknown, attributes?: Attributes, exception?: Record<string, string>, span: ZharpSpan | undefined = activeSpan()): void {
    safely(() => {
      const time = toNanos(now());
      const state = span?.request ?? requestOf();
      const attrs: Record<string, unknown> = { ...contextAttributes(state) };
      for (const key in attributes) {
        const value = attributes[key];
        // An Error passed with an error log is the reason for it: sent as the exception, with its stack.
        if (value instanceof Error && !exception && (level === 'error' || level === 'fatal')) {
          exception = exceptionAttributes(value, true);
          this.reported.add(value);
        } else attrs[key] = value;
      }
      this.logs.add({
        timeUnixNano: time,
        observedTimeUnixNano: time,
        severityNumber: SEVERITY[level],
        severityText: level.toUpperCase(),
        body: { stringValue: typeof message === 'string' ? message : message instanceof Error ? message.message : safeString(message) },
        attributes: keyValues({ ...attrs, ...exception }),
        traceId: span?.traceId,
        spanId: span?.spanId,
      });
    });
  }

  /**
   * The end of a request: once its `waitUntil` work has settled, report the failed queries
   * nothing claimed (as handled: the app caught them), then send everything queued.
   */
  async finish(state: RequestState): Promise<void> {
    try {
      // waitUntil work may hand more work to waitUntil.
      for (let seen = 0; seen < state.pending.length; ) {
        const batch = state.pending.slice(seen);
        seen = state.pending.length;
        await Promise.allSettled(batch);
      }
      for (const failure of unclaimedQueryFailures(state)) this.report(failure.error, true, {}, failure.span);
    } catch {
      // Never let telemetry fail the request's own work.
    }
    await this.flush();
  }

  async flush(): Promise<void> {
    await Promise.all([this.spans.flush(), this.logs.flush()]).catch(() => {});
  }
}

/** Tags and user, as they are on everything sent for a request. */
export function contextAttributes(state: RequestState | undefined): Record<string, unknown> {
  const user = state?.user ?? globalUser;
  return {
    ...globalTags,
    ...state?.tags,
    'enduser.id': user ? String(user.id) : undefined,
    'enduser.email': user?.email,
    'enduser.name': user?.name,
  };
}

export function setTag(key: string, value: string | number | boolean | null | undefined): void {
  const target = requestOf()?.tags ?? globalTags;
  if (value === null || value === undefined) delete target[key];
  else target[key] = value;
}

export function setUser(user: ZharpUser | null): void {
  const clean = user && user.id !== undefined && user.id !== null && user.id !== '' ? { id: user.id, email: user.email, name: user.name } : null;
  const state = requestOf();
  if (state) state.user = clean;
  else globalUser = clean;
}

// ── the isolate's runtime ───────────────────────────────────────────────

let runtime: Runtime | null = null;
let warnedNoKey = false;
let lastConfig: ZharpConfig | undefined;

/** The runtime, started from the first `env` with a key. Null when there is none: then nothing is sent. */
export function runtimeFor(env: unknown, config: ZharpConfig | undefined, defaults: { service: string; platform: string }): Runtime | null {
  if (runtime) return runtime;
  if (config !== undefined) lastConfig = config;
  const settings = safely(() => resolveSettings(env, config ?? lastConfig, defaults));
  if (!settings) {
    const disabled = /^(true|1|yes|on)$/i.test(String((env as Record<string, unknown> | undefined)?.ZHARP_DISABLED ?? ''));
    if (!warnedNoKey && !disabled) {
      warnedNoKey = true;
      console.warn('[Zharp] No key: set the ZHARP_KEY secret (wrangler secret put ZHARP_KEY) to the app key from the Zharp dashboard. Nothing will be sent.');
    }
    return null;
  }
  runtime = new Runtime(settings);
  return runtime;
}

/** The runtime, if one has started. */
export const currentRuntime = (): Runtime | null => runtime;

export { DEFAULT_ENDPOINT };
