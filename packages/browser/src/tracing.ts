/**
 * Spans in the page.
 *
 * Browsers have no async context to carry "the current span" across awaits, so the page's
 * structure stands in for it. At any moment the parent for new work is, in order:
 *
 * 1. a span opened with `Zharp.startSpan()`, while its callback runs synchronously;
 * 2. the open interaction — a click that led to requests, `click “Pay now”`;
 * 3. the open page load or navigation.
 *
 * Page loads, navigations and interactions are each the root of a trace of their own, and stay
 * open until their requests are done and nothing new has started for a moment (or a hard limit
 * passes). A request with none of these open is a trace on its own.
 */
import { keyValues, newSpanId, newTraceId, now, toNanos } from './util';

export const enum Kind {
  Internal = 1,
  Client = 3,
}

export const enum Status {
  Unset = 0,
  Ok = 1,
  Error = 2,
}

export class Span {
  readonly spanId = newSpanId();
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly sampled: boolean;
  readonly attributes: Record<string, unknown> = {};
  private status: { code: Status; message?: string } = { code: Status.Unset };
  private endTime = 0;

  constructor(
    private readonly tracer: Tracer,
    public name: string,
    readonly kind: Kind,
    parent: Span | null,
    readonly startTime = now(),
  ) {
    this.traceId = parent ? parent.traceId : newTraceId();
    this.parentSpanId = parent?.spanId;
    this.sampled = parent ? parent.sampled : Math.random() < tracer.sampleRate;
  }

  get ended(): boolean {
    return this.endTime !== 0;
  }

  setAttribute(key: string, value: unknown): this {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Record<string, unknown>): this {
    Object.assign(this.attributes, attributes);
    return this;
  }

  setStatus(code: Status, message?: string): this {
    this.status = { code, message };
    return this;
  }

  /** W3C `traceparent` for a request made inside this span. */
  get traceparent(): string {
    return `00-${this.traceId}-${this.spanId}-${this.sampled ? '01' : '00'}`;
  }

  end(time = now()): void {
    if (this.endTime) return;
    this.endTime = Math.max(time, this.startTime);
    this.tracer.finished(this);
  }

  /** As an OTLP/JSON span, with the context attributes as they are now. */
  toOtlp(context: Record<string, unknown>): Record<string, unknown> {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      kind: this.kind,
      startTimeUnixNano: toNanos(this.startTime),
      endTimeUnixNano: toNanos(this.endTime),
      attributes: keyValues({ ...context, ...this.attributes }),
      status: this.status.message ? this.status : { code: this.status.code },
    };
  }
}

/**
 * A root span that ends itself once its work is done: when nothing it is waiting for is in
 * flight and `idleMs` has passed with nothing new, or at `maxMs` regardless.
 */
export class IdleSpan {
  private inflight = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxTimer: ReturnType<typeof setTimeout>;
  /** A page load is not finished before the load event, however quiet the network is. */
  private held = false;

  constructor(
    readonly span: Span,
    private readonly idleMs: number,
    maxMs: number,
    private readonly onEnd: (idle: IdleSpan) => void,
  ) {
    this.maxTimer = setTimeout(() => this.finish(), Math.max(0, span.startTime + maxMs - now()));
    this.arm();
  }

  begin(): void {
    this.inflight++;
    this.disarm();
  }

  done(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    this.arm();
  }

  /** Do not end on idle until `release()`; the hard limit still applies. */
  hold(): void {
    this.held = true;
    this.disarm();
  }

  release(): void {
    this.held = false;
    this.arm();
  }

  finish(): void {
    if (this.span.ended) return;
    this.disarm();
    clearTimeout(this.maxTimer);
    this.span.end();
    this.onEnd(this);
  }

  private arm(): void {
    this.disarm();
    if (this.inflight === 0 && !this.held) this.idleTimer = setTimeout(() => this.finish(), this.idleMs);
  }

  private disarm(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

export interface TracerHooks {
  /** A span ended; export it if sampled. */
  export(span: Span): void;
  /** A new trace began; the replay of this session should know about it. */
  traceStarted(traceId: string): void;
}

/** Root spans wait this long after their last request before ending. */
const ROOT_IDLE_MS = 1_000;
const INTERACTION_IDLE_MS = 500;
const MAX_ROOT_MS = 30_000;
/** A request this long after a click is no longer counted as the click's doing. */
const CLICK_WINDOW_MS = 1_000;

export class Tracer {
  sampleRate = 1;
  root: IdleSpan | null = null;
  interaction: IdleSpan | null = null;
  private click: { label: string; target: string; time: number } | null = null;
  private readonly stack: Span[] = [];

  constructor(private readonly hooks: TracerHooks) {}

  finished(span: Span): void {
    this.hooks.export(span);
  }

  /** The span new work belongs to, if any is open. */
  activeSpan(): Span | null {
    if (this.stack.length) return this.stack[this.stack.length - 1];
    if (this.interaction && !this.interaction.span.ended) return this.interaction.span;
    if (this.root && !this.root.span.ended) return this.root.span;
    return null;
  }

  startSpan(name: string, kind = Kind.Internal, parent: Span | null = this.activeSpan(), startTime?: number): Span {
    const span = new Span(this, name, kind, parent, startTime);
    if (!parent) this.hooks.traceStarted(span.traceId);
    return span;
  }

  /** Run `fn` with `span` as the active span for its synchronous part. */
  withSpan<T>(span: Span, fn: () => T): T {
    this.stack.push(span);
    try {
      return fn();
    } finally {
      const index = this.stack.lastIndexOf(span);
      if (index >= 0) this.stack.splice(index, 1);
    }
  }

  /** A page load or navigation: ends whatever root and interaction were open, and starts the new root. */
  startRoot(type: 'pageload' | 'navigation', path: string, attributes: Record<string, unknown>, startTime?: number): IdleSpan {
    this.interaction?.finish();
    this.root?.finish();
    const span = this.startSpan(`${type} ${path}`, Kind.Internal, null, startTime);
    span.setAttributes({ 'zharp.span.type': type, ...attributes });
    this.root = new IdleSpan(span, ROOT_IDLE_MS, MAX_ROOT_MS, (idle) => {
      if (this.root === idle) this.root = null;
    });
    return this.root;
  }

  /** A click happened; it becomes an interaction span only if it leads to a request. */
  noteClick(label: string, target: string): void {
    this.click = { label, target, time: now() };
  }

  /**
   * A request is starting. Returns the span it belongs under and the idle spans to tell when it
   * is done — after opening the interaction span if a click just led to it.
   */
  requestStarting(): { parent: Span | null; waiters: IdleSpan[] } {
    const click = this.click;
    if (click && now() - click.time < CLICK_WINDOW_MS && !this.stack.length) {
      this.click = null;
      this.interaction?.finish();
      const span = this.startSpan(`click “${click.label}”`, Kind.Internal, null, click.time);
      span.setAttributes({ 'zharp.span.type': 'interaction', 'zharp.interaction.target': click.target });
      this.interaction = new IdleSpan(span, INTERACTION_IDLE_MS, MAX_ROOT_MS, (idle) => {
        if (this.interaction === idle) this.interaction = null;
      });
    }
    const waiters = [this.interaction, this.root].filter((s): s is IdleSpan => !!s && !s.span.ended);
    return { parent: this.activeSpan(), waiters };
  }

  /** The page is going away: end everything that is open, so it can still be sent. */
  endAll(): void {
    this.interaction?.finish();
    this.root?.finish();
  }
}
