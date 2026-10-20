import { Tracer } from './tracer';
import { fromTraceparent, toTraceparent } from './context';
import { loadBuiltin, syncBuiltinExports } from '@zharp/internal/builtins';

/**
 * Traces Node's `http` and `https` modules — both sides of a call.
 *
 * The outgoing side matters because most Node libraries still build on `http.request` rather
 * than `fetch`: database drivers, AWS clients, older HTTP libraries. Patching `fetch` alone
 * would miss them.
 *
 * The incoming side matters more. A server span is what a trace hangs from, and adopting the
 * caller's `traceparent` is what makes a browser click and the request it caused appear as one
 * trace rather than two unrelated ones. Every Node HTTP framework — Express, Fastify, Nest,
 * Koa — is built on `http.Server`, so patching there covers all of them without knowing which
 * one the application uses.
 */

type Teardown = () => void;

export function instrumentNodeHttp(tracer: Tracer): Teardown {
  const modules = loadHttpModules();
  if (!modules) return () => {};

  const teardowns: Teardown[] = [];

  modules.forEach(({ name, module: mod }) => {
    const undoClient = patchClient(tracer, mod, name);
    if (undoClient) teardowns.push(undoClient);
  });

  // Server-side: one patch on the shared prototype covers both http and https servers.
  const undoServer = patchServer(tracer, modules);
  if (undoServer) teardowns.push(undoServer);

  // ES-module code that wrote `import { request } from 'node:http'` holds its own copy of the
  // export; this makes it see the patched one, and later the restored one.
  syncBuiltinExports();

  return () => {
    teardowns.forEach((undo) => undo());
    syncBuiltinExports();
  };
}

/**
 * Load `http` and `https`, or nothing at all in a browser.
 *
 * Through `loadBuiltin`, which works from both builds — the ESM one has no `require`, and used
 * to come back empty here, so native-ESM servers produced no spans at all.
 */
function loadHttpModules(): Array<{ name: string; module: any }> | null {
  const http = loadBuiltin('http');
  if (!http) return null;
  return [
    { name: 'http', module: http },
    { name: 'https', module: loadBuiltin('https') },
  ];
}

// ── outgoing ────────────────────────────────────────────────────────────────

function patchClient(tracer: Tracer, mod: any, protocol: string): Teardown | null {
  if (!mod || mod.__zharpClientPatched) return null;

  const originalRequest = mod.request;
  const originalGet = mod.get;

  const wrap = (original: any) =>
    function (this: any, ...args: any[]) {
      const { options, url } = describeRequest(args, protocol);

      if (!url || !tracer.shouldTrace(url)) {
        return original.apply(this, args);
      }

      const method = String(options?.method ?? 'GET').toUpperCase();
      // A traceparent the caller already put on the request is a trace they are continuing
      // deliberately — from an inbound header they forwarded, or a job they picked up. It
      // becomes this span's parent rather than being overwritten.
      const inherited = fromTraceparent(headerValue(options?.headers, 'traceparent'));

      const span = tracer.startSpan(`${method} ${pathOf(url)}`, {
        kind: 'CLIENT',
        parent: inherited ?? undefined,
        attributes: { 'http.method': method, 'http.url': url },
      });

      if (tracer.shouldPropagate(url)) {
        injectHeader(args, options, toTraceparent(span.context));
      }

      const request = original.apply(this, args);

      request.on('response', (response: any) => {
        span.setAttribute('http.status_code', response.statusCode);
        span.setStatus(
          response.statusCode >= 400 ? 'ERROR' : 'OK',
          response.statusCode >= 400 ? `HTTP ${response.statusCode}` : undefined,
        );
        // The span ends when the body has been consumed, not when the headers arrive: a slow
        // body is slow time, and ending early would hide it.
        response.on('end', () => span.end());
        // A consumer that never reads the body would otherwise leave the span open forever.
        response.on('close', () => span.end());
      });

      request.on('error', (error: Error) => {
        span.recordException(error);
        span.setStatus('ERROR', error.message);
        span.end();
      });

      return request;
    };

  mod.request = wrap(originalRequest);
  // `get` is `request` plus an automatic `end()`, and it calls the module's own `request` — so
  // it is wrapped separately rather than assumed to route through the patch above.
  mod.get = wrap(originalGet);
  mod.__zharpClientPatched = true;

  return () => {
    mod.request = originalRequest;
    mod.get = originalGet;
    delete mod.__zharpClientPatched;
  };
}

