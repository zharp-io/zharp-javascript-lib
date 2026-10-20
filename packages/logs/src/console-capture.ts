import type { ConsoleMethod, LogLevel } from './types';
import { formatArg, toMessage } from '@zharp/internal/message';

export const CONSOLE_METHODS: ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug'];

const LEVEL: Record<ConsoleMethod, LogLevel> = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
};

export type ConsoleHandler = (level: LogLevel, message: string, metadata: Record<string, any>) => void;

/**
 * Which console methods `captureConsole` (or `ZHARP_CAPTURE_CONSOLE`) asks for.
 *
 * `'all'` (or `true`) is every method; a list — an array, or `"warn,error"` from the environment —
 * is those methods; anything else, including `false` and `"none"`, is none.
 */
export function consoleMethodsOf(value: unknown): ConsoleMethod[] {
  if (value === true || value === 'all' || value === 'true') return [...CONSOLE_METHODS];
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const wanted = list.map((m) => String(m).trim().toLowerCase());
  return CONSOLE_METHODS.filter((m) => wanted.includes(m));
}

/**
 * Copy console calls to Zharp. What the console prints is unchanged — the original method still
 * runs first, with the same arguments — and each call also becomes a log at the matching level.
 *
 * The SDK's own lines ("[Zharp] …") are left out, and a console call made while a captured one is
 * being handled is not captured again, so nothing here can feed itself.
 *
 * @returns A teardown that puts the original methods back
 */
export function setupConsoleCapture(methods: ConsoleMethod[], onLog: ConsoleHandler): () => void {
  if (typeof console === 'undefined' || methods.length === 0) return () => {};

  let handling = false;
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();

  for (const method of methods) {
    const original = console[method];
    if (typeof original !== 'function') continue;
    originals.set(method, original);

    console[method] = (...args: unknown[]) => {
      original.apply(console, args);
      if (handling) return;
      // An Error reads as "TypeError: x" in the message; its stack goes in the metadata.
      const text = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : formatArg(a))).join(' ');
      if (text.startsWith('[Zharp]')) return;
      const error = args.find((a): a is Error => a instanceof Error);
      handling = true;
      try {
        onLog(LEVEL[method], toMessage(text), {
          origin: 'console',
          consoleMethod: method,
          ...(error ? { stack: error.stack, name: error.name } : {}),
        });
      } finally {
        handling = false;
      }
    };
  }

  return () => {
    for (const [method, original] of originals) console[method] = original;
  };
}
