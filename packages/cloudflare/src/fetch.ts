/**
 * Outgoing requests: a CLIENT span per `fetch`, with `traceparent` added so the next service
 * continues the trace — the browser → Worker → origin API reads as one. The same for service
 * bindings and Durable Object stubs (`env.API.fetch(…)`, `stub.fetch(…)`), which carry it to the
 * next Worker. Only inside a request: `fetch` at startup is left alone, and Zharp's own requests
 * use the fetch from before this ran.
 */
import { headerAttributes } from '@zharp/internal/headers';
import { redactUrl } from '@zharp/internal/bodies';
import { matches } from '../../browser/src/instrument/http';
import { safely } from '../../browser/src/util';
import { activeContext, formatTraceparent, requestOf, SpanKind, SpanStatusCode, startSpan, withSpan } from './tracing';
import type { Runtime } from './state';

let installed = false;

export function instrumentGlobalFetch(runtime: Runtime): void {
  if (installed || typeof globalThis.fetch !== 'function') return;
  installed = true;
  const original = globalThis.fetch;
  const patched = function fetch(input: RequestInfo | URL, init?: RequestInit) {
    return tracedFetch(runtime, original, globalThis, input, init, undefined);
  };
  (patched as any).__zharp = true;
  globalThis.fetch = patched as typeof fetch;
}

/**
 * Send a request through `send` in a CLIENT span. `binding` names a service binding or Durable
 * Object the request goes to instead of the network.
 */
export function tracedFetch(
  runtime: Runtime,
  send: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  thisArg: unknown,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  binding: { name: string; type: string } | undefined,
): Promise<Response> {
  const ctx = activeContext();
  if (!requestOf(ctx) || !runtime.settings.tracing) return send.call(thisArg, input, init);
  let request: Request;
  try {
    request = new Request(input as RequestInfo, init);
  } catch {
    return send.call(thisArg, input, init);
  }
  const url = safely(() => new URL(request.url));
  if (!binding && (!url || request.url.startsWith(runtime.settings.endpoint) || matches(request.url, runtime.settings.ignoreUrls))) {
    return send.call(thisArg, request);
  }

  const method = request.method.toUpperCase();
  const span = startSpan(binding ? `${method} ${binding.name}` : `${method} ${url?.host ?? ''}`.trim(), {
    kind: SpanKind.CLIENT,
    attributes: {
      'http.request.method': method,
      'url.full': redactUrl(request.url),
      'server.address': binding ? undefined : url?.hostname,
      'server.port': binding || !url?.port ? undefined : Number(url.port),
      ...(binding ? { 'cloudflare.binding.name': binding.name, 'cloudflare.binding.type': binding.type } : {}),
    },
  }, ctx);
  if (!request.headers.has('traceparent')) safely(() => request.headers.set('traceparent', formatTraceparent(span.spanContext())));
  if (runtime.headers) span.setAttributes(headerAttributes('request', request.headers, runtime.headers));

  return withSpan(span, () => send.call(thisArg, request), ctx).then(
    (response) => {
      safely(() => {
        span.setAttribute('http.response.status_code', response.status);
        if (runtime.headers) span.setAttributes(headerAttributes('response', response.headers, runtime.headers));
        if (response.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${response.status}` });
        span.end();
      });
      return response;
    },
    (error) => {
      safely(() => {
        span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error)?.message ?? String(error) });
        span.setAttribute('error.type', (error as Error)?.name || 'Error');
        span.end();
      });
      throw error;
    },
  );
}
