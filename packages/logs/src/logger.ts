import { ZharpConfig, LogEntry, LogLevel, AutoCaptureOptions } from './types';
import { LogQueue } from './queue';
import { Transport } from './transport';
import { setupAutoCapture } from './auto-capture';
import { consoleMethodsOf, setupConsoleCapture } from './console-capture';
import { getRuntimeContext, refreshContext } from './context';
import { getSessionId } from '@zharp/internal/session';
import { normalizeEndpoint } from '@zharp/internal/delivery';
import { toMessage } from '@zharp/internal/message';
import { announce, describeTarget, disabledByEnv, pick, readEnv, warn } from '@zharp/internal/env';
import { ActiveSpan, PublishedConfig, shared } from '@zharp/internal/shared';

const LEVELS = new Set(['debug', 'info', 'warn', 'error', 'fatal']);

// Internal config type: required fields resolved to concrete values; the tags stay optional
// because "not configured" is a real answer — it is sent as no tag rather than a guessed one.
type ResolvedConfig = Required<Pick<ZharpConfig, 'apiKey' | 'service' | 'flushInterval' | 'maxBatchSize' | 'endpoint'>> & {
  environment?: string;
  appVersion?: string;
  source?: string;
  autoCapture: Required<AutoCaptureOptions>;
};

export class ZharpLoggerClass {
  private config: ResolvedConfig | null = null;
  private queue: LogQueue | null = null;
  private transport: Transport | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** Sends under way, so a crashing process can wait for them before it exits. */
  private sending = new Set<Promise<void>>();
  private teardownAutoCapture: (() => void) | null = null;
  private teardownConsoleCapture: (() => void) | null = null;
  /** What this instance put on the shared handle, so teardown removes its own entry and no other. */
  private published: PublishedConfig | null = null;
  private initialized = false;

