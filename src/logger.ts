import { ZharpConfig, LogEntry, LogLevel, AutoCaptureOptions } from './types';
import { LogQueue } from './queue';
import { Transport } from './transport';
import { getSessionId } from './session';
import { setupAutoCapture } from './auto-capture';
import { getRuntimeContext, refreshContext } from './context';
import { Tracer } from './trace/tracer';
import { Span } from './trace/span';
import { instrumentFetch } from './trace/instrument-fetch';
import { instrumentNodeHttp } from './trace/instrument-node-http';
import { fromTraceparent, toTraceparent } from './trace/context';
import { SpanContext, SpanOptions } from './trace/types';
import { addBreadcrumb, breadcrumbs, clearBreadcrumbs, watchBrowserActivity } from './trace/breadcrumbs';
import type { Breadcrumb } from './trace/breadcrumbs';
import { normalizeEndpoint } from './delivery';
import { toMessage } from './message';

const LEVELS = new Set(['debug', 'info', 'warn', 'error', 'fatal']);

// Internal config type: required fields resolved to concrete values; the tags stay optional
// because "not configured" is a real answer — it is sent as no tag rather than a guessed one.
type ResolvedConfig = Required<Pick<ZharpConfig, 'apiKey' | 'service' | 'flushInterval' | 'maxBatchSize' | 'endpoint'>> & {
  environment?: string;
  appVersion?: string;
  source?: string;
  autoCapture: Required<AutoCaptureOptions>;
  tracing?: ZharpConfig['tracing'];
};

/**
 * An environment variable, in Node only.
 *
 * Browser bundles often carry a `process` shim whose `env` was baked in at build time — reading
 * it there would tag a page with the build machine's NODE_ENV — so a browser reads nothing.
 */
function nodeEnv(name: string): string | undefined {
  if (typeof window !== 'undefined' || typeof process === 'undefined' || !process.env) return undefined;
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}


export class ZharpLoggerClass {
  private config: ResolvedConfig | null = null;
  private queue: LogQueue | null = null;
  private transport: Transport | null = null;
  private tracer: Tracer | null = null;
  private teardownTracing: (() => void) | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private teardownAutoCapture: (() => void) | null = null;
  private initialized = false;

