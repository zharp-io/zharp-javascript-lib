/**
 * Request and response bodies on HTTP spans (`captureBodies`), shared by @zharp/browser and
 * @zharp/node, and secrets in URLs.
 *
 * Off unless the application turns it on. When it is on, bodies are:
 * - redacted before they leave the process: field names stay, values under keys that look secret
 *   (`password`, `token`, `authorization`, `card`, …) become `[Filtered]`, plus any keys the app adds
 * - kept readable: an inline image or other long base64 value becomes `[image/png · 24 KB]`, a
 *   file in a form upload `[file photo.png · image/png · 240 KB]`, and a body that is not text
 *   at all (an image, a PDF, an event stream) a one-line description of it
 * - capped (32 KB by default), with `http.*.body.truncated` set when they were cut
 *
 * They travel as the span attributes `http.request.body` and `http.response.body`, which the
 * trace view shows as a formatted payload.
 */

export type BodyMode = 'errors' | 'all';

export interface CaptureBodiesOptions {
  /** `errors` (default): only requests that failed (status 400 and above, or no response). `all`: every request. */
  mode?: BodyMode;
  /** Characters kept per body. Default 32768 (32 KB), at most 131072 (128 KB). */
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

export const DEFAULT_MAX_BODY = 32 * 1024;
export const MAX_BODY = 128 * 1024;
export const FILTERED = '[Filtered]';

/** Raw text read before shortening and capping: inline images shrink to a few words, so more is read than is kept. */
export function rawLimit(settings: BodySettings): number {
  return Math.max(64 * 1024, settings.maxSize * 2);
}

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

const mime = (contentType: string | null | undefined) => (contentType ?? '').split(';')[0].trim().toLowerCase();

export function isEventStream(contentType: string | null | undefined): boolean {
  return mime(contentType) === 'text/event-stream';
}

export function isMultipart(contentType: string | null | undefined): boolean {
  return mime(contentType) === 'multipart/form-data';
}

/** Whether a body of this type is text worth showing. An unknown type is given the benefit of the doubt. */
export function isTextual(contentType: string | null | undefined): boolean {
  const type = mime(contentType);
  if (!type) return true;
  if (type === 'text/event-stream') return false;
  return (
    type.startsWith('text/') ||
    type.endsWith('+json') ||
    type.endsWith('+xml') ||
    /^application\/(json|xml|x-www-form-urlencoded|graphql|javascript|x-ndjson|ld\+json)$/.test(type)
  );
}

function isForm(contentType: string | null | undefined): boolean {
  return mime(contentType) === 'application/x-www-form-urlencoded';
}

/** `240 KB`, `1.4 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** How a file in a form upload is shown: `[file photo.png · image/png · 240 KB]`. */
export function fileLabel(name: string | undefined, type: string | undefined, size: number | undefined, partial = false): string {
  const parts = [`file ${name || 'blob'}`];
  if (type) parts.push(type);
  if (size !== undefined) parts.push(formatSize(size) + (partial ? '+' : ''));
  return `[${parts.join(' · ')}]`;
}

/** What a body that is not text says instead: `[binary · image/png · 24 KB]`, `[event stream]`. */
export function describeBody(contentType: string | null | undefined, size?: number, partial = false): string {
  if (isEventStream(contentType)) return '[event stream]';
  const parts = ['binary'];
  const type = mime(contentType);
  if (type) parts.push(type);
  if (size !== undefined && size > 0) parts.push(formatSize(size) + (partial ? '+' : ''));
  return `[${parts.join(' · ')}]`;
}

// ── redaction ─────────────────────────────────────────────────────────────────

/** Built-in keys whose values never leave the process, compared without case, `-` or `_`. */
const CONTAINS = [
  'password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'accesskey', 'privatekey',
  'authorization', 'cookie', 'creditcard', 'cardnumber', 'cvv', 'cvc', 'ssn', 'iban', 'sessionid',
  'signature', 'credential',
];
const EXACT = ['auth', 'pin', 'otp', 'card', 'pan', 'jwt', 'sid', 'codeverifier'];
/** Also secret in a query string, where they are API keys and signed-URL signatures. */
const URL_EXACT = ['key', 'sig', 'code', 'state'];

const normalize = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

export function isSecretKey(key: string, extra: Array<string | RegExp> = []): boolean {
  const k = normalize(key);
  if (!k) return false;
  if (EXACT.includes(k) || CONTAINS.some((c) => k.includes(c))) return true;
  return extra.some((p) => (p instanceof RegExp ? p.test(key) : normalize(p) === k));
}

const DATA_URI = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w=.+-]+)*;base64,([A-Za-z0-9+/=\s]*)$/;
const BASE64 = /^[A-Za-z0-9+/_-]{256,}={0,2}$/;

/** A long base64 value as a short description; other strings as they are. */
function shorten(value: string): string {
  if (value.length < 256) return value;
  const uri = DATA_URI.exec(value);
  if (uri) return `[${uri[1] || 'data'} · ${formatSize(Math.floor((uri[2].length * 3) / 4))}]`;
  if (BASE64.test(value) && /[0-9+/]/.test(value)) return `[base64 · ${formatSize(Math.floor((value.length * 3) / 4))}]`;
  return value;
}

