/**
 * Trace and span identifiers, as W3C Trace Context defines them: a trace ID is 16 random bytes
 * and a span ID is 8, both written as lowercase hex.
 *
 * These are generated in the SDK rather than server-side because a trace ID has to exist before
 * the first request leaves — it is what the header carries, and what lets a browser span and the
 * backend span it caused end up in the same trace.
 */

/**
 * Fill a byte array with random values.
 *
 * `crypto.getRandomValues` is present in every browser and in Node 18+, so it is the normal
 * path. The fallback is not a security decision — a span ID is not a secret — but a collision
 * one: `Math.random` still gives enough entropy over 8 bytes that two spans colliding inside a
 * single trace is not a practical concern.
 */
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const webCrypto = typeof globalThis !== 'undefined' ? (globalThis as any).crypto : undefined;

  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(bytes);
    return bytes;
  }

  for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** A new 32-character trace ID. */
export function newTraceId(): string {
  return toHex(randomBytes(16));
}

/** A new 16-character span ID. */
export function newSpanId(): string {
  return toHex(randomBytes(8));
}

/** All-zero IDs are reserved by the spec and mean "absent", so they are never valid. */
const INVALID_TRACE = '00000000000000000000000000000000';
const INVALID_SPAN = '0000000000000000';

export function isValidTraceId(id: string): boolean {
  return /^[0-9a-f]{32}$/.test(id) && id !== INVALID_TRACE;
}

export function isValidSpanId(id: string): boolean {
  return /^[0-9a-f]{16}$/.test(id) && id !== INVALID_SPAN;
}