  /**
   * Initialise the Zharp logger. Call once at app startup before any other method.
   *
   * All logs produced before `init()` is called are silently dropped.
   * Calling `init()` a second time without first calling `destroy()` is a no-op
   * and will log a warning to the console.
   *
   * @param config - SDK configuration. `apiKey` is required; `service` is too, unless the
   *   ZHARP_SERVICE or OTEL_SERVICE_NAME environment variable supplies it in Node.
   *
   * @example
   * ZharpLogger.init({
   *   apiKey: 'your-api-key',
   *   service: 'my-frontend',
   *   environment: 'production',
   *   appVersion: '1.4.2',
   * });
   */
  init(config: ZharpConfig): void {
    if (this.initialized) {
      console.warn('[Zharp] Already initialized. Call ZharpLogger.destroy() first to reinitialize.');
      return;
    }

    // Explicit config wins, then the environment variables a deployment already sets. No
    // fallback invents a value: an unset environment is sent as no tag at all.
    let service = config.service || nodeEnv('ZHARP_SERVICE') || nodeEnv('OTEL_SERVICE_NAME');
    if (!service) {
      // Warn rather than throw: a missing name should not be the reason an application fails
      // to start, and the logs are still worth having under a placeholder.
      console.warn(
        "[Zharp] No service name — pass `service` to init() or set ZHARP_SERVICE. Using 'unknown-service'.",
      );
      service = 'unknown-service';
    }

    this.config = {
      flushInterval: 5000,
      maxBatchSize: 50,
      ...config,
      service,
      environment: config.environment || nodeEnv('ZHARP_ENV') || nodeEnv('NODE_ENV'),
      appVersion: config.appVersion || nodeEnv('ZHARP_VERSION'),
      endpoint: normalizeEndpoint(config.endpoint),
      autoCapture: {
        errors: true,
        unhandledRejections: true,
        consoleErrors: false,
        ...config.autoCapture,
      },
    };

    this.queue = new LogQueue(500);
    this.transport = new Transport(this.config.apiKey, this.config.endpoint);

    // Tracing. The tracer is always constructed so the span API works whether or not it is
    // switched on — instrumentation calls should not need to be wrapped in a check — but it
    // records nothing and starts no timer unless `tracing.enabled` is set.
    this.tracer = new Tracer({
      apiKey: this.config.apiKey,
      endpoint: this.config.endpoint,
      serviceName: this.config.service,
      // Undefined values vanish in JSON, so an unset tag is simply absent.
      resource: {
        'service.name': this.config.service,
        // The current semantic-convention name, and the pre-1.27 one older readers expect.
        'deployment.environment.name': this.config.environment,
        'deployment.environment': this.config.environment,
        'service.version': this.config.appVersion,
        ...(this.config.source ? { 'zharp.source': this.config.source } : {}),
      },
      tracing: this.config.tracing,
      flushInterval: this.config.flushInterval,
    });

    if (this.tracer.enabled) {
      const teardowns: Array<() => void> = [];
      if (this.config.tracing?.fetch !== false) teardowns.push(instrumentFetch(this.tracer));
      if (this.config.tracing?.http !== false) teardowns.push(instrumentNodeHttp(this.tracer));
      // The trail of clicks and navigations that gives an error its context.
      if (this.config.tracing?.breadcrumbs !== false) teardowns.push(watchBrowserActivity(true));
      this.teardownTracing = () => teardowns.forEach((undo) => undo());
    }

    // Wire up auto-capture. The handler just calls this.push() like a normal log.
    this.teardownAutoCapture = setupAutoCapture(
      (message, metadata) => this.push('error', this.config!.service, message, metadata),
      this.config.autoCapture,
    );

    // Flush on a regular interval (default every 5 seconds). In Node the timer must not keep the
    // process alive — a script that never calls destroy() would never exit — so what is still
    // queued when the work runs out is sent on `beforeExit` instead.
    this.flushTimer = setInterval(() => this.flush(), this.config.flushInterval);
    (this.flushTimer as any)?.unref?.();
    if (typeof window === 'undefined' && typeof process !== 'undefined' && typeof process.on === 'function') {
      process.on('beforeExit', this.handleBeforeExit);
    }

    // Flush when the tab is hidden or the page is about to close.
    // Uses sendBeacon so the request is guaranteed to complete even on unload.
    if (typeof window !== 'undefined') {
      window.addEventListener('visibilitychange', this.handleVisibilityChange);
      window.addEventListener('beforeunload', this.handleBeforeUnload);
    }

    /*
     * A small shared handle, so the replay entry point can find the key, service and endpoint without
     * importing this file — which would pull the whole logging SDK into a bundle that only
     * wanted the recorder.
     *
     * `markError` and `linkTrace` are assigned by the recorder when it starts; until then they
     * are absent and every call site checks, so ordering between the two never matters.
     */
    const shared = ((globalThis as any).__ZHARP__ = (globalThis as any).__ZHARP__ ?? {});
    shared.apiKey = this.config.apiKey;
    shared.service = this.config.service;
    shared.endpoint = this.config.endpoint;

    this.initialized = true;
  }

  /**
   * Send a log entry at the specified level.
   *
   * Two call signatures are supported:
   *
   * **Default service** (uses the service name set in `init()`):
   * ```ts
   * ZharpLogger.log('error', 'Something went wrong', { userId: 123 });
   * ```
   *
   * **Explicit service** (overrides the default for this single log):
   * ```ts
   * ZharpLogger.log('payment-service', 'error', 'Charge failed', { amount: 500 });
   * ```
   *
   * @param level - Log level: `'debug' | 'info' | 'warn' | 'error' | 'fatal'`
   * @param message - Human-readable log message
   * @param metadata - Optional key/value pairs attached to the log entry
   */
  log(service: string, level: LogLevel, message: string, metadata?: Record<string, any>): void;
  log(level: LogLevel, message: string, metadata?: Record<string, any>): void;
  log(
    serviceOrLevel: string,
    levelOrMessage: string,
    messageOrMetadata?: string | Record<string, any>,
    metadata?: Record<string, any>,
  ): void {
    if (!this.initialized || !this.config) return;

    // Detect which overload was used based on whether the second arg is a level
    if (LEVELS.has(levelOrMessage)) {
      // log(service, level, message, metadata?)
      this.push(
        levelOrMessage as LogLevel,
        serviceOrLevel,
        messageOrMetadata as string,
        metadata,
      );
    } else {
      // log(level, message, metadata?)
      this.push(
        serviceOrLevel as LogLevel,
        this.config.service,
        levelOrMessage,
        messageOrMetadata as Record<string, any> | undefined,
      );
    }
  }

