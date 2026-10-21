import { Tracer } from './trace/tracer';
import { Span } from './trace/span';
import { instrumentFetch } from './trace/instrument-fetch';
import { instrumentNodeHttp } from './trace/instrument-node-http';
import { fromTraceparent, toTraceparent } from './trace/context';
import { SpanContext, SpanOptions } from './trace/types';
import { addBreadcrumb, breadcrumbs, clearBreadcrumbs, watchBrowserActivity } from './trace/breadcrumbs';
import type { Breadcrumb } from './trace/breadcrumbs';
import type { ReplayRecorder } from './replay/recorder';
import { ReplayOptions, ZharpAPMConfig } from './types';
import { normalizeEndpoint } from '@zharp/internal/delivery';
import { announce, describeTarget, disabledByEnv, packageName, pick, readEnv, warn } from '@zharp/internal/env';
import { PublishedConfig, shared } from '@zharp/internal/shared';

const isBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined';

/**
 * Tracing and session replay.
 *
 * Nothing starts on import. `init()` patches `fetch`/XHR in the browser and `http`/`https` in
 * Node, and from then on every request is a span; replay starts too when it is configured. When
 * @zharp/logs is running in the same process or page, its logs carry the active trace, and the
 * two share one session id.
 */
export class ZharpAPMClass {
  private tracer: Tracer | null = null;
  /**
   * A tracer that records nothing, used before `init()` and after `destroy()`. Spans still start
   * and end, so instrumented code runs the same either way — forgetting to initialise the SDK
   * should never be the reason an application stops.
   */
  private readonly inert = new Tracer({ apiKey: '', serviceName: '', tracing: { enabled: false } });
  private teardownInstrumentation: (() => void) | null = null;
  private published: PublishedConfig | null = null;
  private initialized = false;

  /** The recorder, once its chunk has loaded. Kept across `init()` calls; see `startReplay`. */
  private replay: ReplayRecorder | null = null;
  /** The replay start in progress, so two calls do not load and start twice. */
  private replayStarting: Promise<boolean> | null = null;
  /** This page's sampling decision. Made once and never revisited. */
  private replaySampled: boolean | null = null;

