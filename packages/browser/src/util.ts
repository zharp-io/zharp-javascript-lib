/**
 * Small pieces everything else uses: IDs, clocks, and OTLP/JSON values.
 */

/** Random bytes as lowercase hex. `crypto.getRandomValues` everywhere it exists; the fallback is about collisions, not secrecy. */
export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && c.getRandomValues) c.getRandomValues(buf);
  else for (let i = 0; i < bytes; i++) buf[i] = (Math.random() * 256) | 0;
  let out = '';
  for (let i = 0; i < bytes; i++) out += (buf[i] < 16 ? '0' : '') + buf[i].toString(16);
  // All zeros means "absent" in W3C Trace Context; astronomically unlikely, but free to rule out.
  return /^0+$/.test(out) ? randomHex(bytes) : out;
}

export const newTraceId = () => randomHex(16);
export const newSpanId = () => randomHex(8);

/** Milliseconds since the epoch, with the sub-millisecond precision `performance` gives. */
export function now(): number {
  const perf = typeof performance !== 'undefined' ? performance : undefined;
  return perf && perf.timeOrigin ? perf.timeOrigin + perf.now() : Date.now();
}

/**
 * Epoch milliseconds as the decimal nanosecond string OTLP wants. Built as text: nanoseconds
 * since 1970 are past what a double holds exactly.
 */
export function toNanos(ms: number): string {
  const whole = Math.floor(ms);
  const fraction = Math.round((ms - whole) * 1e6);
  return fraction >= 1e6 ? `${whole + 1}000000` : `${whole}${String(fraction).padStart(6, '0')}`;
}

/** One OTLP AnyValue. */
export function anyValue(value: unknown, depth = 0): Record<string, unknown> {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
  if (value instanceof Error) return { stringValue: `${value.name}: ${value.message}` };
  if (value === null || value === undefined) return { stringValue: '' };
  if (depth < 4 && Array.isArray(value)) return { arrayValue: { values: value.map((v) => anyValue(v, depth + 1)) } };
  if (depth < 4 && typeof value === 'object') return { kvlistValue: { values: keyValues(value as Record<string, unknown>, depth + 1) } };
  return { stringValue: safeString(value) };
}

/** An attribute map as an OTLP KeyValue list. `undefined` values are left out. */
export function keyValues(attributes: Record<string, unknown>, depth = 0): Array<{ key: string; value: unknown }> {
  const out: Array<{ key: string; value: unknown }> = [];
  for (const key in attributes) {
    const value = attributes[key];
    if (value !== undefined) out.push({ key, value: anyValue(value, depth) });
  }
  return out;
}

export function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/** Run `fn`, swallowing anything it throws: the SDK must never break the page it is on. */
export function safely<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

export const isBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined';

/** UTF-8 byte length. */
export function byteLength(text: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length * 2;
}