  /**
   * Log a debug-level message. Use for verbose diagnostic information
   * that is only useful during active development.
   *
   * @param message - Human-readable log message
   * @param metadata - Optional key/value pairs attached to the log entry
   *
   * @example
   * ZharpLogger.debug('Cache miss', { key: 'user:42' });
   */
  debug(message: string, metadata?: Record<string, any>): void {
    this.push('debug', this.config?.service ?? '', message, metadata);
  }

  /**
   * Log an info-level message. Use for normal operational events
   * that confirm the app is working as expected.
   *
   * @param message - Human-readable log message
   * @param metadata - Optional key/value pairs attached to the log entry
   *
   * @example
   * ZharpLogger.info('User signed in', { userId: 42 });
   */
  info(message: string, metadata?: Record<string, any>): void {
    this.push('info', this.config?.service ?? '', message, metadata);
  }

  /**
   * Log a warn-level message. Use for unexpected situations that the app
   * can recover from but that deserve attention.
   *
   * @param message - Human-readable log message
   * @param metadata - Optional key/value pairs attached to the log entry
   *
   * @example
   * ZharpLogger.warn('Rate limit approaching', { remaining: 5 });
   */
  warn(message: string, metadata?: Record<string, any>): void {
    this.push('warn', this.config?.service ?? '', message, metadata);
  }

  /**
   * Log an error-level message. The queue is flushed immediately so this
   * log is not lost if the app crashes shortly after.
   *
   * @param message - Human-readable log message
   * @param metadata - Optional key/value pairs attached to the log entry
   *
   * @example
   * ZharpLogger.error('Payment failed', { orderId: 99, reason: 'insufficient_funds' });
   */
  error(message: string, metadata?: Record<string, any>): void {
    this.push('error', this.config?.service ?? '', message, metadata);
  }

  /**
   * Log a fatal-level message indicating a critical failure. The queue is
   * flushed immediately so this log is not lost if the process exits.
   *
   * @param message - Human-readable log message
   * @param metadata - Optional key/value pairs attached to the log entry
   *
   * @example
   * ZharpLogger.fatal('Database connection lost');
   */
  fatal(message: string, metadata?: Record<string, any>): void {
    this.push('fatal', this.config?.service ?? '', message, metadata);
  }

  /**
   * Re-capture the current URL and route from the browser's location.
   *
   * In single-page apps the URL changes without a full page reload, so the
   * context captured at startup quickly becomes stale. Call `refreshContext()`
   * after each client-side navigation so that `context.url` and `context.route`
   * on subsequent logs reflect the current page.
   *
   * @example
   * // React Router
   * const location = useLocation();
   * useEffect(() => ZharpLogger.refreshContext(), [location.pathname]);
   *
   * // Vue Router
   * router.afterEach(() => ZharpLogger.refreshContext());
   */
  refreshContext(): void {
    refreshContext();
  }

  // ── tracing ───────────────────────────────────────────────────────────────

  /**
   * Time a piece of work and record it as a span.
   *
   * The span is active for the duration of `fn`, so anything traced inside it — an outgoing
   * HTTP call, a nested `startActiveSpan` — attaches to it automatically. It is ended when `fn`
   * settles, including when `fn` returns a promise, and a thrown error is recorded on the span
   * before it is re-thrown.
   *
   * Safe to call with tracing switched off: the work still runs, nothing is recorded.
   *
   * @param name - The operation, e.g. `chargeCard` or `GET /orders`
   * @param options - Optional span kind, attributes, or explicit parent
   * @param fn - The work; receives the span so it can be annotated
   * @returns Whatever `fn` returns
   *
   * @example
   * const order = await ZharpLogger.startActiveSpan('createOrder', async (span) => {
   *   span.setAttribute('cart.items', items.length);
   *   return db.orders.create(input);
   * });
   */
  startActiveSpan<T>(name: string, fn: (span: Span) => T): T;
  startActiveSpan<T>(name: string, options: SpanOptions, fn: (span: Span) => T): T;
  startActiveSpan<T>(
    name: string,
    optionsOrFn: SpanOptions | ((span: Span) => T),
    maybeFn?: (span: Span) => T,
  ): T {
    const fn = typeof optionsOrFn === 'function' ? optionsOrFn : (maybeFn as (span: Span) => T);
    const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn;

    // Before init() there is no tracer. Running the work unrecorded is the only sane answer:
    // the alternative is that forgetting to initialise the SDK stops the application.
    if (!this.tracer) return fn(null as unknown as Span);

    return this.tracer.startActiveSpan(name, options, fn);
  }

