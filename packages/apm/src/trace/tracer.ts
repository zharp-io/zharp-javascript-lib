import { Span } from './span';
import { activeContext, withContext } from './context';
import { newTraceId } from './ids';
import { SpanContext, SpanOptions, SpanRecord, TracingOptions } from './types';
import { TraceTransport } from './trace-transport';
import { normalizeEndpoint } from '@zharp/internal/delivery';
import { shared } from '@zharp/internal/shared';

/**
 * Starts spans, holds finished ones, and ships them in batches.
 *
 * The tracer is created by `ZharpAPM.init()`. Every method here is also safe on a tracer that
 * is not enabled: spans still start and end, they are simply never recorded. That is
 * deliberate — instrumentation should not have to ask whether it is switched on.
 */
export class Tracer {
  private readonly serviceName: string;
  private readonly resource: Record<string, any>;
  private readonly options: TracingOptions & { enabled: boolean; sampleRate: number };
  private readonly transport: TraceTransport;
  private readonly endpoint: string;

  private finished: SpanRecord[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly maxBatchSize: number;
  private readonly maxBuffered: number;

  constructor(config: {
    apiKey: string;
    endpoint?: string;
    serviceName: string;
    resource?: Record<string, any>;
    tracing?: TracingOptions;
    flushInterval?: number;
    maxBatchSize?: number;
  }) {
    this.serviceName = config.serviceName;
    this.resource = config.resource ?? {};
    this.options = {
      enabled: false,
      sampleRate: 1,
      ...config.tracing,
    };
    this.endpoint = normalizeEndpoint(config.endpoint);
    this.transport = new TraceTransport(config.apiKey, this.endpoint);
    this.maxBatchSize = config.maxBatchSize ?? 100;
    // Spans outnumber logs by an order of magnitude, so the buffer is larger — but still
    // bounded, because an app that cannot reach the network must not grow until it dies.
    this.maxBuffered = 1000;

    if (this.options.enabled) {
      this.flushTimer = setInterval(() => this.flush(), config.flushInterval ?? 5000);
      // Node keeps a process alive for any pending timer, which would stop a CLI or a job from
      // exiting. Telemetry should never be the reason a process will not end.
      const timer = this.flushTimer as any;
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  /** Finished spans waiting to be sent. */
  get buffered(): number {
    return this.finished.length;
  }

  /**
   * Start a span without making it active.
   *
   * Use this when the work is not a nested call — a background job, or a span that outlives the
   * function that opened it. For ordinary nested work use `startActiveSpan`, which is what makes
   * children attach to it automatically.
   *
   * @param name - The operation, e.g. `GET /orders` or `chargeCard`
   * @param options - Kind, attributes, and an explicit parent if not the active one
   */
  startSpan(name: string, options: SpanOptions = {}): Span {
    // `parent: null` explicitly means "start a new trace"; omitting it means "whatever is
    // active". Those are different intentions, so they stay distinguishable.
    const parent = options.parent === undefined ? activeContext() : options.parent;

    const traceId = parent?.traceId ?? newTraceId();
    // Tie the trace to the recording, so a session opens its requests and a request opens the
    // recording of the session that made it. A no-op when nothing is recording.
    shared().linkTrace?.(traceId);

    return new Span(name, {
      traceId,
      parentSpanId: parent?.spanId,
      // A child never re-rolls the dice: the sampling decision belongs to the trace, so a
      // recorded trace is whole and an unrecorded one costs nothing anywhere.
      sampled: parent ? parent.sampled : this.shouldSample(),
      kind: options.kind,
      attributes: options.attributes,
      onEnd: (span) => this.onSpanEnd(span),
    });
  }

  /**
   * Start a span, make it active for the duration of `fn`, and end it when `fn` settles.
   *
   * Handles the three things every call site otherwise repeats: ending on the happy path,
   * recording and re-throwing on the error path, and awaiting a returned promise rather than
   * closing the span the moment the function hands one back.
   *
   * @param name - The operation
   * @param options - Kind, attributes, explicit parent
   * @param fn - The work; receives the span so it can be annotated
   * @returns Whatever `fn` returns
   *
   * @example
   * await ZharpAPM.startActiveSpan('chargeCard', async (span) => {
   *   span.setAttribute('order.id', orderId);
   *   return gateway.charge(order);
   * });
   */
  startActiveSpan<T>(name: string, fn: (span: Span) => T): T;
  startActiveSpan<T>(name: string, options: SpanOptions, fn: (span: Span) => T): T;
  startActiveSpan<T>(
    name: string,
    optionsOrFn: SpanOptions | ((span: Span) => T),
    maybeFn?: (span: Span) => T,
  ): T {
    const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn;
    const fn = typeof optionsOrFn === 'function' ? optionsOrFn : (maybeFn as (span: Span) => T);

    const span = this.startSpan(name, options);

    return withContext(span.context, () => {
      let result: T;
      try {
        result = fn(span);
      } catch (error) {
        this.failSpan(span, error);
        throw error;
      }

      // A promise means the work is not finished when the function returns. Ending here would
      // time the call to the function rather than the work it started.
      if (isPromise(result)) {
        return result.then(
          (value: unknown) => {
            span.end();
            return value;
          },
          (error: unknown) => {
            this.failSpan(span, error);
            throw error;
          },
        ) as unknown as T;
      }

      span.end();
      return result;
    });
  }

  /** The span currently in scope, as a context that can be propagated. */
  activeSpanContext(): SpanContext | null {
    return activeContext();
  }

  /** Run `fn` with `context` active — used when adopting a trace from an incoming request. */
  withSpanContext<T>(context: SpanContext | null, fn: () => T): T {
    return withContext(context, fn);
  }

  /** Send everything buffered. Called on the interval, and on shutdown. */
  async flush(): Promise<void> {
    if (!this.finished.length) return;
    const batch = this.finished.splice(0, this.maxBatchSize);
    await this.transport.send(batch);
  }

  /** Best-effort send that survives page unload. */
  flushBeacon(): void {
    if (!this.finished.length) return;
    // All of it: there is no next flush after an unload. The transport cuts it to beacon size.
    const batch = this.finished.splice(0, this.finished.length);
    this.transport.sendBeacon(batch);
  }

  /** Stop the timer and send what is left. */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.finished.length) await this.flush();
  }

  /**
   * Whether a URL should be traced at all.
   * @param url - Absolute or relative request URL
   */
  shouldTrace(url: string): boolean {
    if (!this.options.enabled) return false;
    // Never trace the calls this SDK makes to report telemetry: each one would produce a span,
    // which would be reported, which would produce a span.
    if (url.indexOf('api.zharp.io') !== -1 || url.indexOf(this.endpoint) === 0) return false;
    return !matches(url, this.options.ignore);
  }

  /**
   * Whether an outgoing request to `url` should carry the trace headers.
   *
   * @param url - Absolute or relative request URL
   */
  shouldPropagate(url: string): boolean {
    const configured = this.options.propagateTo;
    if (configured && configured.length) return matches(url, configured);

    // No configuration: in the browser, same origin only. A `traceparent` on a cross-origin
    // request triggers a CORS preflight, and a third party that does not allow the header turns
    // a working request into a failing one. In Node there is no such penalty.
    if (typeof window === 'undefined') return true;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      try {
        return new URL(url, window.location.href).origin === window.location.origin;
      } catch {
        return false;
      }
    }
    // A relative URL is same-origin by definition.
    return true;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private shouldSample(): boolean {
    const rate = this.options.sampleRate;
    if (rate >= 1) return true;
    if (rate <= 0) return false;
    return Math.random() < rate;
  }

  private failSpan(span: Span, error: unknown): void {
    span.recordException(error);
    span.setStatus('ERROR', error instanceof Error ? error.message : String(error));
    span.end();
  }

  private onSpanEnd(span: Span): void {
    if (!this.options.enabled || !span.context.sampled) return;

    if (this.finished.length >= this.maxBuffered) {
      // Drop the oldest. Recent spans describe what is happening now, which is what someone
      // looking at a system that is currently broken actually needs.
      this.finished.shift();
    }
    this.finished.push(span.toRecord(this.serviceName, this.resource));
  }
}

function isPromise(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as any).then === 'function';
}

function matches(url: string, patterns?: Array<string | RegExp>): boolean {
  if (!patterns || !patterns.length) return false;
  return patterns.some((pattern) =>
    typeof pattern === 'string' ? url.indexOf(pattern) !== -1 : pattern.test(url),
  );
}
