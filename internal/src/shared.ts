/**
 * A global handle for state that must survive two copies of a package being loaded.
 *
 * It is where @zharp/logs keeps its singleton and session ID. A CommonJS `require('@zharp/logs')` and an
 * ES `import` of the same package load two different builds; with the instance kept here, both
 * hand back the same logger — which is what makes `node --import @zharp/logs/init` work for an
 * application that then `require`s the package.
 */

/** The settings a package was started with. */
export interface PublishedConfig {
  apiKey: string;
  service: string;
  endpoint: string;
  environment?: string;
  version?: string;
  source?: string;
}

export interface ZharpShared {
  /** One per page load or process, shared by everything the package sends. See session.ts. */
  sessionId?: string;

  /** Set by @zharp/logs while it is running. */
  logs?: PublishedConfig;
  /** The package singletons. */
  logger?: unknown;

  [key: string]: unknown;
}

/** The handle, created on first use. */
export function shared(): ZharpShared {
  const g = globalThis as any;
  if (!g.__ZHARP__ || typeof g.__ZHARP__ !== 'object') g.__ZHARP__ = {};
  return g.__ZHARP__ as ZharpShared;
}
