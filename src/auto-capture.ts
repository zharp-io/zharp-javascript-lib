import { AutoCaptureOptions } from './types';
import { formatArg, toMessage } from './message';

export type ErrorHandler = (message: string, metadata?: Record<string, any>) => void;

const isBrowser = typeof window !== 'undefined';
const isNode = !isBrowser && typeof process !== 'undefined';

// Attaches global error listeners appropriate for the current runtime.
// Returns a teardown function that removes all listeners — call it in destroy().
//
// Browser: window.onerror + unhandledrejection event + optional console.error wrap
// Node.js: process.uncaughtException + process.unhandledRejection
//
// Each captured error calls onError() which queues it like a manual ZharpLogger.error() call.
export function setupAutoCapture(
  onError: ErrorHandler,
  options: AutoCaptureOptions = {},
): () => void {
  const teardowns: Array<() => void> = [];

  if (isBrowser) {
    // ── window.onerror ──────────────────────────────────────────────────────
    // Fires for uncaught synchronous exceptions (ReferenceError, TypeError …).
    // We preserve any existing handler so Sentry etc. still receive the event.
    if (options.errors !== false) {
      const prev = window.onerror ?? null;

      window.onerror = (message, source, lineno, colno, error) => {
        // `message` is an Event, not a string, when an <img> or <script> fails to load.
        onError(toMessage(typeof message === 'string' ? message : error ?? message), {
          source,
          lineno,
          colno,
          stack: error?.stack,
          type: 'uncaughtError',
        });
        return typeof prev === 'function'
          ? prev(message, source, lineno, colno, error)
          : false;
      };

      teardowns.push(() => { window.onerror = prev; });
    }

    // ── unhandledrejection ──────────────────────────────────────────────────
    // Fires when a Promise is rejected and nothing catches it.
    if (options.unhandledRejections !== false) {
      const handler = (event: PromiseRejectionEvent) => {
        const reason = event.reason;
        const message =
          reason === undefined || reason === null
            ? 'Unhandled promise rejection'
            : toMessage(reason);

        onError(message, {
          stack: reason instanceof Error ? reason.stack : undefined,
          type: 'unhandledRejection',
        });
      };

      window.addEventListener('unhandledrejection', handler);
      teardowns.push(() => window.removeEventListener('unhandledrejection', handler));
    }
  } else if (isNode) {
    // ── process.uncaughtException ───────────────────────────────────────────
    // Node.js equivalent of window.onerror. Fires when a synchronous exception
    // is thrown and not caught anywhere in the call stack. Without a handler,
    // Node.js would crash the process. We log it and let other registered
    // handlers (or the default crash behaviour) continue.
    if (options.errors !== false) {
      const handler = (error: Error) => {
        onError(toMessage(error), {
          stack: error.stack,
          name: error.name,
          type: 'uncaughtException',
        });
      };

      process.on('uncaughtException', handler);
      teardowns.push(() => process.off('uncaughtException', handler));
    }

    // ── process.unhandledRejection ──────────────────────────────────────────
    // Node.js equivalent of the browser's unhandledrejection event. Fires when
    // a Promise rejects and no .catch() or try/catch handles it.
    if (options.unhandledRejections !== false) {
      const handler = (reason: unknown) => {
        const message =
          reason === undefined || reason === null
            ? 'Unhandled promise rejection'
            : toMessage(reason);

        onError(message, {
          stack: reason instanceof Error ? reason.stack : undefined,
          name: reason instanceof Error ? reason.name : undefined,
          type: 'unhandledRejection',
        });
      };

      process.on('unhandledRejection', handler);
      teardowns.push(() => process.off('unhandledRejection', handler));
    }
  }

  // ── console.error wrap ────────────────────────────────────────────────────
  // Opt-in only. Works in both browser and Node.js.
  // When enabled, every console.error() call also sends a log to Zharp.
  if (options.consoleErrors === true) {
    const prevConsoleError = console.error.bind(console);

    console.error = (...args: unknown[]) => {
      // `console.error()` with no arguments still becomes a log — with a placeholder message
      // rather than an empty one the backend would refuse.
      onError(toMessage(args.map(formatArg).join(' ')), { source: 'console.error' });
      prevConsoleError(...args);
    };

    teardowns.push(() => { console.error = prevConsoleError; });
  }

  return () => teardowns.forEach((fn) => fn());
}
