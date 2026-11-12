/**
 * CLIENT spans for `fetch` and `XMLHttpRequest`, and the headers that carry the trace on.
 *
 * Only same-origin requests and those matching `tracingOrigins` get `traceparent` and
 * `baggage`: an unexpected header on a third-party request turns it into a CORS preflight the
 * third party may refuse. Every request still gets a span; the SDK's own requests get neither.
 */
import { bodyAttributes, describedAttributes, fileLabel, isTextual, rawLimit, redactUrl, wanted, type BodySettings } from '@zharp/internal/bodies';
import { Kind, Status, type Span, type Tracer } from '../tracing';
import { now, safely } from '../util';

export interface HttpHooks {
  tracer: Tracer;
  /** Whether a URL is traced at all (not the SDK's own endpoint, not ignored). */
  shouldTrace(url: string): boolean;
  /** Whether a URL gets the trace headers. */
  shouldPropagate(url: string): boolean;
  /** `baggage` entries: the session and user. */
  baggage(): string;
  /** `captureBodies`, or null when it is off. */
  bodies: BodySettings | null;
  /** Whether a URL's bodies may be captured (the app's own APIs unless `captureBodies.urls` says otherwise). */
  shouldCaptureBodies(url: string): boolean;
}

/** How long a span waits for its response body to be read before it is sent without it. */
const BODY_WAIT_MS = 3000;

/** Reads the request and response bodies, once the status says they are wanted. */
type BodyReader = (status: number) => Promise<Record<string, unknown>> | Record<string, unknown> | undefined;

/** The span for one request, and the root spans waiting for it. */
function begin(hooks: HttpHooks, method: string, url: string): { span: Span; done: (status: number, error?: unknown, bodies?: BodyReader) => void } {
  const { parent, waiters } = hooks.tracer.requestStarting();
  const full = absolute(url);
  const span = hooks.tracer.startSpan(`${method} ${pathOf(full)}`, Kind.Client, parent);
  span.setAttributes({ 'http.request.method': method, 'url.full': redactUrl(full), 'server.address': hostOf(full) });
  for (const waiter of waiters) waiter.begin();
  return {
    span,
    done(status, error, bodies) {
      const end = now();
      if (status) span.setAttribute('http.response.status_code', status);
      if (error !== undefined || !status) {
        span.setAttribute('error.type', error instanceof Error ? error.name : 'network');
        span.setStatus(Status.Error, error instanceof Error ? error.message : 'Request failed');
      } else if (status >= 400) {
        span.setAttribute('error.type', String(status));
        span.setStatus(Status.Error, `HTTP ${status}`);
      }
      for (const waiter of waiters) waiter.done();

      // The span keeps the time the response arrived; reading its body only delays sending it.
      const read = bodies && safely(() => bodies(status));
      if (!read || typeof (read as Promise<unknown>).then !== 'function') {
        if (read) span.setAttributes(read as Record<string, unknown>);
        span.end(end);
        return;
      }
      const timer = setTimeout(() => span.end(end), BODY_WAIT_MS);
      (read as Promise<Record<string, unknown>>).then(
        (attributes) => {
          clearTimeout(timer);
          if (!span.ended) span.setAttributes(attributes);
          span.end(end);
        },
        () => {
          clearTimeout(timer);
          span.end(end);
        },
      );
    },
  };
}

// ── bodies ────────────────────────────────────────────────────────────────────

type Attrs = Record<string, unknown>;

/**
 * The request body's attributes. Text is kept (redacted); a form upload is shown as its fields
 * with each file described; anything else is described by type and size. Streams are never
 * read, and the caller's own body is never consumed.
 */
function requestAttributes(body: unknown, contentType: string | null, settings: BodySettings): Attrs | Promise<Attrs> {
  if (body == null) return {};
  const text = (t: string, type: string | null, cut = false): Attrs =>
    isTextual(type) ? bodyAttributes('request', t, type, settings, cut) : describedAttributes('request', type, t.length);
  if (typeof body === 'string') return text(body, contentType);
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return text(body.toString(), 'application/x-www-form-urlencoded');
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const fields: Record<string, unknown> = {};
    body.forEach((value, key) => {
      const shown = typeof value === 'string' ? value : fileLabel((value as File).name, (value as File).type || undefined, (value as File).size);
      const existing = fields[key];
      fields[key] = existing === undefined ? shown : Array.isArray(existing) ? [...existing, shown] : [existing, shown];
    });
    return bodyAttributes('request', JSON.stringify(fields), 'multipart/form-data', settings);
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    const type = body.type || contentType;
    if (!isTextual(type)) return describedAttributes('request', type, body.size);
    const limit = rawLimit(settings);
    return body.slice(0, limit).text().then((t) => text(t, type, body.size > limit), () => ({}));
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const size = (body as ArrayBuffer).byteLength;
    if (!contentType || !isTextual(contentType)) return describedAttributes('request', contentType, size);
    return text(new TextDecoder().decode(body as ArrayBuffer), contentType);
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return describedAttributes('request', contentType);
  return {};
}

