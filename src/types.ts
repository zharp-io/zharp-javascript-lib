import { TracingOptions } from './trace/types';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  service: string;
  level: LogLevel;
  message: string;
  timestamp: string;
  /** Deployment environment, e.g. 'production'. Absent when none was configured or detected. */
  environment?: string;
  /** Application version, from `appVersion`. */
  version?: string;
  /** What produced the log, from the `source` option. */
  source?: string;
  metadata?: Record<string, any>;
}

export interface AutoCaptureOptions {
  /** Capture window.onerror — unhandled JS errors. Default: true */
  errors?: boolean;
  /** Capture unhandledrejection — unhandled promise rejections. Default: true */
  unhandledRejections?: boolean;
  /** Wrap console.error to also send to Zharp. Default: false */
  consoleErrors?: boolean;
}

export interface ZharpConfig {
  /** Your Zharp API key */
  apiKey: string;
  /**
   * Default service name attached to all logs from this SDK instance.
   *
   * In Node it falls back to the `ZHARP_SERVICE`, then `OTEL_SERVICE_NAME` environment variable.
   * With none of the three, the SDK warns and files everything under 'unknown-service' — so in a
   * browser, always set it.
   */
  service?: string;
  /**
   * Environment tag e.g. 'production', 'staging'. Sent as the `environment` tag of every log and
   * as `deployment.environment.name` on every span.
   *
   * In Node it falls back to `ZHARP_ENV`, then `NODE_ENV`. In a browser it is left unset unless
   * given here. There is no default: guessing 'production' put development traffic on
   * production dashboards.
   */
  environment?: string;
  /**
   * What produced the logs, e.g. 'web' or 'worker'. Sent as the `source` tag of every log and as
   * `zharp.source` on every span. Optional.
   */
  source?: string;
  /** Base URL of the Zharp API. Default: 'https://api.zharp.io/api/v1' */
  endpoint?: string;
  /** How often to flush the log queue in ms. Default: 5000 */
  flushInterval?: number;
  /** Max logs per batch sent to the API. Default: 50 */
  maxBatchSize?: number;
  /** Auto-capture browser errors. All options default to true except consoleErrors */
  autoCapture?: AutoCaptureOptions;
  /**
   * App version string e.g. '1.4.2'. Sent as the `version` tag of every log (and kept under
   * context.appVersion) and as `service.version` on every span. In Node it falls back to
   * `ZHARP_VERSION`.
   */
  appVersion?: string;
  /**
   * Distributed tracing. Off unless `enabled: true` — tracing sends far more data than logging,
   * so it is opted into rather than inherited.
   */
  tracing?: TracingOptions;
}