  /**
   * Start tracing — and session replay, if `replay` is set. Call once at startup; importing the
   * package starts nothing. In Node, `node --require @zharp/apm/init` (or `--import`) does this
   * before the application loads, which is the surest way to have `http` patched before any
   * library holds on to it.
   *
   * Configuration comes from, in order: the options passed here, the settings @zharp/logs was
   * started with (when it was started first), and in Node the environment — `ZHARP_API_KEY`,
   * `ZHARP_SERVICE` (then `OTEL_SERVICE_NAME`), `ZHARP_ENV` (then `NODE_ENV`), `ZHARP_VERSION`,
   * `ZHARP_SOURCE`, `ZHARP_ENDPOINT`.
   *
   * On success one line is printed —
   * `[Zharp] APM active — service "checkout-api", environment "production"`. With no API key
   * nothing starts, and a hint is printed instead. `ZHARP_DISABLED=true` turns `init()` into a
   * no-op. Calling `init()` again replaces the running setup.
   *
   * @param config - Optional in Node and wherever @zharp/logs was started first
   *
   * @example
   * ZharpAPM.init({
   *   apiKey: 'your-api-key',
   *   service: 'checkout-web',
   *   environment: 'production',
   *   replay: { sampleRate: 0.1 },
   * });
   */
  init(config: ZharpAPMConfig = {}): void {
    // A second init() replaces the first: unpatch now, send what the old tracer still holds in
    // the background, with the key it was recorded under.
    if (this.initialized) void this.stop();

    if (disabledByEnv()) {
      announce('APM disabled by ZHARP_DISABLED — nothing will be sent');
      void this.stopReplay();
      return;
    }

    const env = readEnv();
    const logs = shared().logs;

    const apiKey = pick(config.apiKey, logs?.apiKey, env.apiKey);
    if (!apiKey) {
      warn('No API key found — set ZHARP_API_KEY or call ZharpAPM.init({ apiKey })');
      void this.stopReplay();
      return;
    }

    let service = pick(config.service, logs?.service, env.service, packageName());
    if (!service) {
      warn("No service name — pass `service` to init(), set ZHARP_SERVICE, or give your package.json a name. Using 'unknown-service'.");
      service = 'unknown-service';
    }
    const environment = pick(config.environment, logs?.environment, env.environment);
    const version = pick(config.version, config.appVersion, logs?.version, env.version);
    const source = pick(config.source, logs?.source, env.source);
    const endpoint = normalizeEndpoint(pick(config.endpoint, logs?.endpoint, env.endpoint));

    this.tracer = new Tracer({
      apiKey,
      endpoint,
      serviceName: service,
      // Undefined values vanish in JSON, so an unset tag is simply absent.
      resource: {
        'service.name': service,
        // The current semantic-convention name, and the pre-1.27 one older readers expect.
        'deployment.environment.name': environment,
        'deployment.environment': environment,
        'service.version': version,
        ...(source ? { 'zharp.source': source } : {}),
      },
      tracing: {
        enabled: true,
        // Only when given: an explicit `undefined` would replace the tracer's default of 1.
        ...(config.sampleRate !== undefined ? { sampleRate: config.sampleRate } : {}),
        propagateTo: config.propagateTo,
        ignore: config.ignore,
      },
      flushInterval: config.flushInterval,
    });

    const teardowns: Array<() => void> = [];
    if (config.fetch !== false) teardowns.push(instrumentFetch(this.tracer));
    if (config.http !== false) teardowns.push(instrumentNodeHttp(this.tracer));
    // The trail of clicks and navigations that gives an error its context.
    if (config.breadcrumbs !== false) teardowns.push(watchBrowserActivity(true));
    this.teardownInstrumentation = () => teardowns.forEach((undo) => undo());

    // Spans flush on the tracer's own timer, which never keeps Node alive; what is still
    // buffered when the work runs out goes on `beforeExit`, and a page sends it on the way out.
    if (!isBrowser() && typeof process !== 'undefined' && typeof process.on === 'function') {
      process.on('beforeExit', this.handleBeforeExit);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('visibilitychange', this.handleVisibilityChange);
      window.addEventListener('beforeunload', this.handleBeforeUnload);
    }

    // What @zharp/logs reads: the active span for each log, and the trail its warnings and
    // errors join. See internal/src/shared.ts.
    const tracer = this.tracer;
    const handle = shared();
    handle.activeSpan = () => {
      const context = tracer.activeSpanContext();
      return context ? { traceId: context.traceId, spanId: context.spanId } : null;
    };
    handle.addBreadcrumb = (crumb) => addBreadcrumb(crumb);
    this.published = { apiKey, service, endpoint, environment, version, source };
    handle.apm = this.published;

    this.initialized = true;

    // Replay: browser only, and only when asked for. A running recording carries on (pointed at
    // the new settings) rather than restarting, so its sequence numbers keep going up.
    const replay = config.replay === true ? {} : config.replay || null;
    let replayNote = '';
    if (replay && isBrowser()) {
      const rate = clampRate(replay.sampleRate);
      replayNote = `, session replay at ${formatRate(rate)} of sessions`;
      this.startReplay(replay).catch(() => {});
    } else if (!replay) {
      void this.stopReplay();
    }

    announce(`APM active — ${describeTarget(service, environment)}${replayNote}`);
  }

  /** Whether `init()` succeeded and spans are being sent. */
  get isActive(): boolean {
    return this.initialized;
  }

  // ── tracing ───────────────────────────────────────────────────────────────