/** Up to `limit` characters of a response copy; the rest is cancelled, never downloaded twice. */
async function readLimited(response: Response, limit: number): Promise<{ text: string; cut: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return { text: text.slice(0, limit), cut: text.length > limit };
  }
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > limit) {
      reader.cancel().catch(() => {});
      return { text: text.slice(0, limit), cut: true };
    }
  }
  return { text: text + decoder.decode(), cut: false };
}

/** The content type the browser gives a body the caller sent without one. */
function implicitType(body: unknown): string | null {
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return 'application/x-www-form-urlencoded';
  if (typeof FormData !== 'undefined' && body instanceof FormData) return 'multipart/form-data';
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.type || null;
  return null;
}

const contentLength = (headers: Headers | undefined): number | undefined => {
  const n = Number(headers?.get('content-length'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

function headerOf(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  return safely(() => new Headers(headers).get(name)) ?? null;
}

/** `baggage` merged with any the caller already set. */
function mergeBaggage(existing: string | null | undefined, ours: string): string {
  return existing ? `${existing},${ours}` : ours;
}

export function instrumentFetch(hooks: HttpHooks): () => void {
  const g = globalThis as any;
  const original = g.fetch;
  if (typeof original !== 'function' || original.__zharp) return () => {};

  const patched = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request)?.url;
    if (!url || !hooks.shouldTrace(url)) return original.call(this, input, init);

    const method = String(init?.method ?? (input as Request)?.method ?? 'GET').toUpperCase();
    const request = safely(() => begin(hooks, method, url));
    if (!request) return original.call(this, input, init);

    // Bodies: what is needed to read them later is set aside now, before fetch consumes anything.
    const bodies = hooks.bodies && hooks.shouldCaptureBodies(url) ? hooks.bodies : null;
    let sent: (() => Attrs | Promise<Attrs>) | undefined;
    let sentType: string | null = null;
    if (bodies) {
      safely(() => {
        const isRequest = typeof Request !== 'undefined' && input instanceof Request;
        sentType = headerOf(init?.headers, 'content-type') ?? (isRequest ? (input as Request).headers.get('content-type') : null);
        if (init?.body != null) {
          const body = init.body;
          sentType = (body instanceof FormData ? null : sentType) ?? implicitType(body);
          sent = () => requestAttributes(body, sentType, bodies);
        } else if (isRequest && (input as Request).body) {
          const type = sentType;
          if (isTextual(type)) {
            const copy = (input as Request).clone();
            sent = () => copy.text().then((t) => requestAttributes(t, type, bodies));
          } else {
            sent = () => describedAttributes('request', type, contentLength((input as Request).headers));
          }
        }
      });
    }

    let nextInit = init;
    if (hooks.shouldPropagate(url)) {
      nextInit = safely(() => {
        const headers = new Headers(init?.headers ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined));
        // A traceparent the caller set is a trace they are deliberately continuing.
        if (!headers.has('traceparent')) headers.set('traceparent', request.span.traceparent);
        const baggage = hooks.baggage();
        if (baggage) headers.set('baggage', mergeBaggage(headers.get('baggage'), baggage));
        return { ...init, headers };
      }) ?? init;
    }

    const readBodies = (response?: Response): BodyReader | undefined =>
      bodies
        ? (status) => {
            if (!wanted(bodies, status)) return undefined;
            const responseType = response?.headers.get('content-type') ?? null;
            const hasBody = !!response?.body && response.status !== 204 && response.status !== 304;
            // Copied now, before the caller reads it; text only. Anything else (an image, an event
            // stream) is described, never read.
            const copy = hasBody && isTextual(responseType) ? safely(() => response!.clone()) : undefined;
            return (async () => {
              const attributes: Attrs = {};
              Object.assign(attributes, (await Promise.resolve(sent?.()).catch(() => undefined)) ?? {});
              if (copy) {
                const read = await readLimited(copy, rawLimit(bodies)).catch(() => null);
                if (read) Object.assign(attributes, bodyAttributes('response', read.text, responseType, bodies, read.cut));
              } else if (hasBody && response) {
                Object.assign(attributes, describedAttributes('response', responseType, contentLength(response.headers)));
              }
              return attributes;
            })();
          }
        : undefined;

    return original.call(this, input, nextInit).then(
      (response: Response) => {
        safely(() => request.done(response.status, undefined, readBodies(response)));
        return response;
      },
      (error: unknown) => {
        safely(() => request.done(0, error, readBodies()));
        throw error;
      },
    );
  };
  patched.__zharp = true;
  g.fetch = patched;
  return () => {
    if (g.fetch === patched) g.fetch = original;
  };
}

