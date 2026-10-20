import { Attributes, AttributeValue, SpanContext, SpanEvent, SpanKind, SpanRecord, SpanStatus } from './types';
import { newSpanId } from './ids';
import { codeContextFromStack } from './code-context';
import { breadcrumbs } from './breadcrumbs';

/**
 * One unit of work being timed.
 *
 * A span is mutable while it runs and frozen the moment `end()` is called. Ending twice is
 * ignored rather than treated as an error: a span is often ended by whichever of several paths
 * finishes first — a response handler, an error handler, a timeout — and making that a fault
 * would push defensive bookkeeping onto every call site to no benefit.
 */
export class Span {
  readonly context: SpanContext;
  readonly parentSpanId?: string;
  readonly kind: SpanKind;

  private name: string;
  private readonly startedAt: number;
  private endedAt: number | null = null;
  private status: SpanStatus = 'UNSET';
  private statusMessage?: string;
  private readonly attributes: Attributes = {};
  private readonly events: SpanEvent[] = [];
  private readonly onEnd: (span: Span) => void;

  constructor(
    name: string,
    options: {
      traceId: string;
      parentSpanId?: string;
      sampled: boolean;
      kind?: SpanKind;
      attributes?: Attributes;
      onEnd: (span: Span) => void;
    },
  ) {
    this.name = name;
    this.context = { traceId: options.traceId, spanId: newSpanId(), sampled: options.sampled };
    this.parentSpanId = options.parentSpanId;
    this.kind = options.kind ?? 'INTERNAL';
    this.startedAt = Date.now();
    this.onEnd = options.onEnd;

    if (options.attributes) Object.assign(this.attributes, options.attributes);
  }

  /** Whether this span will be reported. Unsampled spans still run, so instrumentation is uniform. */
  get isRecording(): boolean {
    return this.context.sampled && this.endedAt === null;
  }

  /**
   * Attach a key/value to the span.
   * @param key - Attribute name; prefer the OpenTelemetry conventions (`http.method`, `db.system`)
   * @param value - String, number, boolean, or an array of those
   */
  setAttribute(key: string, value: AttributeValue): this {
    if (this.endedAt === null && value !== undefined && value !== null) {
      this.attributes[key] = value;
    }
    return this;
  }

  /** Attach several attributes at once. */
  setAttributes(attributes: Attributes): this {
    Object.keys(attributes).forEach((key) => this.setAttribute(key, attributes[key]));
    return this;
  }

  /**
   * Rename the span after the fact.
   *
   * Useful where the useful name is only known late — a route is matched after the request span
   * has already started, so the span opens as the raw path and becomes `GET /orders/:id`.
   */
  setName(name: string): this {
    if (this.endedAt === null) this.name = name;
    return this;
  }

  /**
   * Mark the span as failed or succeeded.
   * @param status - OK or ERROR; UNSET is the default and means nobody said
   * @param message - What went wrong, shown as the failure on the trace
   */
  setStatus(status: SpanStatus, message?: string): this {
    if (this.endedAt === null) {
      this.status = status;
      if (message) this.statusMessage = message;
    }
    return this;
  }

  /**
   * Add a timestamped moment to the span.
   * @param name - Event name
   * @param attributes - Optional detail
   */
  addEvent(name: string, attributes?: Attributes): this {
    if (this.endedAt === null) {
      this.events.push({ name, time: new Date().toISOString(), attributes });
    }
    return this;
  }

  /**
   * Record an exception on the span.
   *
   * The stack goes on the event rather than into the status message, because the status is what
   * groups failures together on the errors list — a stack in it would make every occurrence
   * unique and the grouping useless.
   *
   * Note this records the error without marking the span failed. Some exceptions are caught and
   * handled, and those spans did not fail; call `setStatus('ERROR')` when it did.
   *
   * @param error - The thrown value, which is not always an Error
   */
  recordException(error: unknown): this {
    if (this.endedAt !== null) return this;

    const attributes: Attributes = {};
    if (error instanceof Error) {
      attributes['exception.type'] = error.name;
      attributes['exception.message'] = error.message;
      if (error.stack) attributes['exception.stacktrace'] = error.stack;

      // The source around each frame. Read now rather than at display time, because by then
      // the file may not be reachable — a different machine, a later deploy, a container that
      // has since been replaced.
      //
      // Serialised as JSON because a span attribute holds a scalar or an array of scalars,
      // and this is neither.
      const context = codeContextFromStack(error.stack);
      if (context.length) attributes['exception.code_context'] = JSON.stringify(context);
    } else {
      attributes['exception.type'] = typeof error;
      attributes['exception.message'] = String(error);
    }

    // What was happening before it broke. The trail has moved on by the time anyone reads
    // this, so it is taken at the moment of failure or not at all.
    const trail = breadcrumbs();
    if (trail.length) attributes['exception.breadcrumbs'] = JSON.stringify(trail);

    return this.addEvent('exception', attributes);
  }

  /**
   * Finish the span and hand it to the tracer.
   * @param endTime - Override the end time; defaults to now
   */
  end(endTime?: number): void {
    if (this.endedAt !== null) return;
    this.endedAt = endTime ?? Date.now();
    this.onEnd(this);
  }

  /** Whether `end()` has been called. */
  get isEnded(): boolean {
    return this.endedAt !== null;
  }

  /** The span as it goes on the wire. Only meaningful once ended. */
  toRecord(serviceName: string, resource?: Record<string, any>): SpanRecord {
    return {
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      kind: this.kind,
      serviceName,
      startTime: new Date(this.startedAt).toISOString(),
      endTime: new Date(this.endedAt ?? Date.now()).toISOString(),
      statusCode: this.status,
      statusMessage: this.statusMessage,
      attributes: Object.keys(this.attributes).length ? this.attributes : undefined,
      resource,
      events: this.events.length ? this.events : undefined,
    };
  }
}
