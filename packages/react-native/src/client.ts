/**
 * @zharp/react-native: errors, logs, traces and sessions from a React Native or Expo app, sent to
 * Zharp as OTLP — the JavaScript side. Built from @zharp/browser's internals (transport, tracer,
 * XHR instrumentation, body and header capture), with what a browser has replaced by what React
 * Native has: ErrorUtils instead of window.onerror, Hermes' rejection tracker instead of
 * unhandledrejection, AppState instead of page visibility, Platform instead of the user agent.
 *
 * Nothing here throws into the app: every entry point catches.
 */
import { AppState, Platform } from 'react-native';
import { bodySettings } from '@zharp/internal/bodies';
import { headerSettings } from '@zharp/internal/headers';
import { asError, exceptionAttributes, watchConsole, type ConsoleMethod } from '../../browser/src/instrument/errors';
import { instrumentXhr, matches, type HttpHooks } from '../../browser/src/instrument/http';
import { Session, type SessionStore } from '../../browser/src/session';
import { Kind, Status, Tracer, type Span } from '../../browser/src/tracing';
import { Exporter, post, retryable, type Endpoint } from '../../browser/src/transport';
import { keyValues, now, safely, safeString, toNanos } from '../../browser/src/util';
import type { Attributes, ZharpUser } from '../../browser/src/types';
import { watchGlobalErrors } from './errors';
import { nativeModule, type ZharpNativeModule } from './native';
import type { ReactNativeOptions } from './types';
import { VERSION } from './version';

export const DEFAULT_ENDPOINT = 'https://api.zharp.io/api/v1/otlp';

const SEVERITY = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 } as const;
type Level = keyof typeof SEVERITY;
type LogFn = (message: unknown, attributes?: Attributes) => void;

export interface ZharpSpan {
  readonly traceId: string;
  readonly spanId: string;
  setAttribute(key: string, value: unknown): ZharpSpan;
  setAttributes(attributes: Attributes): ZharpSpan;
}

interface Running {
  options: ReactNativeOptions;
  endpoint: Endpoint;
  /** The export envelope around log records: resource and scope. */
  wrapLogs: (records: unknown[]) => unknown;
  /** The native SDK underneath, when the app has the module (not in Expo Go). */
  native: ZharpNativeModule | null;
  session: Session;
  tracer: Tracer;
  tracing: boolean;
  spans: Exporter<unknown>;
  logs: Exporter<unknown>;
  teardowns: Array<() => void>;
}

/** The session in memory for the life of the JS runtime (phase 2 keeps it with the native SDKs). */
function memoryStore(): SessionStore {
  const values = new Map<string, string>();
  return { get: (key) => values.get(key) ?? null, set: (key, value) => void values.set(key, value) };
}

/** What Platform says about the device, as OpenTelemetry names it. */
function deviceAttributes(): Record<string, unknown> {
  const constants = ((Platform as any).constants ?? {}) as Record<string, unknown>;
  const ios = Platform.OS === 'ios';
  return {
    'os.name': ios ? 'iOS' : Platform.OS === 'android' ? 'Android' : String(Platform.OS),
    'os.version': ios ? String(Platform.Version) : (constants.Release as string | undefined) ?? String(Platform.Version),
    'device.model.name': (constants.Model as string | undefined) ?? undefined,
    'device.manufacturer': (constants.Manufacturer as string | undefined) ?? (ios ? 'Apple' : undefined),
    'react_native.version': constants.reactNativeVersion
      ? Object.values(constants.reactNativeVersion as Record<string, number | null>).filter((v) => v !== null).join('.')
      : undefined,
    'react_native.hermes': typeof (globalThis as any).HermesInternal === 'object' ? 'true' : 'false',
  };
}

export class ZharpReactNative {
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

  /** The current session's ID, e.g. to show on a support screen. */
  get sessionId(): string | undefined {
    return this.currentSession();
  }

