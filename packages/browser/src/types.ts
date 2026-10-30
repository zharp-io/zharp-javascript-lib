/** Anything JSON can hold. Objects and arrays are sent as they are and shown as JSON. */
export type Attributes = Record<string, unknown>;

export interface ZharpUser {
  /** Sent as `enduser.id`. An ID or an email — whatever identifies the person in your app. */
  id: string | number;
  /** Sent as `enduser.email`. */
  email?: string;
  /** Sent as `enduser.name`. */
  name?: string;
}

/** One recorded rrweb event, as `replay.beforeSend` sees it. Declared here so the main types never load rrweb. */
export interface ReplayEvent {
  type: number;
  data: unknown;
  timestamp: number;
  [key: string]: unknown;
}

export interface ReplayOptions {
  /**
   * Fraction of sessions recorded from start to end, 0 to 1. Default 0. Decided once per
   * session; a session that is not sampled never downloads the recorder.
   */
  sampleRate?: number;
  /**
   * Fraction of the remaining sessions that keep the last minute in memory and upload it —
   * with the rest of the session — only when an error happens. Default 0. `1.0` means every
   * session with an error comes with a replay, at no upload cost for the ones without.
   */
  onErrorSampleRate?: number;
  /**
   * Mask what is typed into every input, textarea and select. Default **true**. Turning it off
   * sends passwords and card numbers unless `blockSelector` covers them.
   */
  maskAllInputs?: boolean;
  /** Mask all text on the page, not just inputs. Default false. */
  maskAllText?: boolean;
  /** Elements left out of the recording entirely (a payment iframe, a private document). */
  blockSelector?: string;
  /** Elements whose text is masked. */
  maskTextSelector?: string;
  /** Called with each batch before it is sent. Return false to drop it. */
  beforeSend?: (events: ReplayEvent[]) => boolean;
  /**
   * Where the script-tag build loads the recorder from. Default: `zharp-replay.min.js` next to
   * `zharp.min.js`. Bundled builds ignore it — the recorder is a lazily imported chunk there.
   */
  recorderUrl?: string;
}

export interface BrowserOptions {
  /** The app's key from the Zharp dashboard (`zpk_…`). Safe to ship in a page: it can only send. */
  key: string;
  /** `service.name`, e.g. `checkout-web`. */
  service?: string;
  /** `deployment.environment.name`, e.g. `production`. */
  environment?: string;
  /** `service.version`, e.g. `web@2.3.0` or a commit SHA. */
  release?: string;
  /** Default `https://api.zharp.io/api/v1/otlp`. */
  endpoint?: string;
  /**
   * Hosts (or URL prefixes, or patterns) that get `traceparent` and `baggage` headers, so their
   * spans join the page's trace. Same-origin requests always do. Nothing else does: an unknown
   * header on a third-party request can make it fail CORS.
   *
   * `"api.example.com"` matches that host on any port and scheme; `"https://api.example.com/v2"`
   * matches URLs starting with it; a RegExp is tested against the full URL.
   */
  tracingOrigins?: Array<string | RegExp>;
  /**
   * Traces. Default **true**. `false` is logs only: logs, errors, the user, the session and tags
   * are sent as usual, but no spans are made (no page load, navigation, click or request spans),
   * `fetch` and `XMLHttpRequest` are not patched, and no `traceparent` or `baggage` header is
   * added to any request. `startSpan` just runs its callback. Session replay is independent —
   * it follows `replay` either way; without traces a replay simply has no trace ids linked to it.
   */
  tracing?: boolean;
  /** Fraction of traces to keep, 0 to 1. Default 1. Errors, logs and replays are not affected. */
  sampleRate?: number;
  /** Session replay. Off unless a sample rate is set. */
  replay?: ReplayOptions;
  /**
   * Copy `console.*` calls into Zharp as logs: `true` for all levels, or a list such as
   * `["warn", "error"]`. Default **off** — a page's console is mostly other people's libraries.
   */
  captureConsole?: boolean | Array<'debug' | 'log' | 'info' | 'warn' | 'error'>;
  /** Spans for clicks that lead to requests. Default true. */
  interactions?: boolean;
  /** URLs never traced (no span, no headers), e.g. analytics beacons. */
  ignoreUrls?: Array<string | RegExp>;
  /** Minutes without activity before a new session starts. Default 30. */
  sessionTimeoutMinutes?: number;
}
