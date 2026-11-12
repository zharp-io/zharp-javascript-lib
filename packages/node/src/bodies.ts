/**
 * `captureBodies` for Node: request and response bodies on the http instrumentation's spans,
 * for incoming requests (SERVER) and outgoing ones (CLIENT, http/https — axios, got, node-fetch).
 *
 * Nothing changes how the application reads or writes its streams. Readable sides (an incoming
 * request, an outgoing request's response) are seen through their own `emit('data')`, which
 * fires whichever way the app consumes them — listeners, pipe, async iteration — without
 * switching them into flowing mode. Writable sides (a server response, an outgoing request)
 * are seen through `write`/`end`. Only the first bytes up to the cap are kept, and they are
 * turned into attributes in `applyCustomAttributesOnSpan`, which runs just before the span ends.
 */
import { ClientRequest, IncomingMessage, ServerResponse } from 'node:http';
import { brotliDecompressSync, constants, gunzipSync, inflateSync } from 'node:zlib';
import type { Span } from '@opentelemetry/api';
import { bodyAttributes, isTextual, urlMatches, wanted, type BodySettings } from '@zharp/internal/bodies';

/** Compressed bodies are read further before inflating, so the cap still applies to text. */
const COMPRESSED_LIMIT = 64 * 1024;
const TAP = Symbol.for('zharp.body');

class Tap {
  private chunks: Buffer[] = [];
  private size = 0;
  cut = false;
  constructor(private readonly limit: number) {}

  add(chunk: unknown, encoding?: unknown): void {
    if (this.cut || chunk == null || typeof chunk === 'function') return;
    let buf: Buffer;
    if (typeof chunk === 'string') buf = Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
    else if (chunk instanceof Uint8Array) buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    else return;
    const room = this.limit - this.size;
    if (buf.length > room) {
      this.cut = true;
      buf = buf.subarray(0, Math.max(0, room));
    }
    if (buf.length) {
      this.chunks.push(Buffer.from(buf));
      this.size += buf.length;
    }
  }

  get empty(): boolean {
    return this.size === 0;
  }

  /** The text, inflated if it was compressed; null when it cannot be read as text. */
  text(encoding: string | undefined): string | null {
    let raw = Buffer.concat(this.chunks);
    const enc = (encoding ?? '').toLowerCase().trim();
    try {
      // A cut-off stream still inflates up to where it stops.
      const flush = { finishFlush: constants.Z_SYNC_FLUSH };
      if (enc === 'gzip' || enc === 'x-gzip') raw = gunzipSync(raw, flush);
      else if (enc === 'deflate') raw = inflateSync(raw, flush);
      else if (enc === 'br') raw = brotliDecompressSync(raw, { finishFlush: constants.BROTLI_OPERATION_FLUSH });
      else if (enc && enc !== 'identity') return null;
    } catch {
      return null;
    }
    // A multi-byte character split at the cap decodes as U+FFFD; drop it.
    return raw.toString('utf8').replace(/�$/, '');
  }
}

function limitFor(settings: BodySettings, encoding: unknown): number {
  return encoding && String(encoding).toLowerCase() !== 'identity' ? COMPRESSED_LIMIT : settings.maxSize * 4;
}

/** Keeps what a readable stream emits. */
function tapReadable(stream: IncomingMessage, limit: number): Tap {
  const tap = new Tap(limit);
  const emit = stream.emit;
  stream.emit = function (this: IncomingMessage, event: string | symbol, ...args: any[]) {
    if (event === 'data') {
      try {
        tap.add(args[0]);
      } catch {}
    }
    return emit.call(this, event, ...args);
  } as typeof stream.emit;
  (stream as any)[TAP] = tap;
  return tap;
}

/** Keeps what is written to a writable stream. The encoding header may be set later, so the cap is the larger one until it is known. */
function tapWritable(stream: ServerResponse | ClientRequest, limit: number): Tap {
  const tap = new Tap(limit);
  const target = stream as any;
  const write = target.write;
  const end = target.end;
  target.write = function (this: unknown, ...args: any[]) {
    try {
      tap.add(args[0], args[1]);
    } catch {}
    return write.apply(this, args);
  };
  target.end = function (this: unknown, ...args: any[]) {
    try {
      tap.add(args[0], args[1]);
    } catch {}
    return end.apply(this, args);
  };
  (stream as any)[TAP] = tap;
  return tap;
}

const tapOf = (stream: unknown): Tap | undefined => (stream as any)?.[TAP];

function header(value: unknown): string | undefined {
  if (value == null) return undefined;
  return Array.isArray(value) ? String(value[0]) : String(value);
}

