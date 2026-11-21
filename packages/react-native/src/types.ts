import type { CaptureBodies } from '../../browser/src/types';

export type { Attributes, ZharpUser } from '../../browser/src/types';

export interface ReactNativeOptions {
  /** The app's key from the Zharp dashboard (`zpk_…`). It can only send, so it is safe in the app. */
  key: string;
  /** `service.name`, e.g. `shop-app`. */
  service?: string;
  /** `deployment.environment.name`, e.g. `production`. */
  environment?: string;
  /** `service.version`, e.g. `shop-app@2.3.0+41`. */
  release?: string;
  /** Leave unset: the SDK sends straight to Zharp. */
  endpoint?: string;
  /** `false` starts nothing: a switch for development builds. */
  enabled?: boolean;
  /** `false` is logs only: errors and logs are sent, no spans and no trace headers. */
  tracing?: boolean;
  /**
   * Hosts whose requests carry `traceparent` and `baggage`, so your back end continues the app's
   * traces: `'api.example.com'`, `'https://api.example.com:8443'`, or a RegExp. Empty by default.
   */
  tracingOrigins?: Array<string | RegExp>;
  /** URLs never traced. */
  ignoreUrls?: Array<string | RegExp>;
  /** The share of traces kept, 0 to 1. Errors and logs are always sent. */
  sampleRate?: number;
  /** Request and response bodies on request spans. Default off. Same as @zharp/browser. */
  captureBodies?: CaptureBodies;
  /**
   * Request and response headers on request spans. Default **on**; secret headers
   * (`authorization`, cookies, API keys, tokens…) are recorded as `[Filtered]`. `false` turns it
   * off; `{ redact: ['x-tenant'] }` filters more names.
   */
  captureHeaders?: boolean | { redact?: Array<string | RegExp> };
  /** Send the app's logs (`console.*` and `Zharp.log`). Default off. */
  logs?: boolean;
  /** With `logs`: which console methods. Default all. */
  captureConsole?: boolean | Array<'debug' | 'log' | 'info' | 'warn' | 'error'>;
  /** Print what the native SDK does (`[Zharp] …` in Logcat / the Xcode console). Default off. */
  debug?: boolean;
  /** Minutes in the background or idle before a new session. Default 30. */
  sessionTimeoutMinutes?: number;
}
