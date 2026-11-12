/**
 * `captureBodies` for Node: request and response bodies on the http instrumentation's spans,
 * for incoming requests (SERVER) and outgoing ones (CLIENT, http/https — axios, got, node-fetch).
 *
 * Nothing changes how the application reads or writes its streams. Readable sides (an incoming
 * request, an outgoing request's response) are seen through their own `emit('data')`, which
 * fires whichever way the app consumes them — listeners, pipe, async iteration — without
 * switching them into flowing mode. Writable sides (a server response, an outgoing request)
 * are seen through `write`/`end`. What is kept depends on the body:
 * - text: the first bytes, up to the raw limit
 * - a form upload (`multipart/form-data`): each text field, and each file as its name, type and
 *   size — file bytes are counted as they pass, never kept
 * - anything else (an image, a PDF, an event stream): only its size
 * Attributes are made in `applyCustomAttributesOnSpan`, which runs just before the span ends.
 */
import { ClientRequest, IncomingMessage, ServerResponse } from 'node:http';
import { brotliDecompressSync, constants, gunzipSync, inflateSync } from 'node:zlib';
import type { Span } from '@opentelemetry/api';
import {
  bodyAttributes,
  describedAttributes,
  fileLabel,
  isMultipart,
  isTextual,
  rawLimit,
  urlMatches,
  wanted,
  type BodySettings,
} from '@zharp/internal/bodies';

const TAP = Symbol.for('zharp.body');
/** Fields kept from one form upload. */
const MAX_FIELDS = 200;

// ── multipart/form-data ───────────────────────────────────────────────────────

interface Part {
  name: string;
  filename?: string;
  type?: string;
  size: number;
  text: Buffer[];
  kept: number;
}

/** Reads a form upload as it streams past: text fields kept (up to `maxText` each), files counted. */
class Multipart {
  private buf: Buffer = Buffer.alloc(0);
  private state: 'start' | 'after' | 'headers' | 'body' | 'done' = 'start';
  private readonly first: Buffer;
  private readonly delimiter: Buffer;
  private part: Part | null = null;
  private count = 0;
  readonly fields: Record<string, unknown> = {};
  cut = false;

  constructor(boundary: string, private readonly maxText: number) {
    this.first = Buffer.from(`--${boundary}`);
    this.delimiter = Buffer.from(`\r\n--${boundary}`);
  }

  push(chunk: Buffer): void {
    if (this.state === 'done') return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.state === 'start') {
        const i = this.buf.indexOf(this.first);
        if (i < 0) {
          if (this.buf.length > 64 * 1024) this.state = 'done';
          return;
        }
        this.buf = this.buf.subarray(i + this.first.length);
        this.state = 'after';
      }
      if (this.state === 'after') {
        if (this.buf.length < 2) return;
        if (this.buf[0] === 45 && this.buf[1] === 45) {
          this.state = 'done';
          this.buf = Buffer.alloc(0);
          return;
        }
        if (this.buf[0] === 13 && this.buf[1] === 10) this.buf = this.buf.subarray(2);
        this.state = 'headers';
      }
      if (this.state === 'headers') {
        const i = this.buf.indexOf('\r\n\r\n');
        if (i < 0) {
          if (this.buf.length > 16 * 1024) this.state = 'done';
          return;
        }
        this.part = parsePartHeaders(this.buf.subarray(0, i).toString('utf8'));
        this.buf = this.buf.subarray(i + 4);
        this.state = 'body';
      }
      if (this.state === 'body') {
        const i = this.buf.indexOf(this.delimiter);
        if (i >= 0) {
          this.consume(this.buf.subarray(0, i));
          this.finish(false);
          this.buf = this.buf.subarray(i + this.delimiter.length);
          this.state = 'after';
          if (this.count >= MAX_FIELDS) {
            this.state = 'done';
            this.cut = true;
            return;
          }
          continue;
        }
        // Keep what could be the start of the delimiter; the rest belongs to this part.
        const keep = this.delimiter.length - 1;
        if (this.buf.length > keep) {
          this.consume(this.buf.subarray(0, this.buf.length - keep));
          this.buf = Buffer.from(this.buf.subarray(this.buf.length - keep));
        }
        return;
      }
      return;
    }
  }

  private consume(bytes: Buffer): void {
    const part = this.part;
    if (!part || !bytes.length) return;
    part.size += bytes.length;
    if (part.filename !== undefined) return; // a file: counted, never kept
    const room = this.maxText - part.kept;
    if (room > 0) {
      const slice = bytes.subarray(0, room);
      part.text.push(Buffer.from(slice));
      part.kept += slice.length;
    }
  }

  private finish(partial: boolean): void {
    const part = this.part;
    this.part = null;
    if (!part) return;
    let value: unknown;
    if (part.filename !== undefined) value = fileLabel(part.filename, part.type, part.size, partial);
    else {
      value = Buffer.concat(part.text).toString('utf8').replace(/�$/, '');
      if (part.size > part.kept || partial) this.cut = true;
    }
    const existing = this.fields[part.name];
    this.fields[part.name] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
    this.count++;
  }

  /** The fields so far, including a part the stream stopped inside. */
  result(): { json: string; cut: boolean } {
    if (this.part) {
      this.consume(this.state === 'body' ? this.buf : Buffer.alloc(0));
      this.buf = Buffer.alloc(0);
      this.finish(true);
      this.cut = true;
    }
    return { json: JSON.stringify(this.fields), cut: this.cut };
  }
}

