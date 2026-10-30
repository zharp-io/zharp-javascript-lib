/**
 * @zharp/browser: errors, logs, traces and session replay from a web page, sent to Zharp as
 * OTLP.
 *
 * `Zharp.init()` turns everything on. Each part is small and lives in its own module; this file
 * wires them together and is the public API. Nothing here throws into the page: every entry
 * point catches, and a failure to send is silent apart from one warning for a rejected key.
 */
import { parseUserAgent } from './environment';
import { asError, exceptionAttributes, watchConsole, watchErrors, type ConsoleMethod } from './instrument/errors';
import { absolute, instrumentFetch, instrumentXhr, matches, sameOrigin, type HttpHooks } from './instrument/http';
import { currentRoute, navigationTimings, watchActivity, watchClicks, watchHide, watchNavigation } from './instrument/page';
import { ReplayController } from './replay/controller';
import { Session } from './session';
import { Kind, Status, Tracer, type Span } from './tracing';
import { Exporter, type Endpoint } from './transport';
import type { Attributes, BrowserOptions, ZharpUser } from './types';
import { isBrowser, keyValues, now, safely, safeString, toNanos } from './util';
import { VERSION } from './version';

export const DEFAULT_ENDPOINT = 'https://api.zharp.io/api/v1/otlp';

const SEVERITY = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 } as const;
type Level = keyof typeof SEVERITY;
type LogFn = (message: unknown, attributes?: Attributes) => void;

/** A manual span, as `Zharp.startSpan` hands it to its callback. */
export interface ZharpSpan {
  readonly traceId: string;
  readonly spanId: string;
  setAttribute(key: string, value: unknown): ZharpSpan;
  setAttributes(attributes: Attributes): ZharpSpan;
}

interface Running {
  options: BrowserOptions;
  endpoint: Endpoint;
  session: Session;
  tracer: Tracer;
  /** False in logs-only mode: the tracer then never starts a span, so there is never an active one. */
  tracing: boolean;
  spans: Exporter<unknown>;
  logs: Exporter<unknown>;
  replay: ReplayController | null;
  teardowns: Array<() => void>;
}

export class ZharpBrowser {
  private running: Running | null = null;
  private user: ZharpUser | null = null;
  private readonly tags: Record<string, unknown> = {};
  /** Errors already reported, so one caught by the app and then rethrown is sent once. */
  private readonly reported = new WeakSet<object>();

  readonly log: Record<Level, LogFn> = {
    trace: (m, a) => this.emit('trace', m, a),
    debug: (m, a) => this.emit('debug', m, a),
    info: (m, a) => this.emit('info', m, a),
    warn: (m, a) => this.emit('warn', m, a),
    error: (m, a) => this.emit('error', m, a),
    fatal: (m, a) => this.emit('fatal', m, a),
  };

  get isActive(): boolean {
    return this.running !== null;
  }

  /** The current session's ID, e.g. to show on a support page. */
  get sessionId(): string | undefined {
    return this.running?.session.id;
  }

  init(options: BrowserOptions): void {
    try {
      if (this.running) {
        console.warn('[Zharp] Zharp.init() was called again — the first call\'s settings stay in effect.');
        return;
      }
      if (!options || !options.key) {
        console.warn('[Zharp] Zharp.init({ key }) needs the app key from the Zharp dashboard. Nothing will be sent.');
        return;
      }
      if (!isBrowser()) return;
      this.start(options);
    } catch {
      // A broken SDK must not take the page down with it.
    }
  }