/** Every value under `value` filtered, its keys kept: `{ brand: "[Filtered]", last4: "[Filtered]" }`. */
function filterAll(value: unknown, depth: number): unknown {
  if (depth > 20) return FILTERED;
  if (value === null || value === '') return value;
  if (Array.isArray(value)) return value.map((v) => filterAll(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = filterAll(v, depth + 1);
    return out;
  }
  return FILTERED;
}

export function redactValue(value: unknown, extra: Array<string | RegExp>, depth = 0): unknown {
  if (typeof value === 'string') return shorten(value);
  if (depth > 20 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, extra, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretKey(k, extra) ? filterAll(v, depth + 1) : redactValue(v, extra, depth + 1);
  }
  return out;
}

/**
 * Text that did not parse (cut-off JSON, a body that only looks like JSON): `"key": value`
 * pairs under secret keys are filtered where they appear, and long base64 runs shortened.
 */
function redactLoose(text: string, extra: Array<string | RegExp>): string {
  // A quoted run of base64 (an inline image), possibly cut off before its closing quote.
  const runs = /"((?:data:[\w.+-]+\/[\w.+-]+(?:;[\w=.+-]+)*;base64,)?[A-Za-z0-9+/_=-]{256,})("?)/g;
  return text
    .replace(runs, (match, run: string, close: string) => {
      const short = shorten(run);
      if (short === run) return match;
      return close ? `"${short}"` : `"${short.slice(0, -1)}+]"`;
    })
    .replace(
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
      if (isSecretKey(key, extra)) return `${pair.slice(0, eq)}=${FILTERED}`;
      const value = pair.slice(eq + 1);
      return value.length >= 256 ? `${pair.slice(0, eq)}=${shortenEncoded(value)}` : pair;
    })
    .join('&');
}

function shortenEncoded(value: string): string {
  try {
    const decoded = decodeURIComponent(value.replace(/\+/g, ' '));
    const short = shorten(decoded);
    return short === decoded ? value : short;
  } catch {
    return value;
  }
}

// ── the attribute value ───────────────────────────────────────────────────────

/**
 * A body as it is sent: redacted, then cut to `maxSize`. `cut` says the text was already cut
 * short where it was read. Null for an empty body. A `multipart/form-data` body is passed as the
 * JSON of its fields (files already described).
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

function typeKey(side: 'request' | 'response') {
  return side === 'request' ? BODY_ATTRIBUTES.requestType : BODY_ATTRIBUTES.responseType;
}

/**
 * The span attributes for one side of a request (`request` or `response`). A body that is not
 * text is described (`size` in bytes when known) instead of left out.
 */
export function bodyAttributes(
  side: 'request' | 'response',
  text: string | null | undefined,
  contentType: string | null | undefined,
  settings: BodySettings,
  cut = false,
): Record<string, unknown> {
  if (!isTextual(contentType) && !isMultipart(contentType)) return {};
  const formatted = formatBody(text, contentType, settings, cut);
  if (!formatted) return {};
  const attributes: Record<string, unknown> = { [BODY_ATTRIBUTES[side]]: formatted.value };
  if (formatted.truncated) attributes[side === 'request' ? BODY_ATTRIBUTES.requestTruncated : BODY_ATTRIBUTES.responseTruncated] = true;
  if (contentType) attributes[typeKey(side)] = contentType;
  return attributes;
}

/** The attributes for a body that is not text: what it was, not what it said. */
export function describedAttributes(side: 'request' | 'response', contentType: string | null | undefined, size?: number, partial = false): Record<string, unknown> {
  const attributes: Record<string, unknown> = { [BODY_ATTRIBUTES[side]]: describeBody(contentType, size, partial) };
  if (contentType) attributes[typeKey(side)] = contentType;
  return attributes;
}

// ── URLs ──────────────────────────────────────────────────────────────────────

/**
 * A URL as it is recorded: query values under secret-looking keys (`token`, `key`, `sig`,
 * `password`, …) become `[Filtered]`, and `user:password@` is dropped. Anything that is not
 * a URL is returned as it is.
 */
export function redactUrl(url: string, extra: Array<string | RegExp> = []): string {
  if (!url) return url;
  let out = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1');
  const q = out.indexOf('?');
  if (q < 0) return out;
  const hash = out.indexOf('#', q);
  const query = out.slice(q + 1, hash < 0 ? undefined : hash);
  const redacted = redactQuery(query, extra);
  if (redacted !== query) out = out.slice(0, q + 1) + redacted + (hash < 0 ? '' : out.slice(hash));
  return out;
}

/** A query string (without `?`) with secret-looking values filtered. */
export function redactQuery(query: string, extra: Array<string | RegExp> = []): string {
  if (!query) return query;
  return query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      let key = pair.slice(0, eq);
      try {
        key = decodeURIComponent(key.replace(/\+/g, ' '));
      } catch {}
      const secret = isSecretKey(key, extra) || URL_EXACT.includes(normalize(key));
      return secret && eq < pair.length - 1 ? `${pair.slice(0, eq)}=${FILTERED}` : pair;
    })
    .join('&');
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
