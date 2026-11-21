/**
 * Request and response headers on HTTP spans, as OpenTelemetry names them
 * (`http.request.header.user-agent`, `http.response.header.content-type`), so a failed request
 * shows what was sent and what came back — and, as importantly, what wasn't sent (a request
 * with no `authorization` header). Every secret header is recorded as `[Filtered]`: it was
 * sent, its value never leaves the app. Same key rules as request bodies. Shared by the Node and
 * browser SDKs.
 */
import { FILTERED, isSecretKey } from './bodies';

export interface HeaderSettings {
  /** More header names to treat as secret (names or patterns). */
  redact: Array<string | RegExp>;
}

/** `captureHeaders`: on (the default), off, or on with more names to filter. */
export type CaptureHeaders = boolean | { redact?: Array<string | RegExp> };

/** Headers that are secret whatever the key rules say. */
const SECRET = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'x-csrf-token', 'x-xsrf-token']);
/** Per side, so a request stuffed with headers can't fill the span. */
const MAX_HEADERS = 40;
const MAX_VALUE = 512;

/** Header settings from the option (and ZHARP_CAPTURE_HEADERS where there is an environment); null when off. */
export function headerSettings(option: CaptureHeaders | undefined, env?: string): HeaderSettings | null {
  if (option === false || env === 'false' || env === '0') return null;
  return { redact: typeof option === 'object' && option?.redact ? option.redact : [] };
}

/** A header's value as it is recorded: secrets filtered, long values cut, repeats joined. */
function shown(name: string, value: unknown, settings: HeaderSettings): string | null {
  if (value === undefined || value === null) return null;
  if (SECRET.has(name) || isSecretKey(name, settings.redact)) return FILTERED;
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text;
}

/** `http.<side>.header.<name>` attributes for a set of headers (a record, or name/value pairs). */
export function headerAttributes(
  side: 'request' | 'response',
  headers: Record<string, unknown> | Iterable<[string, string]> | null | undefined,
  settings: HeaderSettings,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  // A Headers object or a list of pairs is iterable; Node's header objects are plain records.
  const entries: Array<[string, unknown]> = typeof (headers as Iterable<unknown>)[Symbol.iterator] === 'function'
    ? [...(headers as Iterable<[string, string]>)]
    : Object.entries(headers as Record<string, unknown>);
  let count = 0;
  for (const [rawName, value] of entries) {
    if (count >= MAX_HEADERS) break;
    const name = rawName.toLowerCase();
    const text = shown(name, value, settings);
    if (text === null) continue;
    out[`http.${side}.header.${name}`] = text;
    count++;
  }
  return out;
}

/** XMLHttpRequest's getAllResponseHeaders() text as name/value pairs. */
export function parseHeaderBlock(text: string | null | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of (text ?? '').split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at > 0) out.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return out;
}
