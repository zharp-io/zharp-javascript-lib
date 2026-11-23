/**
 * Install paths taken out of error stacks before they are sent, for apps whose files live in a
 * different folder on every machine — an Electron app reads
 * `C:\Users\ana\AppData\Local\Programs\shop\resources\app.asar\dist\main.js` on one computer and
 * `/Applications/Shop.app/Contents/Resources/app.asar/dist/main.js` on the next. Rewritten
 * (`app:///dist/main.js`), every install groups into the same issue, and no user's folder name
 * is sent.
 *
 * Set by @zharp/electron through `init({ rewritePaths })`. Runs after the debug ID processors, so
 * the IDs were found from the stack as it ran; the IDs' keys are rewritten the same way, so they
 * still match the frames.
 */
import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace';
import type { LogRecordProcessor, ReadWriteLogRecord } from '@opentelemetry/sdk-logs';

export type PathRewrite = (text: string) => string;

/** The attributes that hold file paths: the stack, the debug IDs' keys, the code around each frame. */
const PATH_ATTRIBUTES = ['exception.stacktrace', 'zharp.debug_ids', 'zharp.source_context', 'code.filepath', 'code.file.path'];

function rewriteAll(attributes: Record<string, unknown>, rewrite: PathRewrite, set: (key: string, value: string) => void): void {
  for (const key of PATH_ATTRIBUTES) {
    const value = attributes[key];
    if (typeof value !== 'string') continue;
    const next = rewrite(value);
    if (next !== value) set(key, next);
  }
}

export class PathRewriteLogProcessor implements LogRecordProcessor {
  constructor(private readonly rewrite: PathRewrite) {}

  onEmit(record: ReadWriteLogRecord, _ctx?: Context): void {
    try {
      rewriteAll(record.attributes as Record<string, unknown>, this.rewrite, (key, value) => record.setAttribute(key, value));
    } catch {
      // Never throw into the application.
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export class PathRewriteSpanProcessor implements SpanProcessor {
  constructor(private readonly rewrite: PathRewrite) {}

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    try {
      for (const event of span.events) {
        const attributes = event.attributes as Record<string, unknown> | undefined;
        if (event.name === 'exception' && attributes) rewriteAll(attributes, this.rewrite, (key, value) => (attributes[key] = value));
      }
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
