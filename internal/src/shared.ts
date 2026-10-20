/**
 * The handle @zharp/logs and @zharp/apm find each other through.
 *
 * Neither package imports the other — an application that only wants logging must not get a
 * tracer linked in, and one that only wants tracing must not get a log queue — so whatever
 * they share lives on one global object instead. Every field is optional and every reader
 * checks, so the two can be initialised in either order, or one of them never.
 *
 * It is also where each package keeps its singleton. A CommonJS `require('@zharp/logs')` and an
 * ES `import` of the same package load two different builds; with the instance kept here, both
 * hand back the same logger — which is what makes `node --import @zharp/logs/init` work for an
 * application that then `require`s the package.
 */

/** The settings a package was started with, published so the other can reuse them. */
export interface PublishedConfig {
  apiKey: string;
  service: string;
  endpoint: string;
  environment?: string;
  version?: string;
  source?: string;
}

/** The span a log should be attached to. */
export interface ActiveSpan {
  traceId: string;
  spanId: string;
}

export interface ZharpShared {
  /** One per page load or process, shared by logs, spans and recordings. See session.ts. */
  sessionId?: string;

  /** Set by @zharp/logs while it is running. */
  logs?: PublishedConfig;
  /** Set by @zharp/apm while it is running. */
  apm?: PublishedConfig;

  /** Set by @zharp/apm while it is running: the span currently in scope, if any. */
  activeSpan?: () => ActiveSpan | null;
  /** Set by @zharp/apm while it is running: add to the trail attached to the next exception. */
  addBreadcrumb?: (crumb: { kind: 'log'; message: string; level: 'warn' | 'error' }) => void;

  /** Set while a session is being recorded: flag the recording as one where something broke. */
  markError?: () => void;
  /** Set while a session is being recorded: associate a trace with the recording. */
  linkTrace?: (traceId: string) => void;

  /** The package singletons. */
  logger?: unknown;
  apmInstance?: unknown;

  [key: string]: unknown;
}

/** The handle, created on first use. */
export function shared(): ZharpShared {
  const g = globalThis as any;
  if (!g.__ZHARP__ || typeof g.__ZHARP__ !== 'object') g.__ZHARP__ = {};
  return g.__ZHARP__ as ZharpShared;
}
