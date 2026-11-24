/**
 * Spans in a Worker, on OpenTelemetry's API.
 *
 * A Worker serves many requests at once in one isolate, so "the current span" is carried by
 * AsyncLocalStorage (from `nodejs_compat`) across every await of the request that started it.
 * The context manager, tracer and `traceparent` propagator here are registered with
 * `@opentelemetry/api`, so a library that makes its own OpenTelemetry spans joins the request's
 * trace — without OpenTelemetry's SDK packages, which are too large for a Worker.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  context as otelContext,
  createContextKey,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Attributes as OtelAttributes,
  type Context,
  type ContextManager,
  type Exception,
  type Link,
  type Span as OtelSpan,
  type SpanContext,
  type SpanOptions,
  type SpanStatus,
  type TextMapPropagator,
  type TimeInput,
  type Tracer as OtelTracer,
  type TracerProvider,
} from '@opentelemetry/api';
import { keyValues, newSpanId, newTraceId, now, toNanos } from '../../browser/src/util';
import type { RequestState } from './state';

export { SpanKind, SpanStatusCode };

// ── context ─────────────────────────────────────────────────────────────

class AlsContextManager implements ContextManager {
  private readonly als = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.als.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(ctx: Context, fn: F, thisArg?: ThisParameterType<F>, ...args: A): ReturnType<F> {
    return this.als.run(ctx, () => fn.apply(thisArg, args));
  }

  bind<T>(ctx: Context, target: T): T {
    if (typeof target !== 'function') return target;
    const manager = this;
    return function (this: unknown, ...args: unknown[]) {
      return manager.with(ctx, () => (target as Function).apply(this, args));
    } as T;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    return this;
  }
}

export const contextManager = new AlsContextManager();

/** The request a context belongs to: its tags, user and what is still to be reported. */
const REQUEST = createContextKey('zharp.cloudflare.request');

export const activeContext = (): Context => contextManager.active();
export const requestOf = (ctx: Context = activeContext()): RequestState | undefined => ctx.getValue(REQUEST) as RequestState | undefined;
export const withRequest = (ctx: Context, state: RequestState): Context => ctx.setValue(REQUEST, state);
export const activeSpan = (): ZharpSpan | undefined => {
  const span = trace.getSpan(activeContext());
  return span instanceof ZharpSpan ? span : undefined;
};

// ── spans ───────────────────────────────────────────────────────────────

/** Where finished spans go. */
export interface SpanSink {
  sampleRate: number;
  export(span: ZharpSpan): void;
}

let sink: SpanSink | null = null;
export const setSpanSink = (value: SpanSink) => {
  sink = value;
};

/** OpenTelemetry's span kinds as OTLP numbers them (one more than the API's enum). */
const otlpKind = (kind: SpanKind) => kind + 1;

const MAX_EVENTS = 64;

export class ZharpSpan implements OtelSpan {
  readonly traceId: string;
  readonly spanId = newSpanId();
  readonly parentSpanId?: string;
  readonly sampled: boolean;
  readonly attributes: Record<string, unknown> = {};
  readonly startTime: number;
  /** The request this span was started in, for its tags and user when it is sent. */
  readonly request: RequestState | undefined;
  private readonly events: Array<{ name: string; time: number; attributes?: OtelAttributes }> = [];
  private readonly links: Link[] = [];
  private status: SpanStatus = { code: SpanStatusCode.UNSET };
  private endTime = 0;

  constructor(
    public name: string,
    readonly kind: SpanKind,
    parent: SpanContext | undefined,
    request: RequestState | undefined,
    attributes?: OtelAttributes,
    startTime?: TimeInput,
    links?: Link[],
  ) {
    const valid = parent && trace.isSpanContextValid(parent);
    this.traceId = valid ? parent!.traceId : newTraceId();
    this.parentSpanId = valid ? parent!.spanId : undefined;
    this.sampled = valid ? (parent!.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED : Math.random() < (sink?.sampleRate ?? 1);
    this.startTime = startTime !== undefined ? timeOf(startTime) : now();
    this.request = request;
    if (attributes) Object.assign(this.attributes, attributes);
    if (links) this.links.push(...links);
  }

  get ended(): boolean {
    return this.endTime !== 0;
  }

  spanContext(): SpanContext {
    return { traceId: this.traceId, spanId: this.spanId, traceFlags: this.sampled ? TraceFlags.SAMPLED : TraceFlags.NONE };
  }

  setAttribute(key: string, value: unknown): this {
    if (!this.endTime && value !== undefined) this.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Record<string, unknown>): this {
    for (const key in attributes) this.setAttribute(key, attributes[key]);
    return this;
  }

  addEvent(name: string, attributesOrTime?: OtelAttributes | TimeInput, time?: TimeInput): this {
    if (this.endTime || this.events.length >= MAX_EVENTS) return this;
    // Exceptions are reported as errors of their own (one per error); an event would count it twice.
    if (name === 'exception') return this;
    const isTime = typeof attributesOrTime === 'number' || attributesOrTime instanceof Date || Array.isArray(attributesOrTime);
    this.events.push({
      name,
      time: timeOf(isTime ? (attributesOrTime as TimeInput) : time ?? now()),
      attributes: isTime ? undefined : (attributesOrTime as OtelAttributes | undefined),
    });
    return this;
  }

  addLink(link: Link): this {
    this.links.push(link);
    return this;
  }

  addLinks(links: Link[]): this {
    this.links.push(...links);
    return this;
  }

  setStatus(status: SpanStatus): this {
    if (!this.endTime) this.status = status;
    return this;
  }

  updateName(name: string): this {
    if (!this.endTime) this.name = name;
    return this;
  }

  isRecording(): boolean {
    return !this.endTime;
  }

  /**
   * Another library recorded an exception on its span. It becomes an error of its own, once —
   * the same way the wrapper reports what a handler threw.
   */
  recordException(exception: Exception): void {
    onRecordedException?.(exception, this);
  }

  end(endTime?: TimeInput): void {
    if (this.endTime) return;
    this.endTime = Math.max(endTime !== undefined ? timeOf(endTime) : now(), this.startTime);
    if (this.sampled) sink?.export(this);
  }

  /** As an OTLP/JSON span. `context` is the request's tags and user. */
  toOtlp(context: Record<string, unknown>): Record<string, unknown> {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      kind: otlpKind(this.kind),
      startTimeUnixNano: toNanos(this.startTime),
      endTimeUnixNano: toNanos(this.endTime),
      attributes: keyValues({ ...context, ...this.attributes }),
      events: this.events.length
        ? this.events.map((event) => ({ name: event.name, timeUnixNano: toNanos(event.time), attributes: keyValues(event.attributes ?? {}) }))
        : undefined,
      links: this.links.length
        ? this.links.map((link) => ({ traceId: link.context.traceId, spanId: link.context.spanId, attributes: keyValues(link.attributes ?? {}) }))
        : undefined,
      status: this.status.message ? { code: this.status.code, message: this.status.message } : { code: this.status.code },
    };
  }
}

