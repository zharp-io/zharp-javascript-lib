/**
 * One recorded rrweb event, as `beforeSend` sees it.
 *
 * Declared here rather than imported from rrweb so this package's main types never reference
 * rrweb: it is only loaded when replay is switched on.
 */
export interface ReplayEvent {
  type: number;
  data: unknown;
  timestamp: number;
  [key: string]: unknown;
}

export interface ReplayOptions {
  /**
   * Fraction of sessions to record, 0 to 1. Default: 1.
   *
   * Decided once, before anything is loaded, and never revisited: a session recorded for half
   * its length is a video that cuts out mid-sentence. A session sampled out never downloads the
   * recorder at all.
   */
  sampleRate?: number;

  /** How often to ship what has been recorded, in milliseconds. Default: 10000. */
  flushInterval?: number;

  /**
   * Mask the contents of every input, textarea and select. Default: **true**.
   *
   * Turning this off ships whatever people type — passwords, card numbers, private messages —
   * to a monitoring service. It is deliberately awkward to disable, and if you do, it should
   * be alongside `blockSelector` covering everything sensitive on the page.
   */
  maskAllInputs?: boolean;

  /** Also mask all text, not just inputs. Off by default; a recording of blanks is not useful. */
  maskAllText?: boolean;

  /**
   * CSS selector for elements to leave out of the recording entirely. Their space is kept but
   * their contents are never captured — the right tool for a payment iframe or a document
   * preview.
   */
  blockSelector?: string;

  /** CSS selector for elements whose text should be masked. */
  maskTextSelector?: string;

  /** Called with each recorded batch before it is sent. Return false to drop it. */
  beforeSend?: (events: ReplayEvent[]) => boolean;
}

export interface ZharpAPMConfig {
  /**
   * Your Zharp API key — an "Ingest only" key. Falls back to the key @zharp/logs was started
   * with, then (in Node) `ZHARP_API_KEY`. With none, `init()` starts nothing and prints a hint.
   */
  apiKey?: string;
  /**
   * Service name every span is filed under. Falls back to @zharp/logs', then `ZHARP_SERVICE`,
   * then `OTEL_SERVICE_NAME`.
   */
  service?: string;
  /**
   * Sent as `deployment.environment.name` (and the older `deployment.environment`) on every
   * span. Falls back to @zharp/logs', then `ZHARP_ENV`, then `NODE_ENV`. No default.
   */
  environment?: string;
  /** Application version, sent as `service.version`. Falls back to @zharp/logs', then `ZHARP_VERSION`. */
  version?: string;
  /** Same as `version`, under the name @zharp/logs uses. */
  appVersion?: string;
  /** What produced the spans, e.g. 'web' or 'worker'. Sent as `zharp.source`. Falls back to `ZHARP_SOURCE`. */
  source?: string;
  /** Base URL of the Zharp API. Default: 'https://api.zharp.io/api/v1'. Falls back to `ZHARP_ENDPOINT`. */
  endpoint?: string;
  /** How often to send finished spans, in ms. Default: 5000. */
  flushInterval?: number;

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
   * Defaults to same-origin only in the browser, and to everything in Node. An unexpected header
   * on a cross-origin request turns a simple call into a CORS preflight, and if the third party
   * does not allow the header the request fails outright, so widening it is done explicitly.
   *
   * Accepts strings (substring match) and regular expressions.
   */
  propagateTo?: Array<string | RegExp>;

  /** Paths never traced, e.g. health checks. Matched against the URL. */
  ignore?: Array<string | RegExp>;

  /**
   * Session replay, browser only. Off unless given: `true` records every session with the
   * default privacy settings; an object sets the sample rate and privacy options.
   *
   * The recorder (and rrweb with it) is loaded with a dynamic import when replay starts, so a
   * bundle that never turns it on never contains it.
   */
  replay?: boolean | ReplayOptions;
}
