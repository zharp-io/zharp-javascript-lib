/**
 * What every transport shares: the version it reports, where it sends, and how a body is cut
 * to a size the network will accept.
 *
 * Logs, traces and replay each have their own transport because they fail differently, but
 * they must agree on these. This folder is bundled into both @zharp/logs and @zharp/apm, so
 * the two packages send in exactly the same way without either depending on the other.
 *
 * Each package passes its own `X-Zharp-SDK` value (`js-logs/1.1.0`, `js-apm/1.0.0`), so the
 * backend can tell which one sent what.
 */

import { announce, nodeEnv, warn } from './env';

export const DEFAULT_ENDPOINT = 'https://api.zharp.io/api/v1';

/**
 * Largest body a normal request is allowed to carry. The backend accepts 10 MB; staying far
 * below it keeps one slow upload from holding everything behind it, and a single entry that is
 * larger than this is still sent on its own rather than dropped.
 */
export const MAX_FETCH_BYTES = 1_000_000;

/**
 * Largest body sent through `sendBeacon` or a `keepalive` fetch. Browsers cap the bytes in
 * flight for both at 64 KB, shared across the page, so each chunk leaves headroom.
 */
export const MAX_BEACON_BYTES = 60_000;

export type IngestType = 'logs' | 'traces' | 'replay';

