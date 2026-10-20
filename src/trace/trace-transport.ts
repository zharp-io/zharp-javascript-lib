import { SpanRecord } from './types';

const SDK_VERSION = '1.1.0';

function detectEnvironment(): string {
  if (typeof window !== 'undefined') return 'browser';
  if (typeof process !== 'undefined' && process.platform) return process.platform;
  return 'unknown';
}

/**
 * Ships finished spans to Zharp.
 *
 * Separate from the log transport rather than parameterised by path, because the two differ in
 * more than their URL: a dropped span is a gap in a picture, while a dropped log is a lost fact,
 * so they do not deserve the same retry behaviour or the same failure noise.
 */
export class TraceTransport {
  private readonly endpoint: string;
  private readonly service: string;

  constructor(apiKey: string, service: string) {
    this.endpoint = `https://api.zharp.io/api/v1/agent/traces/${apiKey}`;
    this.service = service;
  }

  /**
   * Send a batch, retrying transient failures.
   *
   * Retries are capped at two attempts, one fewer than the log transport gets. Spans are
   * produced continuously and the next flush is seconds away, so trying harder to deliver this
   * batch mostly competes with the batch behind it.
   *
   * @param spans - Finished spans to send
   */
  async send(spans: SpanRecord[]): Promise<void> {
    if (!spans.length) return;

    const body = JSON.stringify({
      hostname: this.service,
      os: detectEnvironment(),
      version: SDK_VERSION,
      spans,
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.post(body);
        // A 4xx will not be fixed by sending it again — a bad key stays bad, and an oversized
        // batch stays oversized. Only a server-side failure is worth a second attempt.
        if (response.ok || response.status < 500) return;
      } catch {
        // Network failure; fall through and retry once.
      }
      if (attempt === 0) await sleep(1000);
    }
  }

  /**
   * Fire-and-forget send for page unload, where a normal request would be cancelled.
   * @param spans - Finished spans to send
   */
  sendBeacon(spans: SpanRecord[]): void {
    if (!spans.length) return;

    const body = JSON.stringify({
      hostname: this.service,
      os: detectEnvironment(),
      version: SDK_VERSION,
      spans,
    });

    if (typeof navigator === 'undefined' || !navigator.sendBeacon) {
      this.send(spans).catch(() => {});
      return;
    }
    navigator.sendBeacon(this.endpoint, new Blob([body], { type: 'application/json' }));
  }

  private post(body: string): Promise<Response> {
    return fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Zharp-SDK': `js/${SDK_VERSION}`,
      },
      body,
      // Marks the request as this SDK's own so the fetch instrumentation skips it. Without it
      // reporting spans would produce spans, which would be reported.
      ...({ __zharp: true } as any),
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
