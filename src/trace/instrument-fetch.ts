import { Tracer } from './tracer';
import { fromTraceparent, toTraceparent } from './context';
import { Span } from './span';
import { addBreadcrumb } from './breadcrumbs';

/**
 * Traces outgoing `fetch` and `XMLHttpRequest` calls.
 *
 * `fetch` exists in browsers and in Node 18+, so this one patch covers both — a server calling
 * another service and a page calling its own API produce the same shape of span, and, because
 * the `traceparent` header goes with the request, the same trace.
 */

/** Undo function returned by each patch, so `destroy()` can leave the runtime as it found it. */
type Teardown = () => void;

export function instrumentFetch(tracer: Tracer): Teardown {
  const teardowns: Teardown[] = [];

  const patchedFetch = patchFetch(tracer);
  if (patchedFetch) teardowns.push(patchedFetch);

  const patchedXhr = patchXhr(tracer);
  if (patchedXhr) teardowns.push(patchedXhr);

  return () => teardowns.forEach((undo) => undo());
}

function patchFetch(tracer: Tracer): Teardown | null {
  const target: any = typeof globalThis !== 'undefined' ? globalThis : undefined;
  if (!target || typeof target.fetch !== 'function') return null;

  const original = target.fetch;
  // Patching twice would produce two spans per request and two traceparent headers.
  if (original.__zharpPatched) return null;

  const patched = function (this: any, input: any, init?: any): Promise<any> {
    const url = requestUrl(input);
    const method = requestMethod(input, init);

    // The SDK's own reporting calls carry a marker; tracing them would be self-perpetuating.
    if (init?.__zharp || !tracer.shouldTrace(url)) {
      return original.call(this, input, init);
    }

    // A `traceparent` the caller set themselves is an instruction, not an accident: they are
    // continuing a trace that started somewhere this SDK cannot see — another process, a queue
    // job, a header forwarded from an incoming request. Overwriting it would break exactly the
    // link it was added to make, so it becomes this span's parent instead.
    const inherited = fromTraceparent(existingTraceparent(input, init));

    const span = tracer.startSpan(`${method} ${pathOf(url)}`, {
      kind: 'CLIENT',
      parent: inherited ?? undefined,
      attributes: {
        'http.method': method,
        'http.url': url,
      },
    });

    const nextInit = tracer.shouldPropagate(url)
      ? withTraceHeaders(input, init, toTraceparent(span.context))
      : init;

    return original
      .call(this, input, nextInit)
      .then((response: any) => {
        span.setAttribute('http.status_code', response.status);
        // 4xx and 5xx are both failures of the call, whichever side caused them. A trace that
        // marks only 5xx makes a wall of 404s look like a healthy service.
        if (response.status >= 400) {
          span.setStatus('ERROR', `HTTP ${response.status}`);
        } else {
          span.setStatus('OK');
        }
        span.end();
        // The request trail is what turns "it threw" into "it threw after these four calls".
        addBreadcrumb({
          kind: 'request',
          message: `${method} ${pathOf(url)} → ${response.status}`,
          level: response.status >= 400 ? 'error' : 'info',
        });
        return response;
      })
      .catch((error: unknown) => {
        // fetch rejects only when the request never completed — DNS, TLS, connection refused,
        // CORS. The status branch above covers everything that did get a reply.
        span.recordException(error);
        span.setStatus('ERROR', error instanceof Error ? error.message : String(error));
        span.end();
        addBreadcrumb({
          kind: 'request',
          message: `${method} ${pathOf(url)} failed`,
          level: 'error',
        });
        throw error;
      });
  };

  patched.__zharpPatched = true;
  target.fetch = patched;

  return () => {
    target.fetch = original;
  };
}

/**
 * Adds the trace headers without mutating what the caller passed.
 *
 * Init objects are frequently shared or frozen — a default object reused across calls, a config
 * held in a module — so writing into one would leak this request's span ID onto the next.
 */
function withTraceHeaders(input: any, init: any, traceparent: string): any {
  // A Request object carries its own headers, and those are not visible on `init`.
  if (!init && typeof Request !== 'undefined' && input instanceof Request) {
    const headers = new Headers(input.headers);
    headers.set('traceparent', traceparent);
    return { headers };
  }

  const next = { ...(init ?? {}) };
  const existing = next.headers;

  if (typeof Headers !== 'undefined' && existing instanceof Headers) {
    const headers = new Headers(existing);
    headers.set('traceparent', traceparent);
    next.headers = headers;
  } else if (Array.isArray(existing)) {
    next.headers = [...existing, ['traceparent', traceparent]];
  } else {
    next.headers = { ...(existing ?? {}), traceparent };
  }

  return next;
}