function incomingUrl(req: IncomingMessage): string {
  const proto = (req.socket as any)?.encrypted ? 'https' : 'http';
  return `${proto}://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
}

/**
 * A header the server sent. Headers given to `writeHead()` alone never reach `getHeader()`, so
 * the head as written is read as well.
 */
function sentHeader(res: ServerResponse, name: string): string | undefined {
  const set = header(res.getHeader(name));
  if (set) return set;
  const head = (res as any)._header;
  if (typeof head !== 'string') return undefined;
  const match = head.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'im'));
  return match ? match[1].trim() : undefined;
}

function outgoingUrl(req: ClientRequest): string {
  const r = req as any;
  return `${r.protocol ?? 'http:'}//${r.host ?? 'localhost'}${r.path ?? '/'}`;
}

type HttpConfig = {
  requestHook?: (span: Span, request: any) => void;
  responseHook?: (span: Span, response: any) => void;
  applyCustomAttributesOnSpan?: (span: Span, request: any, response: any) => void;
  [key: string]: unknown;
};

/**
 * The http instrumentation's config with body capture added. Hooks the application set itself
 * still run, first.
 */
export function withBodyCapture(settings: BodySettings, config: HttpConfig = {}): HttpConfig {
  const allowed = (url: string) => !settings.urls || urlMatches(url, settings.urls);
  const generous = Math.max(COMPRESSED_LIMIT, settings.maxSize * 4);

  return {
    ...config,
    requestHook(span, request) {
      config.requestHook?.(span, request);
      try {
        if (request instanceof IncomingMessage) {
          if (allowed(incomingUrl(request))) tapReadable(request, limitFor(settings, request.headers['content-encoding']));
        } else if (request instanceof ClientRequest) {
          if (allowed(outgoingUrl(request))) tapWritable(request, limitFor(settings, request.getHeader('content-encoding')));
        }
      } catch {}
    },
    responseHook(span, response) {
      config.responseHook?.(span, response);
      try {
        if (response instanceof ServerResponse) {
          if (tapOf(response.req) || allowed(incomingUrl(response.req))) tapWritable(response, generous);
        } else if (response instanceof IncomingMessage) {
          const req = (response as any).req as ClientRequest | undefined;
          if (!req || tapOf(req) || allowed(outgoingUrl(req))) tapReadable(response, limitFor(settings, response.headers['content-encoding']));
        }
      } catch {}
    },
    applyCustomAttributesOnSpan(span, request, response) {
      config.applyCustomAttributesOnSpan?.(span, request, response);
      try {
        const status = Number(response?.statusCode) || 0;
        if (!wanted(settings, status)) return;
        const attributes: Record<string, unknown> = {};

        if (request instanceof ClientRequest) {
          const sentType = header(request.getHeader('content-type'));
          const sent = tapOf(request);
          if (sent && !sent.empty && isTextual(sentType)) {
            Object.assign(attributes, bodyAttributes('request', sent.text(header(request.getHeader('content-encoding'))), sentType, settings, sent.cut));
          }
          const res = response as IncomingMessage;
          const gotType = header(res?.headers?.['content-type']);
          const got = tapOf(res);
          if (got && !got.empty && isTextual(gotType)) {
            Object.assign(attributes, bodyAttributes('response', got.text(header(res.headers['content-encoding'])), gotType, settings, got.cut));
          }
        } else if (request instanceof IncomingMessage) {
          const sentType = header(request.headers['content-type']);
          const sent = tapOf(request);
          if (isTextual(sentType)) {
            if (sent && !sent.empty) {
              Object.assign(attributes, bodyAttributes('request', sent.text(header(request.headers['content-encoding'])), sentType, settings, sent.cut));
            } else {
              // Read before the hooks were in place (rare): a framework's parsed body will do.
              const parsed = (request as any).body;
              if (parsed != null && (typeof parsed === 'string' || (typeof parsed === 'object' && !Buffer.isBuffer(parsed)))) {
                const text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
                Object.assign(attributes, bodyAttributes('request', text, sentType ?? 'application/json', settings));
              }
            }
          }
          const res = response as ServerResponse;
          const gotType = sentHeader(res, 'content-type');
          const got = tapOf(res);
          if (got && !got.empty && isTextual(gotType)) {
            Object.assign(attributes, bodyAttributes('response', got.text(sentHeader(res, 'content-encoding')), gotType, settings, got.cut));
          }
        }
        if (Object.keys(attributes).length) span.setAttributes(attributes as any);
      } catch {}
    },
  };
}