export function instrumentXhr(hooks: HttpHooks): () => void {
  if (typeof XMLHttpRequest === 'undefined') return () => {};
  const proto = XMLHttpRequest.prototype as any;
  if (proto.__zharp) return () => {};
  const { open, send, setRequestHeader } = proto;

  proto.open = function (method: string, url: string | URL, ...rest: unknown[]) {
    this.__zharp = { method: String(method || 'GET').toUpperCase(), url: String(url), traceparent: false, baggage: null };
    return open.call(this, method, url, ...rest);
  };

  proto.setRequestHeader = function (name: string, value: string) {
    const state = this.__zharp;
    const lower = String(name).toLowerCase();
    // XHR headers cannot be read back, so what the caller sets is noted as it is set.
    if (state && lower === 'traceparent') state.traceparent = true;
    if (state && lower === 'content-type') state.contentType = String(value);
    if (state && lower === 'baggage' && !state.own) {
      state.baggage = value;
      return; // sent merged with ours in send()
    }
    return setRequestHeader.call(this, name, value);
  };

  proto.send = function (body?: unknown) {
    const state = this.__zharp;
    if (!state || !hooks.shouldTrace(state.url)) return send.call(this, body);
    const request = safely(() => begin(hooks, state.method, state.url));
    if (request) {
      safely(() => {
        if (hooks.shouldPropagate(state.url)) {
          state.own = true;
          if (!state.traceparent) setRequestHeader.call(this, 'traceparent', request.span.traceparent);
          const baggage = hooks.baggage();
          if (baggage || state.baggage) setRequestHeader.call(this, 'baggage', baggage ? mergeBaggage(state.baggage, baggage) : state.baggage);
        } else if (state.baggage) {
          setRequestHeader.call(this, 'baggage', state.baggage);
        }
      });
      const bodies = hooks.bodies && hooks.shouldCaptureBodies(state.url) ? hooks.bodies : null;
      const xhr = this as XMLHttpRequest;
      const reader: BodyReader | undefined = bodies
        ? (status) => {
            if (!wanted(bodies, status)) return undefined;
            const sentType: string | null = (body instanceof FormData ? null : state.contentType) ?? implicitType(body);
            const responseType = safely(() => xhr.getResponseHeader('content-type')) ?? null;
            const attributes: Attrs =
              safely(() => {
                const kind = xhr.responseType;
                const response = xhr.response;
                if (response == null || response === '') return {};
                if (kind === 'blob') return describedAttributes('response', responseType, (response as Blob).size);
                if (kind === 'arraybuffer') return describedAttributes('response', responseType, (response as ArrayBuffer).byteLength);
                if (kind === 'document') return {};
                const text = kind === 'json' ? JSON.stringify(response) : xhr.responseText;
                const limit = rawLimit(bodies);
                if (!isTextual(responseType)) return describedAttributes('response', responseType, text.length);
                return bodyAttributes('response', text.slice(0, limit), responseType, bodies, text.length > limit);
              }) ?? {};
            const sentAttributes = requestAttributes(body, sentType, bodies);
            if (sentAttributes && typeof (sentAttributes as Promise<Attrs>).then === 'function') {
              return (sentAttributes as Promise<Attrs>).then((a) => ({ ...attributes, ...a }), () => attributes);
            }
            return { ...attributes, ...(sentAttributes as Attrs) };
          }
        : undefined;
      this.addEventListener('loadend', () => safely(() => request.done(this.status, undefined, reader)));
    } else if (state.baggage) {
      safely(() => setRequestHeader.call(this, 'baggage', state.baggage));
    }
    return send.call(this, body);
  };
  proto.__zharp = true;

  return () => {
    Object.assign(proto, { open, send, setRequestHeader });
    delete proto.__zharp;
  };
}

// ── URLs ──────────────────────────────────────────────────────────────────────

const base = () => (typeof location !== 'undefined' ? location.href : 'http://localhost/');

export function absolute(url: string): string {
  return safely(() => new URL(url, base()).href) ?? url;
}

function pathOf(url: string): string {
  return safely(() => new URL(url).pathname) ?? url.split('?')[0];
}

function hostOf(url: string): string {
  return safely(() => new URL(url).hostname) ?? '';
}

/**
 * Whether `url` matches one of `patterns`: a bare host (`api.example.com`, with or without a
 * port) matches that host; a string with a scheme matches as a prefix; a RegExp is tested.
 */
export function matches(url: string, patterns: Array<string | RegExp>): boolean {
  const parsed = safely(() => new URL(url, base()));
  if (!parsed) return false;
  return patterns.some((pattern) => {
    if (pattern instanceof RegExp) return pattern.test(parsed.href);
    if (!pattern) return false;
    if (pattern.includes('://')) return parsed.href.startsWith(pattern);
    return parsed.host === pattern || parsed.hostname === pattern;
  });
}

export function sameOrigin(url: string): boolean {
  return safely(() => typeof location !== 'undefined' && new URL(url, base()).origin === location.origin) ?? false;
}