  /**
   * Time a piece of work and record it as a span.
   *
   * The span is active for the duration of `fn`, so anything traced inside it — an outgoing
   * HTTP call, a nested `startActiveSpan`, a log from @zharp/logs — attaches to it
   * automatically. It is ended when `fn` settles, including when `fn` returns a promise, and a
   * thrown error is recorded on the span before it is re-thrown.
   *
   * Safe to call before `init()`: the work still runs, nothing is recorded.
   *
   * @param name - The operation, e.g. `chargeCard` or `GET /orders`
   * @param options - Optional span kind, attributes, or explicit parent
   * @param fn - The work; receives the span so it can be annotated
   * @returns Whatever `fn` returns
   *
   * @example
   * const order = await ZharpAPM.startActiveSpan('createOrder', async (span) => {
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
    return this.active().startActiveSpan(name, options, fn);
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
  startSpan(name: string, options?: SpanOptions): Span {
    return this.active().startSpan(name, options);
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
   *   ZharpAPM.continueTrace(job.data.headers?.traceparent, () => handle(job), 'sendEmail'));
   */
  continueTrace<T>(traceparent: string | null | undefined, fn: () => T, name?: string): T {
    const tracer = this.active();
    const context: SpanContext | null = fromTraceparent(traceparent);
    if (name) {
      // `parent: null` when there is no usable header: the job starts its own trace rather than
      // attaching to whatever happened to be active when it was picked up.
      return tracer.startActiveSpan(name, { kind: 'CONSUMER', parent: context }, () => fn());
    }
    return tracer.withSpanContext(context, fn);
  }

  /**
   * Headers that continue the current trace across a boundary the SDK does not patch — a
   * WebSocket message, a queue job, a `fetch` in a worker.
   *
   * @returns A `traceparent` header, or an empty object when nothing is active
   *
   * @example
   * await queue.add('sendEmail', { ...job, headers: ZharpAPM.traceHeaders() });
   */
  traceHeaders(): Record<string, string> {
    const context = this.active().activeSpanContext();
    return context ? { traceparent: toTraceparent(context) } : {};
  }

