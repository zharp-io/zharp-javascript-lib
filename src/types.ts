import { TracingOptions } from './trace/types';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  service: string;
  level: LogLevel;
  message: string;
  timestamp: string;
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
  /** Default service name attached to all logs from this SDK instance */
  service: string;
  /** Environment tag e.g. 'production', 'staging'. Attached to every log */
  environment?: string;
  /** How often to flush the log queue in ms. Default: 5000 */
  flushInterval?: number;
  /** Max logs per batch sent to the API. Default: 50 */
  maxBatchSize?: number;
  /** Auto-capture browser errors. All options default to true except consoleErrors */
  autoCapture?: AutoCaptureOptions;
  /** App version string e.g. '1.4.2'. Attached to every log under context.appVersion */
  appVersion?: string;
  /**
   * Distributed tracing. Off unless `enabled: true` — tracing sends far more data than logging,
   * so it is opted into rather than inherited.
   */
  tracing?: TracingOptions;
}
