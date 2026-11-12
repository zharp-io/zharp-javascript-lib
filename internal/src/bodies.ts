/**
 * Request and response bodies on HTTP spans (`captureBodies`), shared by @zharp/browser and
 * @zharp/node.
 *
 * Off unless the application turns it on. When it is on, bodies are:
 * - text only (JSON, forms, XML, plain text); binary bodies and event streams are skipped
 * - redacted before they leave the process: values under keys that look secret (`password`,
 *   `token`, `authorization`, `card`, …) become `[Filtered]`, plus any keys the app adds
 * - capped (8 KB by default), with `http.*.body.truncated` set when they were cut
 *
 * They travel as the span attributes `http.request.body` and `http.response.body`, which the
 * trace view shows as a formatted payload.
 */

export type BodyMode = 'errors' | 'all';

export interface CaptureBodiesOptions {
  /** `errors` (default): only requests that failed (status 400 and above, or no response). `all`: every request. */
  mode?: BodyMode;
  /** Characters kept per body. Default 8192, at most 16384. */
  maxSize?: number;
  /**
   * More keys whose values are replaced with `[Filtered]`, on top of the built-in ones. A string
   * matches a key ignoring case, `-` and `_` (`"accountNumber"` also covers `account_number`); a
   * RegExp is tested against the key as it is.
   */
  redactKeys?: Array<string | RegExp>;
  /**
   * Which requests have their bodies captured. A bare host (`api.example.com`) matches that
   * host; a string with a scheme matches URLs starting with it; a RegExp is tested against the
   * full URL. Browser default: same-origin requests and `tracingOrigins` — your own APIs, never
   * third parties. Node default: every request.
   */
  urls?: Array<string | RegExp>;
}

/** `true` is `'errors'`. */
export type CaptureBodies = boolean | BodyMode | CaptureBodiesOptions;

export interface BodySettings {
  mode: BodyMode;
  maxSize: number;
  extraKeys: Array<string | RegExp>;
  urls?: Array<string | RegExp>;
}

export const DEFAULT_MAX_BODY = 8192;
const MAX_BODY = 16384;
export const FILTERED = '[Filtered]';

export const BODY_ATTRIBUTES = {
  request: 'http.request.body',
  requestTruncated: 'http.request.body.truncated',
  requestType: 'http.request.header.content-type',
  response: 'http.response.body',
  responseTruncated: 'http.response.body.truncated',
  responseType: 'http.response.header.content-type',
} as const;

/** The setting as one shape, or null when bodies are off. `env` is `ZHARP_CAPTURE_BODIES` (`errors`, `all`, `off`). */
export function bodySettings(option: CaptureBodies | undefined, env?: string): BodySettings | null {
  let value: CaptureBodies | undefined = option;
  if (value === undefined && env) {
    const e = env.trim().toLowerCase();
    if (e === 'errors' || e === 'all') value = e;
    else if (/^(true|1|yes|on)$/.test(e)) value = true;
  }
  if (!value) return null;
  const o: CaptureBodiesOptions = value === true ? {} : typeof value === 'string' ? { mode: value } : value;
  const size = typeof o.maxSize === 'number' && o.maxSize > 0 ? Math.min(Math.floor(o.maxSize), MAX_BODY) : DEFAULT_MAX_BODY;
  return { mode: o.mode === 'all' ? 'all' : 'errors', maxSize: size, extraKeys: o.redactKeys ?? [], urls: o.urls };
}

/** Whether a request with this outcome has its bodies kept. `status` 0 means no response. */
export function wanted(settings: BodySettings, status: number): boolean {
  return settings.mode === 'all' || !status || status >= 400;
}

// ── content types ─────────────────────────────────────────────────────────────

/** Whether a body of this type is text worth showing. An unknown type is given the benefit of the doubt. */
export function isTextual(contentType: string | null | undefined): boolean {
  if (!contentType) return true;
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (type === 'text/event-stream') return false;
  return (
    type.startsWith('text/') ||
    type.endsWith('+json') ||
    type.endsWith('+xml') ||
    /^application\/(json|xml|x-www-form-urlencoded|graphql|javascript|x-ndjson|ld\+json)$/.test(type)
  );
}

function isForm(contentType: string | null | undefined): boolean {
  return !!contentType && contentType.toLowerCase().includes('application/x-www-form-urlencoded');
}

// ── redaction ─────────────────────────────────────────────────────────────────

