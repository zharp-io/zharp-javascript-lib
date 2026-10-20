import { LogEntry } from './types';
import { MAX_BEACON_BYTES, MAX_FETCH_BYTES, postJson, sendOnUnload, splitBySize } from './delivery';

// The body is the entries and nothing else. Older versions also sent `hostname`, `os` and
// `version` — the shape a host agent sends — which listed every app using the SDK as a host
// that never reported metrics. The `X-Zharp-SDK` header is what identifies these requests now.
const envelope = (logs: LogEntry[]) => ({ logs });

export class Transport {
  private readonly endpoint: string;
  private readonly apiKey: string;

  constructor(apiKey: string, endpoint: string) {
    this.apiKey = apiKey;
    this.endpoint = endpoint;
  }

  async send(entries: LogEntry[]): Promise<void> {
    if (entries.length === 0) return;

    // Cut by bytes rather than count: fifty entries carrying stack traces can be megabytes, and
    // one oversized request would be rejected whole.
    for (const { body } of splitBySize(entries, MAX_FETCH_BYTES, envelope)) {
      await this.sendBody(body);
    }
  }

  // Uses navigator.sendBeacon when available so logs are guaranteed to be
  // delivered even when the page is unloading (beforeunload / visibilitychange).
  // sendBeacon is fire-and-forget and cannot be cancelled by the browser.
  sendBeacon(entries: LogEntry[]): void {
    if (entries.length === 0) return;
    if (typeof navigator === 'undefined' || !navigator.sendBeacon) {
      // Fallback: best-effort fetch (may be cancelled on unload)
      this.send(entries).catch(() => {});
      return;
    }

    // The beacon quota is 64 KB, so the batch goes in as many beacons as it takes.
    const bodies = splitBySize(entries, MAX_BEACON_BYTES, envelope).map((chunk) => chunk.body);
    sendOnUnload(this.endpoint, 'logs', this.apiKey, bodies);
  }

  // Three attempts in all: the first, then retries after 2s and 4s.
  // Only retry on network errors or 5xx responses — don't retry 4xx
  // because those are client errors that won't be fixed by retrying.
  private async sendBody(body: string): Promise<void> {
    let attempt = 0;
    while (attempt < 3) {
      try {
        const res = await postJson(this.endpoint, 'logs', this.apiKey, body);
        if (res.ok || res.status < 500) return;
      } catch {
        // network failure — fall through to retry
      }
      attempt++;
      if (attempt < 3) await sleep(Math.min(1000 * 2 ** attempt, 10000));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