  /** The native SDK's session when it runs (one session for JS errors and native crashes), else ours. */
  private currentSession(): string | undefined {
    const running = this.running;
    if (!running) return undefined;
    return (running.native ? safely(() => running.native!.sessionId()) : null) || running.session.id;
  }

  init(options: ReactNativeOptions): void {
    try {
      if (this.running) {
        console.warn('[Zharp] Zharp.init() was called again — the first call\'s settings stay in effect.');
        return;
      }
      if (!options || !options.key) {
        console.warn('[Zharp] Zharp.init({ key }) needs the app key from the Zharp dashboard. Nothing will be sent.');
        return;
      }
      if (options.enabled === false) return;
      this.start(options);
    } catch {
      // A broken SDK must not take the app down with it.
    }
  }

  private start(options: ReactNativeOptions): void {
    const endpointUrl = (options.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
    // React Native's fetch runs on XMLHttpRequest, which is instrumented: the SDK's own requests
    // are told apart by URL (shouldTrace), so they are never traced.
    const endpoint: Endpoint = { url: endpointUrl, key: options.key, fetch: (globalThis as any).fetch };
    const service = options.service || 'react-native-app';
    const session = new Session((options.sessionTimeoutMinutes ?? 30) * 60_000, memoryStore());
    if (this.user) session.update({ user: this.user });

    // The native SDK first: native crashes and ANRs from now on, and the one session both sides use.
    const native = nativeModule();
    if (native) {
      safely(() =>
        native.start({
          key: options.key,
          service,
          environment: options.environment ?? null,
          release: options.release ?? null,
          endpoint: options.endpoint ? endpointUrl : null,
          tracingOrigins: (options.tracingOrigins ?? []).filter((o): o is string => typeof o === 'string'),
          tracing: options.tracing !== false,
          captureHeaders: options.captureHeaders !== false,
          debug: !!options.debug,
        }),
      );
      if (this.user) safely(() => native.setUser(String(this.user!.id), this.user!.email ?? null, this.user!.name ?? null));
      for (const [k, v] of Object.entries(this.tags)) safely(() => native.setTag(k, String(v)));
    }

    const resource = keyValues({
      'service.name': service,
      'service.version': options.release,
      'deployment.environment.name': options.environment,
      'telemetry.sdk.name': 'zharp',
      // JavaScript, as OpenTelemetry names the browser's; the platform says which.
      'telemetry.sdk.language': 'webjs',
      'telemetry.sdk.version': VERSION,
      'zharp.sdk.platform': 'react-native',
      ...deviceAttributes(),
    });
    const scope = { name: '@zharp/react-native', version: VERSION };
    const spans = new Exporter<unknown>(endpoint, 'traces', (records) => ({
      resourceSpans: [{ resource: { attributes: resource }, scopeSpans: [{ scope, spans: records }] }],
    }));
    const wrapLogs = (records: unknown[]) => ({
      resourceLogs: [{ resource: { attributes: resource }, scopeLogs: [{ scope, logRecords: records }] }],
    });
    const logs = new Exporter<unknown>(endpoint, 'logs', wrapLogs);

    const tracer = new Tracer({
      export: (span) => {
        if (span.sampled) spans.add(span.toOtlp(this.contextAttributes()));
      },
      // Session replay is the web's; nothing to link a trace to here.
      traceStarted: () => {},
    });
    tracer.sampleRate = typeof options.sampleRate === 'number' ? Math.min(1, Math.max(0, options.sampleRate)) : 1;

    const tracing = options.tracing !== false;
    const running: Running = { options, endpoint, wrapLogs, native, session, tracer, tracing, spans, logs, teardowns: [] };
    this.running = running;
    // Fatal JS errors from earlier runs, saved as the app died: sent first.
    if (native) this.sendSavedFatal(running);

    const ignore = options.ignoreUrls ?? [];
    const tracingOrigins = options.tracingOrigins ?? [];
    const bodies = bodySettings(options.captureBodies);
    const httpHooks: HttpHooks = {
      tracer,
      shouldTrace: (url) => !url.startsWith(endpointUrl) && !matches(url, ignore),
      // No "same origin" in an app: only the hosts the app names get trace headers.
      shouldPropagate: (url) => matches(url, tracingOrigins),
      baggage: () => this.baggage(),
      bodies,
      headers: headerSettings(options.captureHeaders),
      shouldCaptureBodies: (url) => (bodies?.urls ? matches(url, bodies.urls) : matches(url, tracingOrigins) || !tracingOrigins.length),
    };

    const t = running.teardowns;
    // fetch is built on XMLHttpRequest in React Native: patching XHR covers both, once each.
    if (tracing) t.push(instrumentXhr(httpHooks));
    t.push(
      watchGlobalErrors((error, mechanism, fatal) => {
        const attributes = { 'zharp.mechanism': mechanism, ...(fatal ? { 'zharp.fatal': 'true' } : {}) };
        // A fatal error ends the app: with the native module it goes to disk now and is sent on
        // the next launch (sent once — not also from the queue, which may or may not get out).
        if (fatal && native) this.saveFatal(running, error, attributes);
        else this.report(error, false, attributes);
        if (fatal) this.flush();
      }),
    );
    if (options.captureConsole || options.logs) {
      const methods: ConsoleMethod[] = Array.isArray(options.captureConsole) ? options.captureConsole : ['debug', 'log', 'info', 'warn', 'error'];
      t.push(watchConsole(methods, (level, message) => this.emit(level, message, { 'log.source': 'console' })));
    }
    // Into the background: everything queued goes out while the app may still run; back in the
    // foreground: the session is still going (or a new one starts after the timeout).
    const subscription = safely(() =>
      AppState.addEventListener('change', (state: string) => {
        if (state === 'active') session.touch();
        else if (state === 'background') {
          tracer.endAll();
          this.flush();
        }
      }),
    );
    if (subscription) t.push(() => subscription.remove());
  }

  /**
   * Who is using the app: `enduser.id` (and `enduser.email`, `enduser.name`) on everything sent
   * from now on, and in the `baggage` header to your `tracingOrigins`. Call it after login.
   */
  setUser(user: ZharpUser | null): void {
    safely(() => {
      this.user = user && user.id !== undefined && user.id !== null && user.id !== '' ? { id: user.id, email: user.email, name: user.name } : null;
      this.running?.session.update({ user: this.user });
      const native = this.running?.native;
      if (native) {
        if (this.user) native.setUser(String(this.user.id), this.user.email ?? null, this.user.name ?? null);
        else native.clearUser();
      }
    });
  }

  /** Forget the user and start a new session — call it on logout. */
  clearUser(): void {
    safely(() => {
      this.user = null;
      this.running?.session.renew(null);
      this.running?.native?.clearUser();
    });
  }

  /** An attribute on every span and log from now on. `null` removes it. */
  setTag(key: string, value: string | number | boolean | null | undefined): void {
    if (value === null || value === undefined) delete this.tags[key];
    else this.tags[key] = value;
    safely(() => this.running?.native?.setTag(key, value === null || value === undefined ? null : String(value)));
  }

  /** Report an error you caught. Sent as handled, and grouped into an issue with its other occurrences. */
  captureError(error: unknown, attributes?: Attributes): void {
    this.report(error, true, attributes);
  }

  /**
   * React 19: the handler for the root's error options. Each error a render throws is reported
   * once, as a crash, with the component stack. React's own reporting carries on; `callback`
   * runs after it.
   */
  reactErrorHandler(callback?: (error: unknown, errorInfo: { componentStack?: string | null }) => void) {
    return (error: unknown, errorInfo?: { componentStack?: string | null }): void => {
      this.reportReactError(error, errorInfo?.componentStack);
      callback?.(error, errorInfo ?? {});
    };
  }

  /** @internal An error React caught, with the stack of components that were rendering. */
  reportReactError(error: unknown, componentStack?: string | null): void {
    const stack = typeof componentStack === 'string' ? componentStack.trim().slice(0, 4000) : '';
    this.report(error, false, { 'zharp.mechanism': 'react', ...(stack ? { 'react.component_stack': stack } : {}) });
  }

  /**
   * Run `fn` in a span named `name`. Requests and logs from its synchronous part belong to it; a
   * promise it returns ends the span when it settles. Errors pass through unchanged.
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
    await Promise.all([running.spans.flush(), running.logs.flush()]).catch(() => {});
  }

  /** Flush and stop: every patch is undone and nothing more is recorded. */
  async close(): Promise<void> {
    const running = this.running;
    if (!running) return;
    running.tracer.endAll();
    await this.flush();
    for (const undo of running.teardowns) safely(undo);
    this.running = null;
  }

  // ── internals ─────────────────────────────────────────────────────────

  private contextAttributes(): Record<string, unknown> {
    const running = this.running;
    const user = this.user;
    return {
      ...this.tags,
      'session.id': this.currentSession(),
      'enduser.id': user ? String(user.id) : undefined,
      'enduser.email': user?.email,
      'enduser.name': user?.name,
    };
  }

  private baggage(): string {
    const parts: string[] = [];
    const session = this.currentSession();
    if (session) parts.push(`session.id=${encodeURIComponent(session)}`);
    if (this.user) parts.push(`enduser.id=${encodeURIComponent(String(this.user.id))}`);
    return parts.join(',');
  }

  private emit(level: Level, message: unknown, attributes?: Attributes, exception?: Record<string, string>): void {
    safely(() => {
      const running = this.running;
      if (!running) return;
      running.logs.add(this.record(running, level, message, attributes, exception));
    });
  }

  /** One OTLP log record, with the session, user, tags and the active span. */
  private record(running: Running, level: Level, message: unknown, attributes?: Attributes, exception?: Record<string, string>): unknown {
    {
      running.session.touch();
      const span = running.tracer.activeSpan();
      const time = toNanos(now());
      const attrs: Record<string, unknown> = { ...this.contextAttributes() };
      for (const key in attributes) {
        const value = attributes[key];
        if (value instanceof Error && !exception && (level === 'error' || level === 'fatal')) {
          exception = exceptionAttributes(value, true);
          this.reported.add(value);
        } else attrs[key] = value;
      }
      return {
        timeUnixNano: time,
        observedTimeUnixNano: time,
        severityNumber: SEVERITY[level],
        severityText: level.toUpperCase(),
        body: { stringValue: typeof message === 'string' ? message : message instanceof Error ? message.message : safeString(message) },
        attributes: keyValues({ ...attrs, ...exception }),
        traceId: span?.traceId,
        spanId: span?.spanId,
      };
    }
  }

  /** A fatal JS error, written to disk by the native module before the app dies. */
  private saveFatal(running: Running, value: unknown, attributes: Attributes): void {
    safely(() => {
      if (value && typeof value === 'object') {
        if (this.reported.has(value)) return;
        this.reported.add(value);
      }
      const exception = exceptionAttributes(asError(value), false);
      const record = this.record(running, 'fatal', `${exception['exception.type']}: ${exception['exception.message']}`, attributes, exception);
      const body = JSON.stringify(running.wrapLogs([record]));
      // If it can't be written, it is sent the ordinary way and may or may not get out.
      if (!running.native!.saveFatal(body)) running.logs.add(record);
    });
  }

  /** Fatal JS errors saved by earlier runs: sent now; one that can't be sent yet is saved again. */
  private sendSavedFatal(running: Running): void {
    const saved = safely(() => running.native!.takeFatal()) ?? [];
    for (const body of saved) {
      post(running.endpoint, 'logs', body).then((status) => {
        if (retryable(status)) safely(() => running.native!.saveFatal(body));
      });
    }
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