  /**
   * Start the Zharp logger. Call once at app startup; importing the package starts nothing.
   *
   * With no arguments, Node reads everything from the environment — `ZHARP_API_KEY`,
   * `ZHARP_SERVICE` (then `OTEL_SERVICE_NAME`), `ZHARP_ENV` (then `NODE_ENV`), `ZHARP_VERSION`,
   * `ZHARP_SOURCE` and `ZHARP_ENDPOINT`. Anything passed here overrides the environment. A
   * browser has no environment, so there `apiKey` and `service` must be passed.
   *
   * Uncaught errors and unhandled promise rejections are captured from this point on, with no
   * further code. On success one line is printed —
   * `[Zharp] Logging active — service "checkout-api", environment "production"`. With no API key
   * nothing starts, and a hint saying where to put one is printed instead. `ZHARP_DISABLED=true`
   * turns `init()` into a no-op.
   *
   * Calling `init()` again replaces the running setup: the old one is torn down (its queued
   * logs still sent, with its own key) and the new configuration takes over.
   *
   * All logs produced before `init()` is called are silently dropped.
   *
   * @param config - SDK configuration. Optional in Node, where the environment can supply all
   *   of it.
   *
   * @example
   * // Node: everything from ZHARP_* environment variables
   * ZharpLogger.init();
   *
   * // Browser
   * ZharpLogger.init({
   *   apiKey: 'your-api-key',
   *   service: 'my-frontend',
   *   environment: 'production',
   *   appVersion: '1.4.2',
   * });
   */
  init(config: ZharpConfig = {}): void {
    // A second init() replaces the first. The old setup is unhooked now; what it still had
    // queued goes out in the background, with the key it was queued under.
    if (this.initialized) void this.stop();

    if (disabledByEnv()) {
      announce('Logging disabled by ZHARP_DISABLED — nothing will be sent');
      return;
    }

    if ((config as any).tracing) {
      // Tracing lived here in unreleased builds. Saying so beats silently ignoring it.
      warn('`tracing` is not a @zharp/logs option. Tracing is in @zharp/apm: ZharpAPM.init().');
    }

    // Explicit config wins, then the environment variables a deployment already sets. No
    // fallback invents a value: an unset environment is sent as no tag at all.
    const env = readEnv();
    const apiKey = pick(config.apiKey, env.apiKey);
    if (!apiKey) {
      warn('No API key found — set ZHARP_API_KEY or call ZharpLogger.init({ apiKey })');
      return;
    }

    let service = pick(config.service, env.service);
    if (!service) {
      // Warn rather than throw: a missing name should not be the reason an application fails
      // to start, and the logs are still worth having under a placeholder.
      warn("No service name — pass `service` to init() or set ZHARP_SERVICE. Using 'unknown-service'.");
      service = 'unknown-service';
    }

    this.config = {
      apiKey,
      service,
      flushInterval: config.flushInterval || 5000,
      maxBatchSize: config.maxBatchSize || 50,
      environment: pick(config.environment, env.environment),
      appVersion: pick(config.appVersion, env.version),
      source: pick(config.source, env.source),
      endpoint: normalizeEndpoint(pick(config.endpoint, env.endpoint)),
      autoCapture: {
        errors: true,
        unhandledRejections: true,
        consoleErrors: false,
        ...config.autoCapture,
      },
    };

    this.queue = new LogQueue(500);
    this.transport = new Transport(this.config.apiKey, this.config.endpoint);

    // Console capture, when asked for. It covers console.error too when that is in the list, so
    // the older `consoleErrors` switch is not applied on top of it — every call is sent once.
    const consoleMethods = consoleMethodsOf(config.captureConsole ?? env.captureConsole);
    const autoCapture = consoleMethods.includes('error')
      ? { ...this.config.autoCapture, consoleErrors: false }
      : this.config.autoCapture;

    // Wire up auto-capture. The handler just calls this.push() like a normal log.
    this.teardownAutoCapture = setupAutoCapture(
      (message, metadata) => this.push('error', this.config!.service, message, metadata),
      autoCapture,
      () => this.flushAll(),
    );
    this.teardownConsoleCapture = setupConsoleCapture(consoleMethods, (level, message, metadata) =>
      this.push(level, this.config!.service, message, metadata),
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

    // Published on the shared handle so @zharp/apm, started after this with no options, reports
    // as the same service to the same place. See internal/src/shared.ts.
    this.published = {
      apiKey: this.config.apiKey,
      service: this.config.service,
      endpoint: this.config.endpoint,
      environment: this.config.environment,
      version: this.config.appVersion,
      source: this.config.source,
    };
    shared().logs = this.published;

    this.initialized = true;
    const capturing = consoleMethods.length === 0 ? '' : consoleMethods.length === 5 ? ', capturing the console' : `, capturing console.${consoleMethods.join('/')}`;
    announce(`Logging active — ${describeTarget(this.config.service, this.config.environment)}${capturing}`);
  }

  /** Whether `init()` succeeded and logs are being sent. */
  get isActive(): boolean {
    return this.initialized;
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
    if (!this.queue || !this.transport || !this.config) return;
    const batch = this.queue.drain(this.config.maxBatchSize);
    if (batch.length === 0) return;

    const sent = this.transport.send(batch);
    this.sending.add(sent);
    try {
      await sent;
    } finally {
      this.sending.delete(sent);
    }
  }

  /**
   * Send every queued log, batch by batch, and wait for sends already under way — an error log
   * starts one of its own — which is what a crashing process gets before it exits.
   */
  private async flushAll(): Promise<void> {
    while (this.queue && this.queue.size > 0) await this.flush();
    await Promise.allSettled([...this.sending]);
  }

  /**
   * Flush all pending logs and tear down the SDK instance.
   *
   * Clears the flush interval, removes all event listeners and error handlers, and resets
   * internal state. Useful before hot-module replacement in development, when unmounting a
   * long-lived application, or at the end of a test. To switch configuration you do not need
   * it: calling `init()` again replaces the running setup.
   *
   * @example
   * await ZharpLogger.destroy();
   */
  async destroy(): Promise<void> {
    await this.stop();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Unhook everything synchronously, then send what was queued.
   *
   * The two halves are split so `init()` can replace a running setup without waiting: by the
   * time it returns, the old listeners and timer are gone, and only the old queue's delivery is
   * still in progress — with the old key and endpoint, which is where those logs belong.
   */
  private stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.teardownAutoCapture) {
      this.teardownAutoCapture();
      this.teardownAutoCapture = null;
    }
    if (this.teardownConsoleCapture) {
      this.teardownConsoleCapture();
      this.teardownConsoleCapture = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('visibilitychange', this.handleVisibilityChange);
      window.removeEventListener('beforeunload', this.handleBeforeUnload);
    }
    if (typeof process !== 'undefined' && typeof process.off === 'function') {
      process.off('beforeExit', this.handleBeforeExit);
    }
    const handle = shared();
    if (this.published && handle.logs === this.published) delete handle.logs;
    this.published = null;

    const queue = this.queue;
    const transport = this.transport;
    const batchSize = this.config?.maxBatchSize ?? 50;
    this.config = null;
    this.queue = null;
    this.transport = null;
    this.initialized = false;

    // Teardown promises everything that was queued, not one batch of it.
    return (async () => {
      while (queue && transport && queue.size > 0) await transport.send(queue.drain(batchSize));
    })();
  }

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

    const context = getRuntimeContext(appVersion);

    // Stamp the log with the trace it happened inside. This is what turns "an error was logged"
    // into "here is the request that produced it and everything else it did". The span comes
    // from @zharp/apm through the shared handle; while it is not running there is none.
    const handle = shared();
    let span: ActiveSpan | null = null;
    try {
      span = handle.activeSpan ? handle.activeSpan() : null;
    } catch {
      span = null;
    }

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

    // Warnings and errors join @zharp/apm's breadcrumb trail, when it is running; ordinary
    // chatter does not. A trail of twenty debug lines pushes out the click that actually
    // explains the failure.
    if (level === 'warn' || level === 'error' || level === 'fatal') {
      handle.addBreadcrumb?.({ kind: 'log', message, level: level === 'warn' ? 'warn' : 'error' });
    }

    // Flag the session recording, so "sessions where something broke" finds this one. Guarded
    // because replay is optional and may never have been started.
    if (level === 'error' || level === 'fatal') {
      handle.markError?.();
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
  };
}
