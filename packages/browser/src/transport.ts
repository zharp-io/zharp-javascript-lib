/**
 * Getting telemetry to Zharp from a page.
 *
 * Records are queued and sent in batches every few seconds (sooner when a batch fills), gzipped
 * where the browser can, and retried with backoff when the server or the network asks for it.
 * The queue is capped — when it is full the oldest go — so a page that is offline for an hour
 * does not grow without bound.
 *
 * When the page is hidden or closed everything left goes out at once with `keepalive`, which
 * lets the request outlive the page. (`sendBeacon` would too, but cannot send the key header.)
 */
import { byteLength } from './util';

export type Signal = 'traces' | 'logs' | 'replays';

const BATCH_SIZE = 100;
const FLUSH_MS = 5_000;
const MAX_QUEUE = 1_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** A normal request carries at most this much; the server takes 10 MB, but one huge upload holds everything behind it. */
export const MAX_BODY_BYTES = 1_000_000;
/** Browsers allow 64 KB of keepalive bodies in flight per page. */
export const MAX_KEEPALIVE_BYTES = 60_000;

export interface Endpoint {
  url: string;
  key: string;
  /** The page's fetch as it was before instrumentation, so the SDK never traces itself. */
  fetch: typeof fetch;
  /** What the warning for a rejected key tells the developer to check. Default: the page's init call. */
  rejectedHint?: string;
}

/** Shared by every sender on a page: one rejected key stops all of them, with one warning. */
let keyRejected = false;

/**
 * POST one body. Resolves to the HTTP status, or 0 when the request never completed.
 */
export async function post(endpoint: Endpoint, signal: Signal, body: string, keepalive = false): Promise<number> {
  if (keyRejected) return 401;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${endpoint.key}`,
  };
  let payload: BodyInit = body;
  // gzip when it pays and the browser can; a keepalive request is sent as the page goes away,
  // with no time for an async compression step.
  if (!keepalive && body.length > 2_048 && typeof CompressionStream !== 'undefined') {
    try {
      payload = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
      headers['Content-Encoding'] = 'gzip';
    } catch {
      payload = body;
    }
  }
  try {
    const response = await endpoint.fetch.call(globalThis, `${endpoint.url}/v1/${signal}`, {
      method: 'POST',
      headers,
      body: payload,
      keepalive,
      credentials: 'omit',
    });
    if (response.status === 401 || response.status === 403) {
      if (!keyRejected) {
        keyRejected = true;
        console.warn(`[Zharp] The key was rejected (HTTP ${response.status}); ${endpoint.rejectedHint ?? "nothing more will be sent from this page. Check Zharp.init({ key }) and the app's allowed origins."}`);
      }
    }
    return response.status;
  } catch {
    return 0;
  }
}

/** Bytes of our keepalive requests still in flight: the browser refuses new ones past its budget. */
let keepaliveInFlight = 0;

/**
 * Send one body as the page is hidden or closed, exactly once.
 *
 * Within the keepalive budget the request outlives the page — and is never sent again: when the
 * page goes, the browser still delivers it but tells the page it failed (`net::ERR_ABORTED`), so
 * resending on failure stored everything twice. Past the budget, an ordinary request may still
 * finish before the page is gone.
 */
export function sendOnHide(endpoint: Endpoint, signal: Signal, body: string): void {
  const size = byteLength(body);
  if (keepaliveInFlight + size <= MAX_KEEPALIVE_BYTES) {
    keepaliveInFlight += size;
    void post(endpoint, signal, body, true).finally(() => {
      keepaliveInFlight -= size;
    });
  } else {
    void post(endpoint, signal, body);
  }
}

/** 429, 5xx and network failures are worth another try; anything else will fail the same way again. */
export const retryable = (status: number) => status === 0 || status === 429 || status >= 500;

/**
 * Cut `items` into JSON bodies of at most `limit` bytes. An item too large for any body still
 * gets one of its own: whether it goes through is for the network to decide.
 */
export function split<T>(items: T[], limit: number, wrap: (group: T[]) => unknown): Array<{ body: string; items: T[] }> {
  const overhead = byteLength(JSON.stringify(wrap([])));
  const out: Array<{ body: string; items: T[] }> = [];
  let group: T[] = [];
  let size = overhead;
  for (const item of items) {
    const itemSize = byteLength(JSON.stringify(item)) + 1;
    if (group.length && size + itemSize > limit) {
      out.push({ body: JSON.stringify(wrap(group)), items: group });
      group = [];
      size = overhead;
    }
    group.push(item);
    size += itemSize;
  }
  if (group.length) out.push({ body: JSON.stringify(wrap(group)), items: group });
  return out;
}

/** A queue of OTLP records of one signal, and the timer that sends them. */
export class Exporter<T> {
  private queue: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending: Promise<void> | null = null;
  private failures = 0;

  constructor(
    private readonly endpoint: Endpoint,
    private readonly signal: 'traces' | 'logs',
    /** Wraps records in the export request: resource, scope, and the signal's envelope. */
    private readonly wrap: (records: T[]) => unknown,
    /**
     * Send on a timer. Where nothing runs between requests (a Cloudflare Worker) there are no
     * timers: the caller flushes at the end of each request, and what failed waits for the next.
     */
    private readonly timers = true,
  ) {}

  add(record: T): void {
    this.queue.push(record);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    if (this.queue.length >= BATCH_SIZE && !this.failures) this.flush();
    else this.schedule(FLUSH_MS);
  }

  /** Send everything queued. One send at a time; a call during one waits and then sends what is left. */
  async flush(): Promise<void> {
    while (this.sending) await this.sending;
    if (!this.queue.length) return;
    this.sending = this.send().finally(() => (this.sending = null));
    return this.sending;
  }

  /** The page is going away: everything left, now, with keepalive. Nothing to wait for. */
  flushOnHide(): void {
    if (!this.queue.length) return;
    const records = this.queue;
    this.queue = [];
    for (const { body } of split(records, MAX_KEEPALIVE_BYTES, this.wrap)) sendOnHide(this.endpoint, this.signal, body);
  }

  private schedule(ms: number): void {
    if (this.timer || !this.timers) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, ms);
  }

  private async send(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const records = this.queue;
    this.queue = [];
    const batches = split(records, MAX_BODY_BYTES, this.wrap);
    for (let i = 0; i < batches.length; i++) {
      const status = await post(this.endpoint, this.signal, batches[i].body);
      if (retryable(status)) {
        // This batch and the ones after it go back to the front, oldest first, and wait.
        const unsent = batches.slice(i).flatMap((b) => b.items);
        this.queue = unsent.concat(this.queue).slice(-MAX_QUEUE);
        this.failures++;
        this.schedule(Math.min(FLUSH_MS * 2 ** this.failures, MAX_BACKOFF_MS));
        return;
      }
      // Delivered, or refused for good (400, 401/403): either way it is done.
      this.failures = 0;
    }
    if (this.queue.length) this.schedule(FLUSH_MS);
  }
}
