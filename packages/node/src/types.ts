import type { InstrumentationConfigMap } from '@opentelemetry/auto-instrumentations-node';
import type { Instrumentation } from '@opentelemetry/instrumentation';

/** A value an attribute can hold. Objects and arrays are sent as they are and shown as JSON. */
export type AttributeValue = string | number | boolean | null | undefined | AttributeValue[] | { [key: string]: AttributeValue };
export type Attributes = Record<string, unknown>;

export interface ZharpUser {
  /** Sent as `enduser.id`. An ID or an email — whatever identifies the person in your app. */
  id: string | number;
  /** Sent as `enduser.email`. */
  email?: string;
  /** Sent as `enduser.name`. */
  name?: string;
}

export interface NodeOptions {
  /**
   * The app's key from the Zharp dashboard (`zpk_…`), or a workspace API key with the ingest
   * scope. Falls back to `ZHARP_API_KEY`. Without one, `init()` starts nothing and says so.
   */
  key?: string;
  /** `service.name`. Falls back to `ZHARP_SERVICE`, `OTEL_SERVICE_NAME`, then package.json's name. */
  service?: string;
  /** `deployment.environment.name`. Falls back to `ZHARP_ENV`, then `NODE_ENV`. */
  environment?: string;
  /** `service.version`, e.g. `api@2.3.0` or a commit SHA. Falls back to `ZHARP_RELEASE`. */
  release?: string;
  /** Default `https://api.zharp.io/api/v1/otlp`. Falls back to `ZHARP_ENDPOINT`. */
  endpoint?: string;
  /**
   * Fraction of traces to keep, 0 to 1. Default 1. A trace that arrives with a decision from
   * the caller (the browser SDK's `traceparent`) keeps that decision. Errors and logs are always
   * sent.
   */
  sampleRate?: number;
  /**
   * Send `console.*` output as logs. Default **true**: on a server, the console is where most
   * logging already goes. pino, winston and bunyan are bridged by their instrumentations
   * whatever this says.
   */
  captureConsole?: boolean;
  /**
   * Capture uncaught exceptions and unhandled rejections. Default true. The process still
   * exits as Node would have, once they have been sent.
   */
  captureUncaught?: boolean;
  /**
   * Per-instrumentation settings, passed to `getNodeAutoInstrumentations`. `dns`, `net` and
   * `fs` are off by default (a span per lookup, socket or file read is noise); turn one back on
   * with `{ '@opentelemetry/instrumentation-dns': { enabled: true } }`.
   */
  instrumentations?: InstrumentationConfigMap;
  /** More instrumentations to register alongside the automatic ones. */
  extraInstrumentations?: Instrumentation[];
  /** Print what the SDK and OpenTelemetry are doing. Default false. */
  debug?: boolean;
}
