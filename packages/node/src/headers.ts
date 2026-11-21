/**
 * Request and response headers on Node's HTTP spans, server and client. The rules — names,
 * secrets as `[Filtered]`, caps — are shared with the browser SDK (@zharp/internal/headers).
 */
import { ClientRequest, IncomingMessage, ServerResponse } from 'node:http';
import type { Span } from '@opentelemetry/api';
import { headerAttributes, type HeaderSettings } from '@zharp/internal/headers';

export { headerAttributes, headerSettings, type HeaderSettings } from '@zharp/internal/headers';

type HttpConfig = {
  applyCustomAttributesOnSpan?: (span: Span, request: ClientRequest | IncomingMessage, response: IncomingMessage | ServerResponse) => void;
  [key: string]: unknown;
};

/** The http instrumentation's config with headers recorded on every request span, server and client. */
export function withHeaderCapture(settings: HeaderSettings, config: HttpConfig = {}): HttpConfig {
  return {
    ...config,
    applyCustomAttributesOnSpan(span, request, response) {
      config.applyCustomAttributesOnSpan?.(span, request, response);
      try {
        if (request instanceof IncomingMessage) {
          span.setAttributes(headerAttributes('request', request.headers, settings));
          if (response instanceof ServerResponse) span.setAttributes(headerAttributes('response', response.getHeaders(), settings));
        } else if (request instanceof ClientRequest) {
          span.setAttributes(headerAttributes('request', request.getHeaders(), settings));
          if (response instanceof IncomingMessage) span.setAttributes(headerAttributes('response', response.headers, settings));
        }
      } catch {
        // Never break a request over its telemetry.
      }
    },
  };
}