  /**
   * Start a span without making it active.
   *
   * For work that does not nest inside the current call — a background job, or a span that
   * outlives the function that opened it. You are responsible for calling `end()`.
   *
   * @param name - The operation
   * @param options - Optional span kind, attributes, or explicit parent
   */
  startSpan(name: string, options?: SpanOptions): Span | null {
    return this.tracer ? this.tracer.startSpan(name, options) : null;
  }

  /**
   * Add something to the trail shown alongside the next error.
   *
   * Clicks, navigations, requests and warnings are recorded for you. Use this for the things
   * only your application knows: a feature flag resolving, a cart being emptied, a retry.
   *
   * @param message - What happened, phrased as it should read
   * @param data - Optional detail
   *
   * @example
   * ZharpLogger.addBreadcrumb('Applied discount code', { code: 'SUMMER' });
   */
  addBreadcrumb(message: string, data?: Record<string, unknown>): void {
    addBreadcrumb({ kind: 'custom', message, data });
  }

  /**
   * The trail as it stands, oldest first.
   *
   * Mostly useful in tests, and when attaching the same context to a report of your own.
   */
  breadcrumbs(): Breadcrumb[] {
    return breadcrumbs();
  }

  /**
   * The trace currently in scope, if any.
   *
   * Useful for putting a trace ID on an error page or an API response, so a support ticket can
   * be turned into the exact trace that produced it.
   */
  currentTraceId(): string | null {
    return this.tracer?.activeSpanContext()?.traceId ?? null;
  }

  /**
   * Headers that continue the current trace across a boundary the SDK does not patch — a
   * WebSocket message, a queue job, a `fetch` in a worker.
   *
   * @returns A `traceparent` header, or an empty object when nothing is active
   *
   * @example
   * await queue.add('sendEmail', { ...job, headers: ZharpLogger.traceHeaders() });
   */
  traceHeaders(): Record<string, string> {
    const context = this.tracer?.activeSpanContext();
    return context ? { traceparent: toTraceparent(context) } : {};
  }

  /**
   * Continue a trace that started somewhere else.
   *
   * The counterpart to `traceHeaders()`: at the receiving end — a queue worker picking up a
   * job, a message handler — this makes the work part of the trace that caused it rather than
   * a new one that nothing connects to.
   *
   * Give it a `name` and the work runs inside a CONSUMER span of that name — the job then
   * shows up the way a request does, with its own duration and errors, instead of only as the
   * parent of whatever it happened to call. Without a name, the caller's context is simply made
   * active.
   *
   * @param traceparent - The `traceparent` header value from the caller
   * @param fn - The work to run inside that trace
   * @param name - Optional span name for the work itself, e.g. `sendEmail`
   *
   * @example
   * worker.process((job) =>
   *   ZharpLogger.continueTrace(job.data.headers?.traceparent, () => handle(job), 'sendEmail'));
   */
  continueTrace<T>(traceparent: string | null | undefined, fn: () => T, name?: string): T {
    if (!this.tracer) return fn();
    const context: SpanContext | null = fromTraceparent(traceparent);
    if (name) {
      // `parent: null` when there is no usable header: the job starts its own trace rather than
      // attaching to whatever happened to be active when it was picked up.
      return this.tracer.startActiveSpan(name, { kind: 'CONSUMER', parent: context }, () => fn());
    }
    return this.tracer.withSpanContext(context, fn);
  }

  /**
   * Drain the in-memory queue and send all pending logs to Zharp immediately.
   *
   * This is called automatically on the flush interval, on `error`/`fatal` logs,
   * and when the browser tab is hidden or about to close. You rarely need to call
   * it manually, but it is useful in tests or when you need guaranteed delivery
   * before a controlled shutdown.
   *
   * @example
   * await ZharpLogger.flush();
   */
  async flush(): Promise<void> {
    // Spans flush on their own timer, but a manual flush is usually asking for everything —
    // before a controlled shutdown, or in a test asserting on what was sent.
    const traces = this.tracer ? this.tracer.flush() : Promise.resolve();

    if (!this.queue || !this.transport || !this.config) return traces;
    const batch = this.queue.drain(this.config.maxBatchSize);
    if (batch.length === 0) return traces;

    await Promise.all([this.transport.send(batch), traces]);
  }

