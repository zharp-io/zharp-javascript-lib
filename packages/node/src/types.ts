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

/** `captureBodies`: which request and response bodies go on HTTP spans. */
export interface CaptureBodiesOptions {
  /** `errors` (default): failed requests only (status 400 and above). `all`: every request. */
  mode?: 'errors' | 'all';
  /** Characters kept per body. Default 32768 (32 KB), at most 131072 (128 KB). */
  maxSize?: number;
  /**
   * More keys whose values are replaced with `[Filtered]`, on top of the built-in ones. A string
   * matches a key ignoring case, `-` and `_`; a RegExp is tested against the key as it is.
   */
  redactKeys?: Array<string | RegExp>;
  /**
   * Which requests (incoming and outgoing) have their bodies captured: a bare host matches that
   * host, a string with a scheme matches URLs starting with it, a RegExp is tested against the
   * full URL. Default: all of them.
   */
  urls?: Array<string | RegExp>;
}

/** `true` is `'errors'`. */
export type CaptureBodies = boolean | 'errors' | 'all' | CaptureBodiesOptions;

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
   * Traces. Default **true**. `false` is logs only: logs, errors, user, session and tags are
   * sent as usual, but no spans are exported, no http/database/framework instrumentation is
   * installed, and no `traceparent` or `baggage` is added to outgoing requests. An incoming
   * `traceparent` is still read, so the logs of a request carry the caller's trace id.
   * `startSpan` just runs its callback. Falls back to `ZHARP_TRACING` (`false` turns it off).
   */
  tracing?: boolean;
  /**
   * Send what the application logs — `console`, pino, winston, bunyan and everything else it
   * prints. Default **false**: where the Zharp agent reads the app's output it already brings
   * those lines in, linked to their requests by the ids stamped on them (see `logCorrelation`).
   * Turn it on where nothing else collects the output (serverless, a plain VM without the
   * agent). Falls back to `ZHARP_LOGS` (`true` turns it on). Errors, `Zharp.log` and traces are
   * sent either way. `captureConsole` and `captureOutput` refine what is sent when this is on.
   */
  logs?: boolean;
  /**
   * Stamp the request's ids on every line printed during it — `trace_id=… span_id=…` at the end
   * of a text line, two fields in a JSON record — so Zharp links the line to its request
   * whichever way it arrives. Default **true**. Falls back to `ZHARP_LOG_CORRELATION`.
   */
  logCorrelation?: boolean;
  /**
   * With `logs` on: send `console.*` output as logs. Default **true**: on a server, the console is where most
   * logging already goes. pino, winston and bunyan are bridged by their instrumentations
   * whatever this says.
   */
  captureConsole?: boolean;
  /**
   * With `logs` on: send everything else the process prints as logs too: whatever reaches stdout or stderr
   * without going through `console` or a bridged library — NestJS's Logger, debug, log4js,
   * libraries writing to `process.stdout` directly. Default **true**. Each line keeps the
   * request it was printed in; its level is read from the line (a JSON record's `level`,
   * NestJS's `LOG`/`WARN`/`ERROR`, a word such as `ERROR`), else info on stdout and warn on
   * stderr. A line another capture already sent is not sent again. `false` (or
   * `ZHARP_CAPTURE_OUTPUT=false`) turns it off.
   */
  captureOutput?: boolean;
  /**
   * Request and response bodies on HTTP spans — incoming requests and outgoing http/https
   * calls. Default **off**. `'errors'` (or `true`) keeps them for failed requests only (status
   * 400 and above); `'all'` for every request. Falls back to `ZHARP_CAPTURE_BODIES`
   * (`errors` or `all`). Text is capped at 32 KB; files in uploads, inline images and binary
   * bodies are described (name, type, size), never sent. Field names are always kept; values
   * under secret-looking keys (`password`, `token`, `authorization`, `card`, …) are replaced
   * with `[Filtered]` before anything is sent. Other personal data in a body is sent as it is:
   * add its keys to `redactKeys`.
   *
   *     captureBodies: 'errors'
   *     captureBodies: { mode: 'all', redactKeys: ['dateOfBirth'], urls: [/\/api\//] }
   */
  captureBodies?: CaptureBodies;
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
