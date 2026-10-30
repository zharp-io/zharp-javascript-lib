/**
 * `zharp.debug_ids` on errors that do not come through Zharp's own API: exceptions recorded on
 * spans by the instrumentations (`span.recordException`), and error logs from the pino and
 * winston bridges. Zharp's own error logs already have it (see errors.ts); these processors only
 * fill it in where a stack is present and the attribute is not.
 */
import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace';
import type { LogRecordProcessor, ReadWriteLogRecord } from '@opentelemetry/sdk-logs';
import { DEBUG_IDS_ATTRIBUTE, debugIdsFor } from '@zharp/internal/debug-ids';

const STACK = 'exception.stacktrace';

export class DebugIdSpanProcessor implements SpanProcessor {
  onStart(_span: Span, _parentContext: Context): void {}

  /** Exception events are added while the span runs; by its end they are all there. */
  onEnd(span: ReadableSpan): void {
    try {
      for (const event of span.events) {
        const attributes = event.attributes as Record<string, unknown> | undefined;
        if (event.name !== 'exception' || !attributes || attributes[DEBUG_IDS_ATTRIBUTE] !== undefined) continue;
        const stack = attributes[STACK];
        const ids = typeof stack === 'string' ? debugIdsFor(stack) : undefined;
        if (ids) attributes[DEBUG_IDS_ATTRIBUTE] = JSON.stringify(ids);
      }
    } catch {
      // Never let telemetry break a request.
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export class DebugIdLogProcessor implements LogRecordProcessor {
  onEmit(record: ReadWriteLogRecord, _ctx?: Context): void {
    try {
      const attributes = record.attributes as Record<string, unknown>;
      const stack = attributes[STACK];
      if (typeof stack !== 'string' || attributes[DEBUG_IDS_ATTRIBUTE] !== undefined) return;
      const ids = debugIdsFor(stack);
      if (ids) record.setAttribute(DEBUG_IDS_ATTRIBUTE, JSON.stringify(ids));
    } catch {
      // As above.
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