  private start(options: BrowserOptions): void {
    const endpointUrl = (options.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
    const endpoint: Endpoint = { url: endpointUrl, key: options.key, fetch: (globalThis as any).fetch };
    const service = options.service || 'web';
    const session = new Session((options.sessionTimeoutMinutes ?? 30) * 60_000);
    // A user set before init(), or remembered by the session from earlier in this tab.
    if (this.user) session.update({ user: this.user });
    else this.user = session.current.user ?? null;

    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const platform = parseUserAgent(ua);
    const resource = keyValues({
      'service.name': service,
      'service.version': options.release,
      'deployment.environment.name': options.environment,
      'telemetry.sdk.name': 'zharp',
      'telemetry.sdk.language': 'webjs',
      'telemetry.sdk.version': VERSION,
      'browser.name': platform.browserName,
      'browser.version': platform.browserVersion,
      'os.name': platform.osName,
      'os.version': platform.osVersion,
      'user_agent.original': ua || undefined,
    });
    const scope = { name: '@zharp/browser', version: VERSION };

    const spans = new Exporter<unknown>(endpoint, 'traces', (records) => ({
      resourceSpans: [{ resource: { attributes: resource }, scopeSpans: [{ scope, spans: records }] }],
    }));
    const logs = new Exporter<unknown>(endpoint, 'logs', (records) => ({
      resourceLogs: [{ resource: { attributes: resource }, scopeLogs: [{ scope, logRecords: records }] }],
    }));

    const replayOptions = options.replay;
    const replay =
      replayOptions && ((replayOptions.sampleRate ?? 0) > 0 || (replayOptions.onErrorSampleRate ?? 0) > 0)
        ? new ReplayController(session, replayOptions, endpoint, service)
        : null;

    const tracer = new Tracer({
      export: (span) => {
        if (span.sampled) spans.add(span.toOtlp(this.contextAttributes()));
      },
      traceStarted: (traceId) => replay?.linkTrace(traceId),
    });
    tracer.sampleRate = typeof options.sampleRate === 'number' ? Math.min(1, Math.max(0, options.sampleRate)) : 1;

    const tracing = options.tracing !== false;
    const running: Running = { options, endpoint, session, tracer, tracing, spans, logs, replay, teardowns: [] };
    this.running = running;

    const ignore = options.ignoreUrls ?? [];
    const tracingOrigins = options.tracingOrigins ?? [];
    const httpHooks: HttpHooks = {
      tracer,
      shouldTrace: (url) => {
        const full = absolute(url);
        return !full.startsWith(endpointUrl) && !matches(full, ignore);
      },
      shouldPropagate: (url) => sameOrigin(url) || matches(url, tracingOrigins),
      baggage: () => this.baggage(),
    };

    const t = running.teardowns;
    // Logs only: fetch and XHR are left alone (no spans, no headers), and there are no page
    // load, navigation or click spans.
    if (tracing) t.push(instrumentFetch(httpHooks), instrumentXhr(httpHooks));
    t.push(watchErrors((error, mechanism) => this.report(error, false, { 'zharp.mechanism': mechanism })));
    t.push(watchActivity(() => session.touch()));
    t.push(
      watchNavigation((route) => {
        session.touch();
        if (tracing) tracer.startRoot('navigation', route, { 'url.full': location.href });
      }),
    );
    if (tracing && options.interactions !== false) t.push(watchClicks((label, selector) => tracer.noteClick(label, selector)));
    if (options.captureConsole) {
      const methods: ConsoleMethod[] = options.captureConsole === true ? ['debug', 'log', 'info', 'warn', 'error'] : options.captureConsole;
      t.push(watchConsole(methods, (level, message) => this.emit(level, message, { 'log.source': 'console' })));
    }
    t.push(
      watchHide(() => {
        tracer.endAll();
        spans.flushOnHide();
        logs.flushOnHide();
        replay?.flushOnHide();
      }),
    );

    // Replay first, so it hears about the page load's trace while the recorder downloads.
    replay?.start();
    if (tracing) this.startPageLoad(tracer);
  }

  /** The page load span: from navigation start until the load event, its requests, and a quiet second. */
  private startPageLoad(tracer: Tracer): void {
    const timeOrigin = typeof performance !== 'undefined' && performance.timeOrigin ? performance.timeOrigin : now();
    const root = tracer.startRoot('pageload', currentRoute(), { 'url.full': location.href, 'document.referrer': document.referrer || undefined }, timeOrigin);
    const loaded = () => {
      root.span.setAttributes(navigationTimings());
      root.release();
    };
    if (document.readyState === 'complete') loaded();
    else {
      root.hold();
      window.addEventListener('load', () => setTimeout(loaded, 0), { once: true });
    }
  }

  /**
   * Who is using the page: `enduser.id` (and `enduser.email`, `enduser.name`) on everything sent
   * from now on, and in the `baggage` header so the back end's spans and logs carry it too.
   * Call it after login and on every page load while logged in.
   */
  setUser(user: ZharpUser | null): void {
    safely(() => {
      this.user = user && user.id !== undefined && user.id !== null && user.id !== '' ? { id: user.id, email: user.email, name: user.name } : null;
      this.running?.session.update({ user: this.user });
    });
  }

  /** Forget the user and start a new session — call it on logout. */
  clearUser(): void {
    safely(() => {
      this.user = null;
      this.running?.session.renew(null);
    });
  }

  /** An attribute on every span and log from now on. `null` removes it. */
  setTag(key: string, value: string | number | boolean | null | undefined): void {
    if (value === null || value === undefined) delete this.tags[key];
    else this.tags[key] = value;
  }

  /** Report an error you caught. Sent as handled, and grouped into an issue with its other occurrences. */
  captureError(error: unknown, attributes?: Attributes): void {
    this.report(error, true, attributes);
  }

  /**
   * Run `fn` in a span named `name`. Requests and logs from its synchronous part belong to it;
   * a promise it returns ends the span when it settles. Errors pass through unchanged.
   */
  startSpan<T>(name: string, fn: (span: ZharpSpan) => T, attributes?: Attributes): T {
    const running = this.running;
    let span: Span | undefined;
    if (running?.tracing) span = safely(() => running.tracer.startSpan(name, Kind.Internal));
    if (!running || !span) return fn(noopSpan);
    const s = span;
    if (attributes) s.setAttributes(attributes);
    const fail = (error: unknown) => safely(() => s.setStatus(Status.Error, asError(error).message).end());
    try {
      const result = running.tracer.withSpan(s, () => fn(s));
      if (result && typeof (result as any).then === 'function') {
        return (result as any).then(
          (value: unknown) => {
            s.end();
            return value;
          },
          (error: unknown) => {
            fail(error);
            throw error;
          },
        );
      }
      s.end();
      return result;
    } catch (error) {
      fail(error);
      throw error;
    }
  }

  /** Send everything waiting now. */
  async flush(): Promise<void> {
    const running = this.running;
    if (!running) return;
    await Promise.all([running.spans.flush(), running.logs.flush(), running.replay?.flush()]).catch(() => {});
  }

  /** Flush and stop: every patch is undone and nothing more is recorded. */
  async close(): Promise<void> {
    const running = this.running;
    if (!running) return;
    running.tracer.endAll();
    await this.flush();
    await running.replay?.stop().catch(() => {});
    for (const undo of running.teardowns) safely(undo);
    this.running = null;
  }

  // ── internals ─────────────────────────────────────────────────────────

  /** Session, user and tags: on every span and log, as they are when it is sent. */
  private contextAttributes(): Record<string, unknown> {
    const running = this.running;
    const user = this.user;
    return {
      ...this.tags,
      'session.id': running?.session.id,
      'enduser.id': user ? String(user.id) : undefined,
      'enduser.email': user?.email,
      'enduser.name': user?.name,
    };
  }

  /** The `baggage` header value: session and user, for the back end to copy onto its spans. */
  private baggage(): string {
    const parts: string[] = [];
    const session = this.running?.session.id;
    if (session) parts.push(`session.id=${encodeURIComponent(session)}`);
    if (this.user) parts.push(`enduser.id=${encodeURIComponent(String(this.user.id))}`);
    return parts.join(',');
  }

  private emit(level: Level, message: unknown, attributes?: Attributes, exception?: Record<string, string>): void {
    safely(() => {
      const running = this.running;
      if (!running) return;
      const span = running.tracer.activeSpan();
      const time = toNanos(now());
      const attrs: Record<string, unknown> = { ...this.contextAttributes(), 'url.full': location.href };
      for (const key in attributes) {
        const value = attributes[key];
        // An Error passed with an error log is the reason for it: sent as the exception, with its stack.
        if (value instanceof Error && !exception && (level === 'error' || level === 'fatal')) {
          exception = exceptionAttributes(value, true);
          this.reported.add(value);
        } else attrs[key] = value;
      }
      running.logs.add({
        timeUnixNano: time,
        observedTimeUnixNano: time,
        severityNumber: SEVERITY[level],
        severityText: level.toUpperCase(),
        body: { stringValue: typeof message === 'string' ? message : message instanceof Error ? message.message : safeString(message) },
        attributes: keyValues({ ...attrs, ...exception }),
        traceId: span?.traceId,
        spanId: span?.spanId,
      });
      if (exception) running.replay?.onError();
    });
  }

  private report(value: unknown, handled: boolean, attributes?: Attributes): void {
    safely(() => {
      if (value && typeof value === 'object') {
        if (this.reported.has(value)) return;
        this.reported.add(value);
      }
      const error = asError(value);
      const exception = exceptionAttributes(error, handled);
      this.emit('error', `${exception['exception.type']}: ${exception['exception.message']}`, attributes, exception);
    });
  }
}

const noopSpan: ZharpSpan = {
  traceId: '',
  spanId: '',
  setAttribute() {
    return noopSpan;
  },
  setAttributes() {
    return noopSpan;
  },
};