function parsePartHeaders(head: string): Part {
  const disposition = /^content-disposition:(.*)$/im.exec(head)?.[1] ?? '';
  const name = /\bname="([^"]*)"/i.exec(disposition)?.[1] ?? /\bname=([^;\s]+)/i.exec(disposition)?.[1] ?? '';
  const filenameStar = /\bfilename\*=(?:UTF-8'')?([^;\s]+)/i.exec(disposition)?.[1];
  let filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];
  if (filenameStar) {
    try {
      filename = decodeURIComponent(filenameStar);
    } catch {
      filename = filenameStar;
    }
  }
  const type = /^content-type:\s*(.*)$/im.exec(head)?.[1]?.trim();
  return { name, filename, type: filename !== undefined ? type : undefined, size: 0, text: [], kept: 0 };
}

function boundaryOf(contentType: string | undefined): string | undefined {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  return m ? m[1] ?? m[2] : undefined;
}

// ── taps ──────────────────────────────────────────────────────────────────────

class Tap {
  private chunks: Buffer[] = [];
  private kept = 0;
  /** Every byte seen, kept or not. */
  total = 0;
  cut = false;
  private mode: 'text' | 'count' | 'multipart' | undefined;
  multipart?: Multipart;

  /** `typeOf` is asked once, at the first byte, when the content type is surely set. */
  constructor(
    private readonly settings: BodySettings,
    private readonly typeOf: () => string | undefined,
  ) {}

  add(chunk: unknown, encoding?: unknown): void {
    if (chunk == null || typeof chunk === 'function') return;
    let buf: Buffer;
    if (typeof chunk === 'string') buf = Buffer.from(chunk, typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8');
    else if (chunk instanceof Uint8Array) buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    else return;
    if (!buf.length) return;
    this.total += buf.length;

    if (this.mode === undefined) {
      const type = this.typeOf();
      const boundary = isMultipart(type) ? boundaryOf(type) : undefined;
      if (boundary) {
        this.mode = 'multipart';
        this.multipart = new Multipart(boundary, this.settings.maxSize);
      } else this.mode = isTextual(type) ? 'text' : 'count';
    }
    if (this.mode === 'multipart') return this.multipart!.push(Buffer.from(buf));
    if (this.mode === 'count' || this.cut) return;

    const room = rawLimit(this.settings) - this.kept;
    if (buf.length > room) {
      this.cut = true;
      buf = buf.subarray(0, Math.max(0, room));
    }
    if (buf.length) {
      this.chunks.push(Buffer.from(buf));
      this.kept += buf.length;
    }
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

/** The attributes for one side, whatever kind of body it was. */
function sideAttributes(
  side: 'request' | 'response',
  tap: Tap | undefined,
  type: string | undefined,
  encoding: string | undefined,
  settings: BodySettings,
): Record<string, unknown> {
  if (!tap || !tap.total) return {};
  if (tap.multipart) {
    const { json, cut } = tap.multipart.result();
    return bodyAttributes(side, json, type, settings, cut);
  }
  if (!isTextual(type)) return describedAttributes(side, type, tap.total);
  const text = tap.text(encoding);
  if (text == null) return describedAttributes(side, type, tap.total);
  return bodyAttributes(side, text, type, settings, tap.cut);
}

/** Keeps what a readable stream emits. */
function tapReadable(stream: IncomingMessage, tap: Tap): void {
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
}

/** Keeps what is written to a writable stream. */
function tapWritable(stream: ServerResponse | ClientRequest, tap: Tap): void {
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

  return {
    ...config,
    requestHook(span, request) {
      config.requestHook?.(span, request);
      try {
        if (request instanceof IncomingMessage) {
          if (allowed(incomingUrl(request))) tapReadable(request, new Tap(settings, () => header(request.headers['content-type'])));
        } else if (request instanceof ClientRequest) {
          if (allowed(outgoingUrl(request))) tapWritable(request, new Tap(settings, () => header(request.getHeader('content-type'))));
        }
      } catch {}
    },
    responseHook(span, response) {
      config.responseHook?.(span, response);
      try {
        if (response instanceof ServerResponse) {
          if (tapOf(response.req) || allowed(incomingUrl(response.req))) tapWritable(response, new Tap(settings, () => sentHeader(response, 'content-type')));
        } else if (response instanceof IncomingMessage) {
          const req = (response as any).req as ClientRequest | undefined;
          if (!req || tapOf(req) || allowed(outgoingUrl(req))) tapReadable(response, new Tap(settings, () => header(response.headers['content-type'])));
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
          Object.assign(
            attributes,
            sideAttributes('request', tapOf(request), header(request.getHeader('content-type')), header(request.getHeader('content-encoding')), settings),
          );
          const res = response as IncomingMessage;
          Object.assign(
            attributes,
            sideAttributes('response', tapOf(res), header(res?.headers?.['content-type']), header(res?.headers?.['content-encoding']), settings),
          );
        } else if (request instanceof IncomingMessage) {
          const sentType = header(request.headers['content-type']);
          const sent = tapOf(request);
          if (sent && sent.total) {
            Object.assign(attributes, sideAttributes('request', sent, sentType, header(request.headers['content-encoding']), settings));
          } else {
            // Read before the hooks were in place (rare): a framework's parsed body will do.
            const parsed = (request as any).body;
            if (parsed != null && (typeof parsed === 'string' || (typeof parsed === 'object' && !Buffer.isBuffer(parsed)))) {
              const text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
              Object.assign(attributes, bodyAttributes('request', text, isTextual(sentType) ? sentType : 'application/json', settings));
            }
          }
          const res = response as ServerResponse;
          Object.assign(attributes, sideAttributes('response', tapOf(res), sentHeader(res, 'content-type'), sentHeader(res, 'content-encoding'), settings));
        }
        if (Object.keys(attributes).length) span.setAttributes(attributes as any);
      } catch {}
    },
  };
}
