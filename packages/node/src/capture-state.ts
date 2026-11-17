/**
 * What the log captures share, so a line is sent once however many of them see it.
 *
 * The console capture and the logging-library bridges send a line with its exact level; the
 * output capture (stdout.ts) is the net under them, for whatever writes to the process's output
 * some other way. While a captured call is printing, the output capture stands aside; and a line
 * a bridge sent a moment ago is recognised when it then reaches the output (winston's console
 * transport, for one, prints after its bridge has already sent the record).
 */

/** Above zero while a capture is printing a line it has already sent, or the SDK is exporting. */
let depth = 0;

export function quiet<T>(fn: () => T): T {
  depth++;
  try {
    return fn();
  } finally {
    depth--;
  }
}

export const isQuiet = () => depth > 0;

/** Bodies sent in the last few seconds, by a capture other than the output's. */
const RECENT_MS = 3000;
const RECENT_MAX = 500;
const recent: Array<{ at: number; text: string }> = [];

const normalise = (text: string) => text.replace(/\s+/g, ' ').trim();

export function rememberSent(body: unknown): void {
  if (typeof body !== 'string') return;
  const text = normalise(body);
  if (text.length < 4) return;
  recent.push({ at: Date.now(), text });
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
}

/** Whether a printed line is one a capture already sent: its text contains a recent body. */
export function alreadySent(line: string): boolean {
  const now = Date.now();
  while (recent.length && now - recent[0].at > RECENT_MS) recent.shift();
  if (!recent.length) return false;
  const text = normalise(line);
  for (let i = recent.length - 1; i >= 0; i--) {
    if (text.includes(recent[i].text)) {
      recent.splice(i, 1);
      return true;
    }
  }
  return false;
}