  /**
   * Flush all pending logs and tear down the SDK instance.
   *
   * Clears the flush interval, removes all event listeners, and resets internal
   * state so that `init()` can be called again. Useful before hot-module
   * replacement in development or when unmounting a long-lived application.
   *
   * @example
   * await ZharpLogger.destroy();
   *
   * // Re-initialise with new config
   * ZharpLogger.init({ apiKey: '...', service: '...' });
   */
  async destroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.teardownAutoCapture) {
      this.teardownAutoCapture();
      this.teardownAutoCapture = null;
    }
    // Unpatch before the final flush: leaving `fetch` wrapped after teardown would keep
    // producing spans that nothing will ever send.
    if (this.teardownTracing) {
      this.teardownTracing();
      this.teardownTracing = null;
    }
    if (this.tracer) {
      await this.tracer.shutdown();
      this.tracer = null;
    }
    clearBreadcrumbs();
    if (typeof window !== 'undefined') {
      window.removeEventListener('visibilitychange', this.handleVisibilityChange);
      window.removeEventListener('beforeunload', this.handleBeforeUnload);
    }
    if (typeof process !== 'undefined' && typeof process.off === 'function') {
      process.off('beforeExit', this.handleBeforeExit);
    }
    // One flush sends one batch of `maxBatchSize`; teardown promises everything that was queued.
    do {
      await this.flush();
    } while (this.queue && this.queue.size > 0);
    this.config = null;
    this.queue = null;
    this.transport = null;
    this.initialized = false;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private push(
    level: LogLevel,
    service: string,
    rawMessage: unknown,
    metadata?: Record<string, any>,
  ): void {
    if (!this.queue || !this.config) return;

    // Whatever the caller passed, the entry carries text: one non-string message used to get
    // the whole batch rejected.
    const message = toMessage(rawMessage);
    const { environment, appVersion, source } = this.config;

    const context = getRuntimeContext(this.config.appVersion);
    // Stamp the log with the trace it happened inside. This is what turns "an error was logged"
    // into "here is the request that produced it and everything else it did".
    const span = this.tracer?.activeSpanContext();

    const entry: LogEntry = {
      service,
      level,
      message,
      timestamp: new Date().toISOString(),
      // The tags the log viewer filters by. Top-level, where the backend reads them; absent
      // rather than empty when not configured.
      ...(environment ? { environment } : {}),
      ...(appVersion ? { version: appVersion } : {}),
      ...(source ? { source } : {}),
      metadata: {
        // Developer-supplied metadata sits at the top level.
        // Runtime context goes under a dedicated key so it never
        // collides with app-specific fields.
        ...metadata,
        sessionId: getSessionId(),
        // Also kept here for backends older than the top-level tags.
        ...(environment ? { environment } : {}),
        ...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
        context,
      },
    };

    // Warnings and errors join the trail; ordinary chatter does not. A trail of twenty debug
    // lines pushes out the click that actually explains the failure.
    if (level === 'warn' || level === 'error' || level === 'fatal') {
      addBreadcrumb({
        kind: 'log',
        message,
        level: level === 'warn' ? 'warn' : 'error',
      });
    }

    // Flag the recording, so "sessions where something broke" finds this one. Guarded because
    // the recorder is optional and may never have been started.
    if (level === 'error' || level === 'fatal') {
      (globalThis as any).__ZHARP__?.markError?.();
    }

    this.queue.push(entry);

    // Don't wait for the next interval tick on error or fatal —
    // flush immediately so critical logs aren't lost if the app crashes.
    if (level === 'error' || level === 'fatal') {
      this.flush().catch(() => {});
    }
  }

  private handleVisibilityChange = (): void => {
    // Page went to background (tab switch, phone lock screen, etc.).
    // Use sendBeacon so the flush completes even if the tab is killed.
    if (document.visibilityState === 'hidden') {
      // Everything queued, not one batch: this may be the last chance to send any of it. The
      // transport cuts it into beacon-sized pieces.
      const batch = this.queue?.drain(this.queue.size) ?? [];
      this.transport?.sendBeacon(batch);
      this.tracer?.flushBeacon();
    }
  };

  /**
   * Node is about to exit with logs still queued. Sending them puts work back on the event loop,
   * so `beforeExit` fires again once they're out — and with the queue empty this does nothing,
   * which lets the process end.
   */
  private handleBeforeExit = (): void => {
    if (this.queue && this.queue.size > 0) void this.flush();
  };

  private handleBeforeUnload = (): void => {
    const batch = this.queue?.drain(this.queue.size) ?? [];
    this.transport?.sendBeacon(batch);
    // Spans from the last page view would otherwise be lost — which is exactly the navigation
    // someone is looking at when they ask why the page was slow.
    this.tracer?.flushBeacon();
  };
}