/** Built-in keys whose values never leave the process, compared without case, `-` or `_`. */
const CONTAINS = [
  'password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'accesskey', 'privatekey',
  'authorization', 'cookie', 'creditcard', 'cardnumber', 'cvv', 'cvc', 'ssn', 'iban', 'sessionid',
];
const EXACT = ['auth', 'pin', 'otp', 'card', 'pan', 'jwt', 'sid', 'codeverifier'];

const normalize = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

export function isSecretKey(key: string, extra: Array<string | RegExp>): boolean {
  const k = normalize(key);
  if (!k) return false;
  if (EXACT.includes(k) || CONTAINS.some((c) => k.includes(c))) return true;
  return extra.some((p) => (p instanceof RegExp ? p.test(key) : normalize(p) === k));
}

function redactValue(value: unknown, extra: Array<string | RegExp>, depth = 0): unknown {
  if (depth > 20 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, extra, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretKey(k, extra) && v !== null && v !== '' ? FILTERED : redactValue(v, extra, depth + 1);
  }
  return out;
}

/**
 * Text that did not parse (cut-off JSON, a body that only looks like JSON): `"key": value`
 * pairs under secret keys are filtered where they appear.
 */
function redactLoose(text: string, extra: Array<string | RegExp>): string {
  return text.replace(
    /("([^"\\]{1,100})"\s*:\s*)("(?:[^"\\]|\\.)*"?|-?\d[\d.eE+-]*|true|false)/g,
    (match, prefix: string, key: string) => (isSecretKey(key, extra) ? `${prefix}"${FILTERED}"` : match),
  );
}

function redactForm(text: string, extra: Array<string | RegExp>): string {
  return text
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      let key = pair.slice(0, eq);
      try {
        key = decodeURIComponent(key.replace(/\+/g, ' '));
      } catch {}
      return isSecretKey(key, extra) ? `${pair.slice(0, eq)}=${encodeURIComponent(FILTERED)}` : pair;
    })
    .join('&');
}

// ── the attribute value ───────────────────────────────────────────────────────

/**
 * A body as it is sent: redacted, then cut to `maxSize`. `cut` says the text was already cut
 * short where it was read. Null for an empty body.
 */
export function formatBody(
  text: string | null | undefined,
  contentType: string | null | undefined,
  settings: BodySettings,
  cut = false,
): { value: string; truncated: boolean } | null {
  if (text == null) return null;
  let body = String(text);
  if (!body.trim()) return null;

  if (isForm(contentType)) body = redactForm(body, settings.extraKeys);
  else {
    let parsed: unknown;
    let ok = false;
    const trimmed = body.trim();
    if (!cut && (trimmed[0] === '{' || trimmed[0] === '[')) {
      try {
        parsed = JSON.parse(trimmed);
        ok = true;
      } catch {}
    }
    body = ok ? JSON.stringify(redactValue(parsed, settings.extraKeys)) : redactLoose(body, settings.extraKeys);
  }

  const truncated = cut || body.length > settings.maxSize;
  return { value: body.length > settings.maxSize ? body.slice(0, settings.maxSize) : body, truncated };
}

/** The span attributes for one side of a request (`request` or `response`). */
export function bodyAttributes(
  side: 'request' | 'response',
  text: string | null | undefined,
  contentType: string | null | undefined,
  settings: BodySettings,
  cut = false,
): Record<string, unknown> {
  if (!isTextual(contentType)) return {};
  const formatted = formatBody(text, contentType, settings, cut);
  if (!formatted) return {};
  const attributes: Record<string, unknown> = { [BODY_ATTRIBUTES[side]]: formatted.value };
  if (formatted.truncated) attributes[side === 'request' ? BODY_ATTRIBUTES.requestTruncated : BODY_ATTRIBUTES.responseTruncated] = true;
  if (contentType) attributes[side === 'request' ? BODY_ATTRIBUTES.requestType : BODY_ATTRIBUTES.responseType] = contentType;
  return attributes;
}

/**
 * Whether `url` matches one of `patterns`: a bare host (with or without a port) matches that
 * host; a string with a scheme matches as a prefix; a RegExp is tested against the URL.
 */
export function urlMatches(url: string, patterns: Array<string | RegExp>): boolean {
  let host = '';
  let hostname = '';
  try {
    const parsed = new URL(url);
    host = parsed.host;
    hostname = parsed.hostname;
  } catch {}
  return patterns.some((p) => {
    if (p instanceof RegExp) return p.test(url);
    if (!p) return false;
    if (p.includes('://')) return url.startsWith(p);
    return host === p || hostname === p;
  });
}
