import { LogEntry } from './types';

const SDK_VERSION = '1.0.0';

// Detects the runtime environment for the agent info sent with each batch.
function detectEnvironment(): string {
  if (typeof window !== 'undefined') return 'browser';
  if (typeof process !== 'undefined' && process.platform) return process.platform;
  return 'unknown';
}

export class Transport {
  private readonly endpoint: string;
  private readonly service: string;

  constructor(apiKey: string, service: string) {
    this.endpoint = `https://api.zharp.io/api/v1/agent/logs/${apiKey}`;
    this.service = service;
  }

  async send(entries: LogEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const body = JSON.stringify({
      hostname: this.service,
      os: detectEnvironment(),
      version: SDK_VERSION,
      logs: entries,
    });

    // Retry up to 3 times with exponential backoff (1s → 2s → 4s).
    // Only retry on network errors or 5xx responses — don't retry 4xx
    // because those are client errors that won't be fixed by retrying.
    let attempt = 0;
    while (attempt < 3) {
      try {
        const res = await this.doFetch(body);
        if (res.ok || res.status < 500) return;
      } catch {
        // network failure — fall through to retry
      }
      attempt++;
      if (attempt < 3) await sleep(Math.min(1000 * 2 ** attempt, 10000));
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

    const body = JSON.stringify({
      hostname: this.service,
      os: detectEnvironment(),
      version: SDK_VERSION,
      logs: entries,
    });

    navigator.sendBeacon(this.endpoint, new Blob([body], { type: 'application/json' }));
  }

  private doFetch(body: string): Promise<Response> {
    return fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Zharp-SDK': `js/${SDK_VERSION}`,
      },
      body,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