/** Trim a configured endpoint so paths can be appended to it. */
export function normalizeEndpoint(endpoint?: string): string {
  return (endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
}

/** Bytes, not characters: a body full of non-Latin text is several times its `length`. */
export function byteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
  // No TextEncoder (very old runtimes): count UTF-8 bytes by hand.
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Cut `items` into JSON bodies of at most `limit` bytes each.
 *
 * `wrap` builds the envelope around a group (and is told which group it is, for envelopes that
 * number their bodies), so its own bytes are counted too. An item that is
 * too large to fit even alone is still given a body of its own: whether it can be delivered is
 * for the network to decide, not for a guess made here.
 *
 * @returns The serialised bodies, each paired with the items it carries
 */
export function splitBySize<T>(
  items: T[],
  limit: number,
  wrap: (group: T[], index: number) => unknown,
): Array<{ body: string; items: T[] }> {
  const overhead = byteLength(JSON.stringify(wrap([], 0)));
  const out: Array<{ body: string; items: T[] }> = [];

  let group: T[] = [];
  let size = overhead;
  for (const item of items) {
    // +1 for the comma that separates it from its neighbour.
    const itemSize = byteLength(JSON.stringify(item) ?? 'null') + 1;
    if (group.length && size + itemSize > limit) {
      out.push({ body: JSON.stringify(wrap(group, out.length)), items: group });
      group = [];
      size = overhead;
    }
    group.push(item);
    size += itemSize;
  }
  if (group.length) out.push({ body: JSON.stringify(wrap(group, out.length)), items: group });
  return out;
}

/**
 * POST a JSON body with the key in a header.
 *
 * The key never goes in the URL here: URLs end up in proxy logs, browser history and error
 * reports, headers do not.
 */
export function postJson(
  endpoint: string,
  type: IngestType,
  apiKey: string,
  body: string,
  sdk: string,
  keepalive = false,
): Promise<Response> {
  return fetch(`${endpoint}/agent/${type}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
      'X-Zharp-SDK': sdk,
    },
    body,
    keepalive,
    // Marks the request as this SDK's own so the fetch instrumentation skips it. Without it
    // reporting spans would produce spans, which would be reported.
    ...({ __zharp: true } as any),
  });
}

/**
 * Send bodies while the page is going away.
 *
 * `sendBeacon` survives unload but cannot set headers, so it is the one place the key travels
 * in the path. When the browser refuses a beacon — over its quota, or an older engine rejecting
 * the content type — the same body goes as a `keepalive` fetch, which also survives unload.
 * A body too large for either is still sent as an ordinary request: it may be cancelled with
 * the page, but sending it costs nothing and dropping it guarantees the loss.
 *
 * @param bodies - Serialised bodies, each already cut to `MAX_BEACON_BYTES` where possible
 */
export function sendOnUnload(endpoint: string, type: IngestType, apiKey: string, bodies: string[], sdk: string): void {
  const canBeacon = typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function';

  for (const body of bodies) {
    const small = byteLength(body) <= MAX_BEACON_BYTES;

    if (small && canBeacon) {
      let queued = false;
      try {
        queued = navigator.sendBeacon(
          `${endpoint}/agent/${type}/${encodeURIComponent(apiKey)}`,
          new Blob([body], { type: 'application/json' }),
        );
      } catch {
        queued = false;
      }
      if (queued) continue;
    }

    const plain = () => postJson(endpoint, type, apiKey, body, sdk).catch(() => {});
    if (small) {
      // A keepalive fetch shares the beacon's 64 KB budget, so it can be refused for the same
      // reason; an ordinary request is the last resort rather than nothing.
      try {
        postJson(endpoint, type, apiKey, body, sdk, true).catch(plain);
      } catch {
        plain();
      }
    } else {
      plain();
    }
  }
}

/** How long a rejected key waits before one batch is tried again. */
export const KEY_RETRY_MS = 60 * 60 * 1000;

/**
 * Stops sending when Zharp rejects the API key (401 or 403).
 *
 * A deleted or revoked key stays rejected, so sending every batch would only be refused forever.
 * The first rejection prints one warning; after that nothing is sent — batches are dropped, not
 * kept, so memory stays bounded — until an hour has passed, when one batch is tried again. If
 * that one is accepted, sending resumes and says so once; if not, the next try is an hour later.
 *
 * Each transport keeps its own gate: logs, traces and replay share a key, but each says what it
 * has stopped sending.
 */
export class KeyGate {
  /** When the next batch may go out; 0 while the key is accepted. */
  private retryAt = 0;
  /** The one batch tried after the wait is in flight. */
  private probing = false;
  private readonly retryMs: number;

  constructor(private readonly what: string) {
    // ZHARP_TEST_KEY_RETRY_MS shortens the hour for the end-to-end tests.
    this.retryMs = Number(nodeEnv('ZHARP_TEST_KEY_RETRY_MS')) || KEY_RETRY_MS;
  }

  /** Whether nothing should be sent at all — for unload beacons, which never report back. */
  get backedOff(): boolean {
    return this.retryAt !== 0;
  }

  /** Whether a batch may go out now: always while the key is accepted, then one per wait. */
  allow(): boolean {
    if (!this.retryAt) return true;
    if (this.probing || Date.now() < this.retryAt) return false;
    this.probing = true;
    return true;
  }

  /**
   * Note a response. Returns true when the key was rejected, so the caller drops the batch
   * instead of retrying it.
   */
  record(status: number): boolean {
    const wasBackedOff = this.retryAt !== 0;
    this.probing = false;
    if (status === 401 || status === 403) {
      if (!wasBackedOff) {
        warn(`Zharp rejected this API key (HTTP ${status}) — ${this.what} are not being sent. Check ZHARP_API_KEY.`);
      }
      this.retryAt = Date.now() + this.retryMs;
      return true;
    }
    if (wasBackedOff) {
      if (status >= 200 && status < 300) {
        this.retryAt = 0;
        announce(`Zharp accepted the API key again — ${this.what} are being sent.`);
      } else {
        // Neither accepted nor rejected (a server error): try again after the next wait.
        this.retryAt = Date.now() + this.retryMs;
      }
    }
    return false;
  }

  /** The tried batch never got a response: wait again rather than stay stuck mid-try. */
  failed(): void {
    if (!this.probing) return;
    this.probing = false;
    this.retryAt = Date.now() + this.retryMs;
  }
}
