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

/** An Error as plain fields. `JSON.stringify(err)` is `{}`: name, message and stack are not enumerable. */
function errorFields(error: Error, seen: WeakSet<object>, depth: number): Record<string, unknown> {
  const fields: Record<string, unknown> = { name: error.name, message: error.message };
  if (error.stack) fields.stack = error.stack;
  // Enumerable extras a library put on it — `code`, `status`, `errno`.
  for (const [key, value] of Object.entries(error)) fields[key] = withErrorsAsFields(value, seen, depth + 1);
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined) fields.cause = withErrorsAsFields(cause, seen, depth + 1);
  return fields;
}

/**
 * Metadata with every Error in it — at any depth — turned into `{ name, message, stack }`, so
 * `ZharpLogger.error('Payment failed', { err })` sends the error rather than `{}`. Everything
 * else is left as it is (the same objects, not copies, where nothing inside changed).
 */
export function withErrorsAsFields(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > 6) return value;
  if (seen.has(value)) return value; // a cycle: JSON.stringify decides what to do with it, as before
  seen.add(value);
  if (value instanceof Error) return errorFields(value, seen, depth);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = withErrorsAsFields(item, seen, depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  // Only plain objects are walked; a Date, a Map or a class instance keeps its own JSON form.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const next = withErrorsAsFields(item, seen, depth + 1);
    if (next !== item) changed = true;
    out[key] = next;
  }
  return changed ? out : value;
}

/** The first Error found at the top level of `metadata`, if any — its stack becomes the log's stack. */
export function firstError(metadata: Record<string, unknown> | undefined): Error | undefined {
  if (!metadata) return undefined;
  for (const value of Object.values(metadata)) if (value instanceof Error) return value;
  return undefined;
}