/**
 * Work out what URL a call to `http.request` is actually for.
 *
 * Node accepts three shapes — `(options)`, `(url)`, and `(url, options)` — and each puts the
 * pieces somewhere different.
 */
function describeRequest(args: any[], protocol: string): { options: any; url: string | null } {
  const [first, second] = args;

  // request(url, options?, cb?)
  if (typeof first === 'string') {
    const options = typeof second === 'object' && second !== null ? second : {};
    return { options, url: first };
  }
  if (first && typeof first === 'object' && typeof first.href === 'string') {
    const options = typeof second === 'object' && second !== null ? second : {};
    return { options, url: first.href };
  }

  // request(options, cb?)
  if (first && typeof first === 'object') {
    const host = first.hostname ?? first.host;
    if (!host) return { options: first, url: null };
    const scheme = first.protocol ? String(first.protocol).replace(':', '') : protocol;
    const port = first.port ? `:${first.port}` : '';
    return { options: first, url: `${scheme}://${host}${port}${first.path ?? '/'}` };
  }

  return { options: {}, url: null };
}

/**
 * Put the trace header on the outgoing request.
 *
 * When the call is `request(url)` with no options object there is nowhere to write it, so one
 * is inserted — Node accepts `(url, options, cb)`, and the callback, if present, has to stay
 * the last argument.
 */
function injectHeader(args: any[], options: any, traceparent: string): void {
  if (options && typeof options === 'object' && args.indexOf(options) !== -1) {
    options.headers = { ...(options.headers ?? {}), traceparent };
    return;
  }

  const inserted = { headers: { traceparent } };
  if (typeof args[1] === 'function') {
    args.splice(1, 0, inserted);
  } else {
    args[1] = inserted;
  }
}

// ── incoming ────────────────────────────────────────────────────────────────

function patchServer(tracer: Tracer, modules: Array<{ name: string; module: any }>): Teardown | null {
  const http = modules[0]?.module;
  if (!http?.Server || http.Server.prototype.__zharpServerPatched) return null;

  const proto = http.Server.prototype;
  const originalEmit = proto.emit;

  proto.emit = function (this: any, event: string, ...args: any[]) {
    if (event !== 'request') return originalEmit.apply(this, [event, ...args]);

    const [req, res] = args;
    const url = String(req?.url ?? '/');

    if (!tracer.shouldTrace(url)) return originalEmit.apply(this, [event, ...args]);

    // Continue the caller's trace when there is one. Without this, the browser span and the
    // server span it caused are two traces that nothing connects.
    const parent = fromTraceparent(req?.headers?.traceparent);
    const method = String(req?.method ?? 'GET').toUpperCase();

    const span = tracer.startSpan(`${method} ${pathOf(url)}`, {
      kind: 'SERVER',
      parent,
      attributes: {
        'http.method': method,
        'http.target': url,
        'http.host': String(req?.headers?.host ?? ''),
        'http.user_agent': String(req?.headers?.['user-agent'] ?? ''),
      },
    });

    res?.on?.('finish', () => {
      span.setAttribute('http.status_code', res.statusCode);
      // A 4xx is the caller's fault, not the server's — recording it as a server error would
      // make every bad request look like an outage. Only 5xx marks the span failed.
      span.setStatus(res.statusCode >= 500 ? 'ERROR' : 'OK', res.statusCode >= 500 ? `HTTP ${res.statusCode}` : undefined);
      span.end();
    });
    // A connection dropped mid-response never fires `finish`.
    res?.on?.('close', () => {
      if (!span.isEnded) {
        span.setStatus('ERROR', 'Connection closed before the response completed');
        span.end();
      }
    });

    // Everything the handler does — and everything it awaits — runs inside this span, so
    // database calls and outgoing requests attach to the request that caused them.
    return tracer.withSpanContext(span.context, () => originalEmit.apply(this, [event, ...args]));
  };

  proto.__zharpServerPatched = true;

  return () => {
    proto.emit = originalEmit;
    delete proto.__zharpServerPatched;
  };
}

/**
 * Case-insensitive header lookup. Node lower-cases incoming headers but preserves whatever
 * casing an outgoing request was given, so an options object can hold any spelling.
 */
function headerValue(headers: any, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? String(headers[key]) : null;
}

function pathOf(url: string): string {
  const withoutQuery = url.split('?')[0];
  if (withoutQuery.indexOf('://') === -1) return withoutQuery || '/';
  try {
    return new URL(url).pathname || '/';
  } catch {
    return withoutQuery || '/';
  }
}
