/**
 * A log message as text.
 *
 * The API types say `string`, but JavaScript callers pass whatever they have — an Error, an
 * object, `undefined` from a field that was not set. The backend rejects an entry whose message
 * is not a string, and one bad entry used to fail its whole batch, so every path coerces here.
 *
 * @param value - Whatever was passed as the message
 * @returns Non-empty text; '(empty message)' when there is nothing to show
 */
export function toMessage(value: unknown): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (value === undefined || value === null) text = '';
  // JSON.stringify(new Error('x')) is '{}' — the useful part of an Error is not enumerable.
  else if (value instanceof Error) text = value.message || value.name;
  else if (typeof value === 'object') {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      // Circular, or holding a BigInt.
      text = String(value);
    }
  } else text = String(value);

  return text.trim() ? text : '(empty message)';
}

/** One `console.error` argument as text, the way a reader of the console would see it. */
export function formatArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (value !== null && typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
