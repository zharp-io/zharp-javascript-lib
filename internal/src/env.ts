/**
 * Configuration from the environment, and the lines printed at startup.
 *
 * Both packages start the way dd-trace does: `init()` with no arguments reads the environment,
 * explicit options override it, and the result is announced in one line so it is obvious from
 * the first few lines of output whether — and as what — the application is reporting.
 */

import { loadBuiltin } from './builtins';

/**
 * An environment variable, in Node only.
 *
 * Browser bundles often carry a `process` shim whose `env` was baked in at build time — reading
 * it there would tag a page with the build machine's NODE_ENV — so a browser reads nothing.
 */
export function nodeEnv(name: string): string | undefined {
  if (typeof window !== 'undefined' || typeof process === 'undefined' || !process.env) return undefined;
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

/** What a deployment can set without touching code. Every field may be absent. */
export interface EnvConfig {
  apiKey?: string;
  service?: string;
  environment?: string;
  version?: string;
  source?: string;
  endpoint?: string;
  /** Raw `ZHARP_CAPTURE_CONSOLE`: `all`, or a list such as `warn,error`. */
  captureConsole?: string;
}

/**
 * Everything the environment says, in Node. Empty in a browser.
 *
 * | Setting       | Variables                                   |
 * |---------------|---------------------------------------------|
 * | `apiKey`      | `ZHARP_API_KEY`                             |
 * | `service`     | `ZHARP_SERVICE`, then `OTEL_SERVICE_NAME`   |
 * | `environment` | `ZHARP_ENV`, then `NODE_ENV`                |
 * | `version`     | `ZHARP_VERSION`                             |
 * | `source`      | `ZHARP_SOURCE`                              |
 * | `endpoint`    | `ZHARP_ENDPOINT`                            |
 * | `captureConsole` | `ZHARP_CAPTURE_CONSOLE` (logs only)      |
 */
export function readEnv(): EnvConfig {
  return {
    apiKey: nodeEnv('ZHARP_API_KEY'),
    service: nodeEnv('ZHARP_SERVICE') || nodeEnv('OTEL_SERVICE_NAME'),
    environment: nodeEnv('ZHARP_ENV') || nodeEnv('NODE_ENV'),
    version: nodeEnv('ZHARP_VERSION'),
    source: nodeEnv('ZHARP_SOURCE'),
    endpoint: nodeEnv('ZHARP_ENDPOINT'),
    captureConsole: nodeEnv('ZHARP_CAPTURE_CONSOLE'),
  };
}

/**
 * The app's own name, from the nearest package.json above the script Node was started with (or
 * the working directory) — the name a service gets when none is configured, as dd-trace does.
 * A scope is dropped: "@acme/checkout-api" is "checkout-api". Nothing in a browser.
 */
export function packageName(): string | undefined {
  if (typeof window !== 'undefined' || typeof process === 'undefined') return undefined;
  const fs = loadBuiltin('fs');
  const path = loadBuiltin('path');
  if (!fs || !path) return undefined;
  const starts = [process.argv?.[1] ? path.dirname(path.resolve(process.argv[1])) : '', process.cwd?.() ?? ''];
  for (const start of starts.filter(Boolean)) {
    let dir = start;
    for (let i = 0; i < 12; i++) {
      // A dependency's own package.json is not the app's.
      if (path.basename(dir) !== 'node_modules') {
        try {
          const name = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))?.name;
          if (typeof name === 'string' && name.trim()) return name.trim().replace(/^@[^/]+\//, '');
        } catch {
          // No package.json here, or not one we can read: keep looking further up.
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

/** `ZHARP_DISABLED=true` (or `1`, `yes`): start nothing, whatever the code asks for. */
export function disabledByEnv(): boolean {
  const value = nodeEnv('ZHARP_DISABLED');
  return !!value && /^(true|1|yes|on)$/i.test(value);
}

/** The first argument that is a non-empty string — explicit option, then the next fallback. */
export function pick(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** `service "checkout-api", environment "production"` — the part both activation lines share. */
export function describeTarget(service: string, environment?: string): string {
  return `service "${service}", ${environment ? `environment "${environment}"` : 'no environment set'}`;
}

/** Startup output. One prefix, so it can be grepped for. */
export function announce(message: string): void {
  console.info(`[Zharp] ${message}`);
}

export function warn(message: string): void {
  console.warn(`[Zharp] ${message}`);
}
