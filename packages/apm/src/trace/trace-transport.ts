import { SpanRecord } from './types';
import { MAX_BEACON_BYTES, MAX_FETCH_BYTES, postJson, sendOnUnload, splitBySize } from '@zharp/internal/delivery';
import { SDK } from '../version';

// The flat shape the backend reads for SDK spans. Resource attributes travel on each span.
const envelope = (spans: SpanRecord[]) => ({ spans });

/**
 * Ships finished spans to Zharp.
 *
 * Separate from the log transport rather than parameterised by path, because the two differ in
 * more than their URL: a dropped span is a gap in a picture, while a dropped log is a lost fact,
 * so they do not deserve the same retry behaviour or the same failure noise.
 */
export class TraceTransport {
  private readonly endpoint: string;
  private readonly apiKey: string;

  constructor(apiKey: string, endpoint: string) {
    this.apiKey = apiKey;
    this.endpoint = endpoint;
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
    for (const { body } of splitBySize(spans, MAX_FETCH_BYTES, envelope)) {
      await this.sendBody(body);
    }
  }

  /**
   * Fire-and-forget send for page unload, where a normal request would be cancelled.
   * @param spans - Finished spans to send
   */
  sendBeacon(spans: SpanRecord[]): void {
    if (!spans.length) return;

    if (typeof navigator === 'undefined' || !navigator.sendBeacon) {
      this.send(spans).catch(() => {});
      return;
    }
    const bodies = splitBySize(spans, MAX_BEACON_BYTES, envelope).map((chunk) => chunk.body);
    sendOnUnload(this.endpoint, 'traces', this.apiKey, bodies, SDK);
  }

  private async sendBody(body: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await postJson(this.endpoint, 'traces', this.apiKey, body, SDK);
        // A 4xx will not be fixed by sending it again — a bad key stays bad, and an oversized
        // batch stays oversized. Only a server-side failure is worth a second attempt.
        if (response.ok || response.status < 500) return;
      } catch {
        // Network failure; fall through and retry once.
      }
      if (attempt === 0) await sleep(1000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