  /**
   * The trace currently in scope, if any.
   *
   * Useful for putting a trace ID on an error page or an API response, so a support ticket can
   * be turned into the exact trace that produced it.
   */
  currentTraceId(): string | null {
    return this.active().activeSpanContext()?.traceId ?? null;
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
   * ZharpAPM.addBreadcrumb('Applied discount code', { code: 'SUMMER' });
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

  // ── session replay ────────────────────────────────────────────────────────

  /**
   * Start recording the page. The same as passing `replay` to `init()`, for when the decision
   * is made later — after consent, or once a user signs in.
   *
   * The sampling decision is made here, once per page load, before anything is downloaded: a
   * session that is sampled out never loads the recorder. A session that is sampled in loads
   * it — rrweb included — as a separate chunk, then starts recording.
   *
   * Browser only; elsewhere it does nothing and resolves to `false`.
   *
   * @param options - Sample rate and privacy settings
   * @returns Whether this session is being recorded
   *
   * @example
   * if (user.consentedToRecording) await ZharpAPM.startReplay({ sampleRate: 0.25 });
   */
  startReplay(options: ReplayOptions = {}): Promise<boolean> {
    if (this.replayStarting) return this.replayStarting;
    this.replayStarting = this.loadAndStartReplay(options).finally(() => {
      this.replayStarting = null;
    });
    return this.replayStarting;
  }

  /** Stop recording and send what is left. */
  async stopReplay(): Promise<void> {
    if (this.replayStarting) await this.replayStarting.catch(() => false);
    if (this.replay) await this.replay.stop();
  }

  /** Whether this session is being recorded. */
  get isReplaying(): boolean {
    return !!this.replay && this.replay.isRecording;
  }

  /**
   * Flag this session's recording as one where something went wrong.
   *
   * Done for you on an uncaught error, and whenever @zharp/logs records an error. Worth calling
   * by hand for a failure the SDK cannot see — a validation error the user hit, a state the
   * application knows is wrong. A no-op when nothing is recording.
   */
  markError(): void {
    this.replay?.markError();
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Send every finished span — and, when replay is on, everything recorded — now.
   *
   * Spans are sent every few seconds anyway; this is for a controlled shutdown, or a test
   * asserting on what was sent.
   */
  async flush(): Promise<void> {
    const work: Array<Promise<void>> = [];
    if (this.tracer) work.push(this.tracer.flush());
    if (this.replay?.isRecording) work.push(this.replay.flush());
    await Promise.all(work);
  }

  /**
   * Stop everything: unpatch `fetch`, XHR and `http`, stop the recording, and send what is left.
   *
   * @example
   * await ZharpAPM.destroy();
   */
  async destroy(): Promise<void> {
    await Promise.all([this.stop(), this.stopReplay()]);
    clearBreadcrumbs();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private active(): Tracer {
    return this.tracer ?? this.inert;
  }

  /**
   * Unhook synchronously, then send what the tracer still holds.
   *
   * Replay is left alone: `init()` decides whether a running recording carries on, and
   * `destroy()` stops it separately.
   */
  private stop(): Promise<void> {
    // Unpatch before the final flush: leaving `fetch` wrapped after teardown would keep
    // producing spans that nothing will ever send.
    if (this.teardownInstrumentation) {
      this.teardownInstrumentation();
      this.teardownInstrumentation = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('visibilitychange', this.handleVisibilityChange);
      window.removeEventListener('beforeunload', this.handleBeforeUnload);
    }
    if (typeof process !== 'undefined' && typeof process.off === 'function') {
      process.off('beforeExit', this.handleBeforeExit);
    }

    const handle = shared();
    if (this.published && handle.apm === this.published) {
      delete handle.apm;
      // Without APM there is no active span to attach a log to, and no trail to add to.
      delete handle.activeSpan;
      delete handle.addBreadcrumb;
    }
    this.published = null;
    this.initialized = false;

    const tracer = this.tracer;
    this.tracer = null;
    return tracer ? tracer.shutdown() : Promise.resolve();
  }

  private async loadAndStartReplay(options: ReplayOptions): Promise<boolean> {
    if (!isBrowser()) return false;
    if (!this.initialized || !this.published) {
      warn('Session replay needs ZharpAPM.init() first.');
      return false;
    }

    const target = {
      apiKey: this.published.apiKey,
      service: this.published.service,
      endpoint: this.published.endpoint,
    };
    if (this.replay?.isRecording) {
      this.replay.configure(target);
      return true;
    }

    // Sampled out: nothing is loaded and nothing is recorded. The cost of replay is the
    // recorder itself, so a decision made after loading it would save nothing.
    if (this.replaySampled === null) {
      const rate = clampRate(options.sampleRate);
      this.replaySampled = rate >= 1 || (rate > 0 && Math.random() < rate);
    }
    if (!this.replaySampled) return false;

    // The one place the recorder is referenced at runtime. A dynamic import is what lets a
    // bundler split it — and rrweb with it — into a chunk that only replay users download.
    const { ReplayRecorder } = await import('./replay/recorder');

    // destroy() or an init() without replay may have happened while the chunk was loading.
    if (!this.initialized || !this.published) return false;

    if (!this.replay) this.replay = new ReplayRecorder();
    this.replay.start(
      { apiKey: this.published.apiKey, service: this.published.service, endpoint: this.published.endpoint },
      options,
    );
    return this.replay.isRecording;
  }

  /**
   * Node is about to exit with spans still buffered. Sending them puts work back on the event
   * loop, so `beforeExit` fires again once they are out — and with nothing left this does
   * nothing, which lets the process end.
   */
  private handleBeforeExit = (): void => {
    if (this.tracer && this.tracer.buffered > 0) void this.tracer.flush();
  };

  private handleVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') this.tracer?.flushBeacon();
  };

  private handleBeforeUnload = (): void => {
    // Spans from the last page view would otherwise be lost — which is exactly the navigation
    // someone is looking at when they ask why the page was slow.
    this.tracer?.flushBeacon();
  };
}

function clampRate(rate: number | undefined): number {
  if (typeof rate !== 'number' || isNaN(rate)) return 1;
  return Math.min(1, Math.max(0, rate));
}

/** 0.1 → "10%", 0.005 → "0.5%". */
function formatRate(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}