let onRecordedException: ((exception: Exception, span: ZharpSpan) => void) | null = null;
export const setRecordedExceptionHandler = (handler: (exception: Exception, span: ZharpSpan) => void) => {
  onRecordedException = handler;
};

function timeOf(input: TimeInput): number {
  if (typeof input === 'number') {
    // performance.now()-style values are small; epoch milliseconds are not.
    return input < 1e12 ? (typeof performance !== 'undefined' && performance.timeOrigin ? performance.timeOrigin + input : Date.now()) : input;
  }
  if (input instanceof Date) return input.getTime();
  if (Array.isArray(input)) return input[0] * 1e3 + input[1] / 1e6;
  return now();
}

/** Start a span under the active one (or `parent`), in the active request. */
export function startSpan(name: string, options: SpanOptions = {}, ctx: Context = activeContext()): ZharpSpan {
  const parent = options.root ? undefined : trace.getSpanContext(ctx);
  return new ZharpSpan(name, options.kind ?? SpanKind.INTERNAL, parent, requestOf(ctx), options.attributes, options.startTime, options.links);
}

/** Run `fn` with `span` active. */
export function withSpan<T>(span: OtelSpan, fn: () => T, ctx: Context = activeContext()): T {
  return contextManager.with(trace.setSpan(ctx, span), fn);
}

class ZharpTracer implements OtelTracer {
  startSpan(name: string, options?: SpanOptions, ctx?: Context): OtelSpan {
    return startSpan(name, options, ctx ?? activeContext());
  }

  startActiveSpan<F extends (span: OtelSpan) => unknown>(name: string, ...args: unknown[]): ReturnType<F> {
    const fn = args[args.length - 1] as F;
    const options = (args.length > 1 ? args[0] : undefined) as SpanOptions | undefined;
    const ctx = (args.length > 2 ? args[1] : undefined) as Context | undefined;
    const parentCtx = ctx ?? activeContext();
    const span = startSpan(name, options, parentCtx);
    return contextManager.with(trace.setSpan(parentCtx, span), () => fn(span)) as ReturnType<F>;
  }
}

const tracer = new ZharpTracer();
const provider: TracerProvider = { getTracer: () => tracer };

// ── traceparent ─────────────────────────────────────────────────────────

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** A W3C `traceparent` header as a remote span context, or undefined. */
export function parseTraceparent(header: string | null | undefined): SpanContext | undefined {
  const match = header ? TRACEPARENT.exec(header.trim().toLowerCase()) : null;
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return undefined;
  return { traceId: match[1], spanId: match[2], traceFlags: parseInt(match[3], 16) & 1, isRemote: true };
}

export function formatTraceparent(span: SpanContext): string {
  return `00-${span.traceId}-${span.spanId}-${span.traceFlags & TraceFlags.SAMPLED ? '01' : '00'}`;
}

const propagator: TextMapPropagator = {
  inject(ctx, carrier, setter) {
    const span = trace.getSpanContext(ctx);
    if (span && trace.isSpanContextValid(span)) setter.set(carrier, 'traceparent', formatTraceparent(span));
  },
  extract(ctx, carrier, getter) {
    const raw = getter.get(carrier, 'traceparent');
    const parent = parseTraceparent(Array.isArray(raw) ? raw[0] : raw);
    return parent ? trace.setSpanContext(ctx, parent) : ctx;
  },
  fields: () => ['traceparent'],
};

let registered = false;

/**
 * Make this tracer the one `@opentelemetry/api` hands out. If another provider is registered
 * already, it keeps its place: Zharp's own spans don't go through the API.
 */
export function registerOpenTelemetry(): void {
  if (registered) return;
  registered = true;
  try {
    otelContext.setGlobalContextManager(contextManager);
    trace.setGlobalTracerProvider(provider);
    propagation.setGlobalPropagator(propagator);
  } catch {
    // Another copy registered first; ours still works for Zharp's own spans.
  }
}
