/**
 * Uncaught errors, unhandled rejections and (when asked for) the console.
 */
import { safeString, safely } from '../util';

/** Whatever was thrown, as an Error. */
export function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (value && typeof value === 'object' && typeof (value as any).message === 'string') {
    const error = new Error((value as any).message);
    error.name = typeof (value as any).name === 'string' ? (value as any).name : 'Error';
    if (typeof (value as any).stack === 'string') error.stack = (value as any).stack;
    return error;
  }
  return new Error(typeof value === 'string' ? value : `Non-Error thrown: ${safeString(value)}`);
}

/**
 * The `exception.*` attributes Zharp groups errors by. The stack keeps a `Type: message` first
 * line: Chrome's stacks have one, Firefox's and Safari's do not.
 */
export function exceptionAttributes(error: Error, handled: boolean): Record<string, string> {
  const type = (error.name && error.name !== 'Error' ? error.name : error.constructor?.name) || 'Error';
  const message = error.message || '';
  const head = `${type}: ${message}`;
  let stack = typeof error.stack === 'string' ? error.stack : '';
  if (!stack.startsWith(error.name || type)) stack = stack ? `${head}\n${stack}` : head;
  return {
    'exception.type': type,
    'exception.message': message,
    'exception.stacktrace': stack,
    'zharp.handled': handled ? 'true' : 'false',
  };
}

export function watchErrors(report: (error: unknown, mechanism: string) => void): () => void {
  const onError = (event: ErrorEvent) =>
    safely(() => {
      // A failed <img> or <script> load also fires 'error' (on the element, captured here only
      // with capture listeners, which this is not) — only script errors reach this listener.
      if (event.error !== undefined && event.error !== null) report(event.error, 'onerror');
      else if (event.message) {
        // "Script error." from a cross-origin script without CORS: no stack, but still an error.
        const error = new Error(event.message);
        error.stack = `Error: ${event.message}\n    at ${event.filename || '<anonymous>'}:${event.lineno || 0}:${event.colno || 0}`;
        report(error, 'onerror');
      }
    });
  const onRejection = (event: PromiseRejectionEvent) => safely(() => report(event.reason, 'onunhandledrejection'));
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

const CONSOLE_LEVELS = { debug: 'debug', log: 'info', info: 'info', warn: 'warn', error: 'error' } as const;
export type ConsoleMethod = keyof typeof CONSOLE_LEVELS;

/** Copy console calls into logs. The console still prints as before. */
export function watchConsole(methods: ConsoleMethod[], log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void): () => void {
  const originals: Partial<Record<ConsoleMethod, any>> = {};
  let inside = false;
  for (const method of methods) {
    const original = (console as any)[method];
    if (typeof original !== 'function' || original.__zharp) continue;
    originals[method] = original;
    const patched = function (this: unknown, ...args: unknown[]) {
      original.apply(this ?? console, args);
      if (inside) return;
      inside = true;
      safely(() => {
        const message = args.map((arg) => (arg instanceof Error ? arg.stack || String(arg) : safeString(arg))).join(' ');
        if (!message.startsWith('[Zharp]')) log(CONSOLE_LEVELS[method], message);
      });
      inside = false;
    };
    (patched as any).__zharp = true;
    (console as any)[method] = patched;
  }
  return () => Object.assign(console, originals);
}
