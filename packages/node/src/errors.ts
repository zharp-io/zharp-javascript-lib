/**
 * Errors as Zharp reads them: a log record of severity ERROR or FATAL carrying
 * `exception.type`, `exception.message` and `exception.stacktrace`, plus `zharp.handled`.
 *
 * A log rather than a span event because an error does not always happen inside a span (a
 * crash at startup, a timer callback), and one shape for both keeps the count honest: the server
 * makes an error event from either, so sending both would count every error twice.
 */
import { inspect } from 'node:util';
import { debugIdAttributes } from '@zharp/internal/debug-ids';
import { SOURCE_CONTEXT_ATTRIBUTE, sourced } from './source';

/** OTLP severity numbers. */
export const SEVERITY = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 } as const;
export type Level = keyof typeof SEVERITY;

/** Whatever was thrown, as an Error — a rejection with a string or an object is still worth a stack. */
export function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (value && typeof value === 'object' && typeof (value as any).message === 'string') {
    const error = new Error((value as any).message);
    error.name = typeof (value as any).name === 'string' ? (value as any).name : 'Error';
    if (typeof (value as any).stack === 'string') error.stack = (value as any).stack;
    return error;
  }
  const text = typeof value === 'string' ? value : inspect(value, { depth: 3, breakLength: Infinity });
  const error = new Error(`Non-Error thrown: ${text}`);
  // The stack points here, not at the throw — but it is the only one there is.
  return error;
}

/** The name an error is grouped under: `TypeError`, or a custom class's own name. */
function typeOf(error: Error): string {
  const name = error.name && error.name !== 'Error' ? error.name : error.constructor?.name;
  return name || 'Error';
}

/** The `exception.*` attributes for `error`. The stack keeps its first `Type: message` line. */
export function exceptionAttributes(error: Error, handled: boolean): Record<string, string> {
  const type = typeOf(error);
  const message = error.message || '';
  let stack = typeof error.stack === 'string' && error.stack ? error.stack : `${type}: ${message}`;
  // A cause is part of what went wrong; Node prints it, so the stack shown in Zharp does too.
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.stack) stack += `\nCaused by: ${cause.stack}`;
  // Built frames turned back into their sources through local maps, and the code that ran.
  const { stack: readable, context } = sourced(stack);
  return {
    'exception.type': type,
    'exception.message': message,
    'exception.stacktrace': readable,
    'zharp.handled': handled ? 'true' : 'false',
    // From the stack as it ran: frames resolved here keep their bundle's ID for uploaded maps.
    ...debugIdAttributes(stack),
    ...(context ? { [SOURCE_CONTEXT_ATTRIBUTE]: context } : {}),
  };
}
