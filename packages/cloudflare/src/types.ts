import type { CaptureHeaders } from '@zharp/internal/headers';

export type Attributes = Record<string, unknown>;

export interface ZharpUser {
  /** Sent as `enduser.id`. An ID or an email — whatever identifies the person in your app. */
  id: string | number;
  /** Sent as `enduser.email`. */
  email?: string;
  /** Sent as `enduser.name`. */
  name?: string;
}

/**
 * Settings for `withZharp`, `instrumentDurableObject` and `zharpPagesPlugin`. Every one of them
 * can also come from the Worker's environment (vars and secrets), which is where they usually
 * live: the options passed in code win.
 */
export interface ZharpCloudflareOptions {
  /**
   * The app's key from the Zharp dashboard (`zpk_…`). Falls back to the `ZHARP_KEY` secret
   * (`wrangler secret put ZHARP_KEY`). Without one nothing is sent, and the Worker runs as before.
   */
  key?: string;
  /** `service.name`. Falls back to `ZHARP_SERVICE`, then `worker` (Pages: `pages`). */
  service?: string;
  /** `deployment.environment.name`. Falls back to `ZHARP_ENVIRONMENT`. */
  environment?: string;
  /**
   * `service.version`: what uploaded source maps are matched by. Falls back to `ZHARP_RELEASE`
   * (`wrangler deploy --var ZHARP_RELEASE:$SHA`), then the deployed version's ID from the
   * `CF_VERSION_METADATA` binding.
   */
  release?: string;
  /** Default `https://api.zharp.io/api/v1/otlp`. Falls back to `ZHARP_ENDPOINT`. */
  endpoint?: string;
  /**
   * Fraction of traces to keep, 0 to 1. Default 1. A request that arrives with a `traceparent`
   * keeps its caller's decision. Errors are always sent. Falls back to `ZHARP_SAMPLE_RATE`.
   */
  sampleRate?: number;
  /** Traces. Default true; `false` (or `ZHARP_TRACING=false`) sends errors and logs only. */
  tracing?: boolean;
  /**
   * Send `console.*` output as logs, each with its request's trace. Default **false**: Cloudflare's
   * Workers Logs keeps it already. Falls back to `ZHARP_LOGS` (`true` turns it on). Errors and
   * `Zharp.log` are sent either way.
   */
  logs?: boolean;
  /**
   * Request and response headers on HTTP spans. Default on; secrets (`authorization`, `cookie`,
   * API keys, tokens…) are recorded as `[Filtered]`. `false` (or `ZHARP_CAPTURE_HEADERS=false`)
   * turns it off; `{ redact: [...] }` filters more names.
   */
  captureHeaders?: CaptureHeaders;
  /**
   * Failed D1 queries reported as errors with the line of your code that ran them and the SQL.
   * Default true.
   */
  captureQueryErrors?: boolean;
  /**
   * Outgoing requests that get no span and no `traceparent` (a bare host, a URL prefix, or a
   * RegExp tested against the full URL).
   */
  ignoreUrls?: Array<string | RegExp>;
}

/** Options, or a function that reads them from the Worker's `env`. */
export type ZharpConfig<E = any> = ZharpCloudflareOptions | ((env: E) => ZharpCloudflareOptions);
