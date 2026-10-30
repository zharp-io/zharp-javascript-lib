/**
 * CLIENT spans for `fetch` and `XMLHttpRequest`, and the headers that carry the trace on.
 *
 * Only same-origin requests and those matching `tracingOrigins` get `traceparent` and
 * `baggage`: an unexpected header on a third-party request turns it into a CORS preflight the
 * third party may refuse. Every request still gets a span; the SDK's own requests get neither.
 */
import { Kind, Status, type Span, type Tracer } from '../tracing';
import { safely } from '../util';

export interface HttpHooks {
  tracer: Tracer;
  /** Whether a URL is traced at all (not the SDK's own endpoint, not ignored). */
  shouldTrace(url: string): boolean;
  /** Whether a URL gets the trace headers. */
  shouldPropagate(url: string): boolean;
  /** `baggage` entries: the session and user. */
  baggage(): string;
}

/** The span for one request, and the root spans waiting for it. */
function begin(hooks: HttpHooks, method: string, url: string): { span: Span; done: (status: number, error?: unknown) => void } {
  const { parent, waiters } = hooks.tracer.requestStarting();
  const full = absolute(url);
  const span = hooks.tracer.startSpan(`${method} ${pathOf(full)}`, Kind.Client, parent);
  span.setAttributes({ 'http.request.method': method, 'url.full': full, 'server.address': hostOf(full) });
  for (const waiter of waiters) waiter.begin();
  return {
    span,
    done(status, error) {
      if (status) span.setAttribute('http.response.status_code', status);
      if (error !== undefined || !status) {
        span.setAttribute('error.type', error instanceof Error ? error.name : 'network');
        span.setStatus(Status.Error, error instanceof Error ? error.message : 'Request failed');
      } else if (status >= 400) {
        span.setAttribute('error.type', String(status));
        span.setStatus(Status.Error, `HTTP ${status}`);
      }
      span.end();
      for (const waiter of waiters) waiter.done();
    },
  };
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

    return original.call(this, input, nextInit).then(
      (response: Response) => {
        safely(() => request.done(response.status));
        return response;
      },
      (error: unknown) => {
        safely(() => request.done(0, error));
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
      this.addEventListener('loadend', () => safely(() => request.done(this.status)));
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
