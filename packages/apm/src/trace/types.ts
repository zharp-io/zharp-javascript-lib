/** What a span is allowed to carry as an attribute value. */
export type AttributeValue = string | number | boolean | Array<string | number | boolean>;

export type Attributes = Record<string, AttributeValue>;

/** Which side of a call a span describes. */
export type SpanKind = 'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER';

/**
 * UNSET is not success. A span is only OK if something explicitly said so; treating UNSET as
 * success would hide every failure nobody marked, which is the failure mode that matters.
 */
export type SpanStatus = 'UNSET' | 'OK' | 'ERROR';

/** The part of a span that travels — across a function boundary, or across the network. */
export interface SpanContext {
  traceId: string;
  spanId: string;
  /** Whether this trace is being recorded. Carried so a child cannot disagree with its parent. */
  sampled: boolean;
}

/** A timestamped moment inside a span. */
export interface SpanEvent {
  name: string;
  time: string;
  attributes?: Attributes;
}

/** One finished span, in the shape Zharp's ingest accepts. */
export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  serviceName: string;
  startTime: string;
  endTime: string;
  statusCode: SpanStatus;
  statusMessage?: string;
  attributes?: Attributes;
  resource?: Record<string, any>;
  events?: SpanEvent[];
}

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Attributes;
  /** Parent to hang this span under. Omit to use whatever span is currently active. */
  parent?: SpanContext | null;
}

/** What the tracer is built with. Internal: the public options are `ZharpAPMConfig`. */
export interface TracingOptions {
  /** Record and send spans. `ZharpAPM.init()` turns it on; the tracer used before `init()` has it off. */
  enabled?: boolean;

  /**
   * Fraction of traces to record, 0 to 1. Default: 1.
   *
   * The decision is made once at the root and inherited by every child, so a trace is never
   * half-recorded — a partial trace is worse than no trace, because its gaps look like latency.
   */
  sampleRate?: number;

  /** Capture outgoing fetch and XHR calls automatically. Default: true. */
  fetch?: boolean;

  /** Capture Node's http/https client calls and incoming server requests. Default: true. */
  http?: boolean;

  /**
   * Record a short trail of clicks, navigations, requests and warnings, and attach it to any
   * error that follows. Default: true.
   *
   * Nothing typed is captured — only that typing happened, and into which field.
   */
  breadcrumbs?: boolean;

  /**
   * Which outgoing requests get a `traceparent` header.
   *
   * Defaults to same-origin only in the browser, and to everything in Node. This default is
   * deliberate: an unexpected header on a cross-origin request turns a simple call into a CORS
   * preflight, and if the third party does not allow the header the request fails outright.
   * Widening it is a decision about someone else's server, so it is made explicitly.
   *
   * Accepts strings (substring match) and regular expressions.
   */
  propagateTo?: Array<string | RegExp>;

  /** Paths never traced, e.g. health checks. Matched against the URL. */
  ignore?: Array<string | RegExp>;
}