function patchXhr(tracer: Tracer): Teardown | null {
  if (typeof XMLHttpRequest === 'undefined') return null;

  const proto = XMLHttpRequest.prototype as any;
  if (proto.__zharpPatched) return null;

  const originalOpen = proto.open;
  const originalSend = proto.send;

  proto.open = function (method: string, url: string, ...rest: any[]) {
    // Stashed rather than traced here: `open` only declares the request, and timing it from
    // here would include however long the caller took to get around to `send`.
    this.__zharpRequest = { method: (method || 'GET').toUpperCase(), url: String(url) };
    // XHR headers are write-only, so a traceparent the caller sets has to be noticed as it is
    // set — by `send` it is no longer readable.
    this.__zharpTraceparent = null;
    return originalOpen.call(this, method, url, ...rest);
  };

  const originalSetRequestHeader = proto.setRequestHeader;
  proto.setRequestHeader = function (name: string, value: string) {
    if (String(name).toLowerCase() === 'traceparent' && !this.__zharpOwnHeader) {
      this.__zharpTraceparent = value;
    }
    return originalSetRequestHeader.call(this, name, value);
  };

  proto.send = function (body?: any) {
    const request = this.__zharpRequest;

    if (!request || !tracer.shouldTrace(request.url)) {
      return originalSend.call(this, body);
    }

    const span: Span = tracer.startSpan(`${request.method} ${pathOf(request.url)}`, {
      kind: 'CLIENT',
      // As with fetch: a traceparent the caller set is a trace they are deliberately continuing.
      parent: fromTraceparent(this.__zharpTraceparent) ?? undefined,
      attributes: {
        'http.method': request.method,
        'http.url': request.url,
      },
    });

    if (tracer.shouldPropagate(request.url)) {
      try {
        // Flagged so the setter patch above does not mistake this SDK's own header for one the
        // caller set, and adopt the span as its own parent.
        this.__zharpOwnHeader = true;
        this.setRequestHeader('traceparent', toTraceparent(span.context));
      } catch {
        // Throws if the request is not in the OPENED state. Not worth failing the request over.
      } finally {
        // Cleared in `finally` so a throw does not leave the flag set, which would make the
        // next caller-set header on this object invisible.
        this.__zharpOwnHeader = false;
      }
    }

    const finish = () => {
      // readyState 4 is DONE, and a network failure reaches it with status 0 rather than
      // throwing — which is why status is checked rather than trusted to be present.
      if (this.readyState !== 4) return;
      if (this.status === 0) {
        span.setStatus('ERROR', 'Request failed before a response was received');
      } else {
        span.setAttribute('http.status_code', this.status);
        span.setStatus(this.status >= 400 ? 'ERROR' : 'OK', this.status >= 400 ? `HTTP ${this.status}` : undefined);
      }
      span.end();
    };

    this.addEventListener('readystatechange', finish);
    return originalSend.call(this, body);
  };

  proto.__zharpPatched = true;

  return () => {
    proto.open = originalOpen;
    proto.send = originalSend;
    proto.setRequestHeader = originalSetRequestHeader;
    delete proto.__zharpPatched;
  };
}

/**
 * Read a `traceparent` the caller already put on the request, wherever they put it.
 *
 * Headers reach fetch in four different shapes, and a caller continuing a trace by hand has no
 * reason to prefer one of them, so all four are checked.
 */
function existingTraceparent(input: any, init: any): string | null {
  const fromInit = readHeader(init?.headers);
  if (fromInit) return fromInit;

  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.headers.get('traceparent');
  }
  return readHeader(input?.headers);
}

function readHeader(headers: any): string | null {
  if (!headers) return null;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get('traceparent');
  }
  if (Array.isArray(headers)) {
    const found = headers.find((pair) => String(pair?.[0]).toLowerCase() === 'traceparent');
    return found ? String(found[1]) : null;
  }
  if (typeof headers === 'object') {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === 'traceparent');
    return key ? String(headers[key]) : null;
  }
  return null;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function requestUrl(input: any): string {
  if (typeof input === 'string') return input;
  if (input && typeof input.url === 'string') return input.url;
  return String(input);
}

function requestMethod(input: any, init?: any): string {
  const method = init?.method ?? (input && typeof input === 'object' ? input.method : undefined);
  return String(method ?? 'GET').toUpperCase();
}

/**
 * The path part of a URL, for the span name.
 *
 * The full URL stays on `http.url`; the name is the path so that the same endpoint groups
 * together in the operations list rather than splitting by host and query string.
 */
function pathOf(url: string): string {
  try {
    const base = typeof window !== 'undefined' ? window.location.href : 'http://localhost';
    return new URL(url, base).pathname || '/';
  } catch {
    return url.split('?')[0] || url;
  }
}
