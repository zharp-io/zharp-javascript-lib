/**
 * The process's output as logs: everything written to stdout and stderr that the console
 * capture and the logging-library bridges didn't already send.
 *
 * Plenty of Node logging never touches `console`: NestJS's Logger, debug, log4js, signale,
 * hand-rolled loggers and libraries all write to `process.stdout` directly. This is the net
 * under the exact captures, so a line printed any way at all still arrives, in the request it
 * was written in. Each line still prints exactly as before.
 *
 * A line's level is read from the line itself: a JSON record's own level, NestJS's
 * `LOG`/`WARN`/`ERROR`, or a level word such as `ERROR` or `[warn]`; failing that, stdout is
 * info and stderr is a warning.
 */
import { context as otelContext, SeverityNumber, type Context, type Logger } from '@opentelemetry/api';
import type { LogRecordProcessor, ReadWriteLogRecord } from '@opentelemetry/sdk-logs';
import { alreadySent, isQuiet, quiet, rememberSent } from './capture-state';

type Level = [SeverityNumber, string];
const LEVELS: Record<string, Level> = {
  trace: [SeverityNumber.TRACE, 'TRACE'],
  verbose: [SeverityNumber.DEBUG, 'DEBUG'],
  debug: [SeverityNumber.DEBUG, 'DEBUG'],
  log: [SeverityNumber.INFO, 'INFO'],
  info: [SeverityNumber.INFO, 'INFO'],
  notice: [SeverityNumber.INFO, 'INFO'],
  warn: [SeverityNumber.WARN, 'WARN'],
  warning: [SeverityNumber.WARN, 'WARN'],
  error: [SeverityNumber.ERROR, 'ERROR'],
  err: [SeverityNumber.ERROR, 'ERROR'],
  crit: [SeverityNumber.FATAL, 'FATAL'],
  critical: [SeverityNumber.FATAL, 'FATAL'],
  fatal: [SeverityNumber.FATAL, 'FATAL'],
  emerg: [SeverityNumber.FATAL, 'FATAL'],
  alert: [SeverityNumber.FATAL, 'FATAL'],
};
/** pino and bunyan write their level as a number. */
const NUMERIC: Array<[number, string]> = [[60, 'fatal'], [50, 'error'], [40, 'warn'], [30, 'info'], [20, 'debug'], [0, 'trace']];

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** `[Nest] 61  - 11/17/2026, 8:33:00 AM     LOG [Context] message` */
const NEST = /^\[Nest\]\s+\d+\s+-\s+.*?\s+(LOG|ERROR|WARN|DEBUG|VERBOSE|FATAL)\s+(?:\[([^\]]+)\]\s+)?([\s\S]*)$/;
/** The first level word in the opening of a line: `ERROR`, `[warn]`, `level=error`, `W/`. */
const WORD = /(?:^|[\s[(|:=])(trace|verbose|debug|info|notice|warn(?:ing)?|err(?:or)?|crit(?:ical)?|fatal|emerg|alert)(?=$|[\s\]):|,])/i;

const MAX_LINE = 32 * 1024;
const FLUSH_MS = 200;

interface Parsed {
  level: Level | null;
  body: string;
  attributes: Record<string, string>;
}

function levelOf(value: unknown): Level | null {
  if (typeof value === 'number') {
    const found = NUMERIC.find(([n]) => value >= n);
    return found ? LEVELS[found[1]] : null;
  }
  return typeof value === 'string' ? LEVELS[value.toLowerCase()] ?? null : null;
}

/** A line, read for its level and, for the formats worth knowing, its own message. */
export function parseLine(raw: string): Parsed {
  const line = raw.replace(ANSI, '').replace(/\s+$/, '');
  if (line.startsWith('{') && line.endsWith('}')) {
    try {
      const record = JSON.parse(line);
      const message = record.msg ?? record.message ?? record.event;
      return {
        level: levelOf(record.level ?? record.severity ?? record.lvl),
        body: typeof message === 'string' ? message : line,
        attributes: {},
      };
    } catch {
      // Not JSON after all; read it as text.
    }
  }
  const nest = NEST.exec(line);
  if (nest) {
    return {
      level: LEVELS[nest[1].toLowerCase()],
      body: nest[3],
      attributes: nest[2] ? { 'log.logger': nest[2] } : {},
    };
  }
  const word = WORD.exec(line.slice(0, 120));
  return { level: word ? LEVELS[word[1].toLowerCase()] ?? null : null, body: line, attributes: {} };
}

/**
 * Remembers what every other capture sent (the logging-library bridges, Zharp.log, the
 * console), so the same line reaching the output a moment later isn't sent twice.
 */
export class SentLineProcessor implements LogRecordProcessor {
  onEmit(record: ReadWriteLogRecord): void {
    const source = record.attributes?.['log.source'];
    if (source !== 'stdout' && source !== 'stderr') rememberSent(record.body);
  }
  forceFlush(): Promise<void> { return Promise.resolve(); }
  shutdown(): Promise<void> { return Promise.resolve(); }
}

/**
 * Tap stdout and stderr. Returns the undo.
 */
export function captureOutput(logger: Logger): () => void {
  const undo: Array<() => void> = [];

  for (const [stream, name, fallback] of [
    [process.stdout, 'stdout', LEVELS.info],
    [process.stderr, 'stderr', LEVELS.warn],
  ] as const) {
    if (!stream || typeof stream.write !== 'function' || (stream.write as any).__zharp) continue;
    const original = stream.write;
    let pending = '';
    let pendingContext: Context | undefined;
    let timer: NodeJS.Timeout | undefined;

    const emitLine = (line: string, ctx: Context | undefined) => {
      if (!line.trim() || line.includes('[Zharp]') || alreadySent(line)) return;
      const parsed = parseLine(line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line);
      if (!parsed.body.trim()) return;
      const [severityNumber, severityText] = parsed.level ?? fallback;
      quiet(() => logger.emit({
        severityNumber,
        severityText,
        body: parsed.body,
        attributes: { 'log.source': name, 'log.iostream': name, ...parsed.attributes },
        ...(ctx ? { context: ctx } : {}),
      }));
    };

    const flush = () => {
      timer = undefined;
      const line = pending;
      const ctx = pendingContext;
      pending = '';
      pendingContext = undefined;
      emitLine(line, ctx);
    };

    const take = (chunk: unknown, encoding: unknown) => {
      if (isQuiet()) return;
      const text = typeof chunk === 'string'
        ? chunk
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString(typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8')
          : '';
      if (!text) return;
      // A line belongs to the request it started in.
      if (!pending) pendingContext = otelContext.active();
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      const ctx = pendingContext;
      if (pending) pendingContext = otelContext.active();
      for (const line of lines) emitLine(line, ctx);
      if (pending.length > MAX_LINE) flush();
      else if (pending && !timer) {
        timer = setTimeout(flush, FLUSH_MS);
        timer.unref?.();
      }
    };

    const patched = function (this: unknown, chunk: unknown, encoding?: unknown, callback?: unknown) {
      try {
        take(chunk, encoding);
      } catch {
        // A line that could not be copied is not worth an exception in the caller.
      }
      return (original as any).call(this ?? stream, chunk, encoding, callback);
    };
    (patched as any).__zharp = true;
    stream.write = patched as typeof stream.write;
    undo.push(() => {
      if (timer) clearTimeout(timer);
      if (pending) flush();
      stream.write = original;
    });
  }

  return () => undo.forEach((fn) => fn());
}
