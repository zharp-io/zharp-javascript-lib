/**
 * Secrets in URLs never leave the process: before any span ends, query values under
 * secret-looking keys (`token`, `key`, `sig`, `password`, …) in its URL attributes become
 * `[Filtered]`, and `user:password@` is dropped. Every span, whatever made it — http, fetch,
 * a framework — and whether or not `captureBodies` is on.
 */
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace';
import { redactQuery, redactUrl } from '@zharp/internal/bodies';

const URL_KEYS = ['url.full', 'http.url', 'http.target'];

export class UrlRedactionSpanProcessor implements SpanProcessor {
  onStart(): void {}

  onEnding(span: Span): void {
    try {
      const attributes = (span as unknown as ReadableSpan).attributes ?? {};
      for (const key of URL_KEYS) {
        const value = attributes[key];
        if (typeof value === 'string') {
          const redacted = redactUrl(value);
          if (redacted !== value) span.setAttribute(key, redacted);
        }
      }
      const query = attributes['url.query'];
      if (typeof query === 'string') {
        const bare = query.startsWith('?') ? query.slice(1) : query;
        const redacted = redactQuery(bare);
        if (redacted !== bare) span.setAttribute('url.query', (query.startsWith('?') ? '?' : '') + redacted);
      }
    } catch {
      // Never let telemetry break a request.
    }
  }

  onEnd(_span: ReadableSpan): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
