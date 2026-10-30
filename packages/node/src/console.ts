/**
 * `console.*` as OpenTelemetry log records.
 *
 * OpenTelemetry bridges pino, winston and bunyan but not the console, which is where most Node
 * code logs. Each call still prints exactly as before; a copy is emitted as a record in the
 * active context, so it carries the trace and span it was written in.
 */
import { format } from 'node:util';
import { SeverityNumber, type Logger } from '@opentelemetry/api';

const LEVELS: Array<[method: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace', severity: SeverityNumber, text: string]> = [
  ['debug', SeverityNumber.DEBUG, 'DEBUG'],
  ['trace', SeverityNumber.TRACE, 'TRACE'],
  ['log', SeverityNumber.INFO, 'INFO'],
  ['info', SeverityNumber.INFO, 'INFO'],
  ['warn', SeverityNumber.WARN, 'WARN'],
  ['error', SeverityNumber.ERROR, 'ERROR'],
];

/** Set while a record is being emitted, so a console call made by the exporter is not sent too. */
let emitting = false;

/**
 * Patch the console. Returns the undo.
 *
 * Lines the SDK prints about itself (`[Zharp] …`) are left out: they describe the reporting,
 * not the application.
 */
export function captureConsole(logger: Logger): () => void {
  const originals = new Map<string, (...args: unknown[]) => void>();
  for (const [method, severityNumber, severityText] of LEVELS) {
    const original = console[method];
    if (typeof original !== 'function' || (original as any).__zharp) continue;
    originals.set(method, original);
    const patched = function (this: unknown, ...args: unknown[]) {
      original.apply(this ?? console, args);
      if (emitting) return;
      emitting = true;
      try {
        const body = format(...args);
        if (!body.startsWith('[Zharp]')) {
          logger.emit({ severityNumber, severityText, body, attributes: { 'log.source': 'console' } });
        }
      } catch {
        // A log line that could not be copied is not worth an exception in the caller.
      } finally {
        emitting = false;
      }
    };
    (patched as any).__zharp = true;
    console[method] = patched;
  }
  return () => {
    for (const [method, original] of originals) (console as any)[method] = original;
  };
}
