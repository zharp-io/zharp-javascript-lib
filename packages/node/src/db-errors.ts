/**
 * Failed database queries as errors that say where they came from.
 *
 * A driver's error is created when the database's reply is parsed — its stack is the driver's
 * socket code, not the line of the app that ran the query. So the call site is taken when the
 * query's span starts (synchronously, inside the app's call), and kept until the query ends.
 * When it fails, the error is reported with that call site as its stack, the statement, the
 * database and the driver's code, its type named from the code (23505 → UniqueViolation).
 *
 * One report per failure:
 * - The instrumentation's own "exception" event on the query's span is not recorded (it is a
 *   scrubbed one-liner with no type or stack, and the server would make a second error of it).
 * - If the error then reaches a framework's error handler and becomes a 5xx, it is reported
 *   there as a crash, with this query's details merged in (see `consume`).
 * - Otherwise it is reported as caught once the request (or, outside a request, a moment) ends.
 */
import { context, createContextKey, SpanKind, SpanStatusCode, trace, type Context, type Exception, type SpanContext } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace';
import { InstrumentationBase, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation';
import { VERSION } from './version';

/** What a failed query tells: where, what, and the driver's own error once it is seen. */
export interface DbFailure {
  spanContext: SpanContext;
  traceId: string;
  system: string;
  statement: string | null;
  database: string | null;
  code: string | null;
  /** The call site: frames of the app's call that ran the query, innermost first. */
  frames: string[];
  /** The instrumentation's scrubbed message, when the real error never came by. */
  scrubbed: string | null;
  /** The driver's error, when the query wrapper saw it. */
  error?: Error & { code?: string; constraint?: string };
  done?: boolean;
}

/** A report ready to send: an error type, its message, a stack, and attributes about the query. */
export interface DbErrorReport {
  type: string;
  message: string;
  stack: string;
  attributes: Record<string, string>;
  spanContext: SpanContext;
}

/** PostgreSQL's SQLSTATE codes people meet, by the names Postgres gives them. */
const SQLSTATE: Record<string, string> = {
  '23505': 'UniqueViolation', '23503': 'ForeignKeyViolation', '23502': 'NotNullViolation', '23514': 'CheckViolation',
  '23P01': 'ExclusionViolation', '22001': 'StringDataRightTruncation', '22003': 'NumericValueOutOfRange',
  '22P02': 'InvalidTextRepresentation', '22007': 'InvalidDatetimeFormat', '22008': 'DatetimeFieldOverflow', '22012': 'DivisionByZero',
  '42P01': 'UndefinedTable', '42703': 'UndefinedColumn', '42883': 'UndefinedFunction', '42601': 'SyntaxError', '42501': 'InsufficientPrivilege',
  '40001': 'SerializationFailure', '40P01': 'DeadlockDetected', '55P03': 'LockNotAvailable', '57014': 'QueryCanceled',
  '53300': 'TooManyConnections', '08006': 'ConnectionFailure', '08001': 'ConnectionRefused', '28P01': 'InvalidPassword', '3D000': 'InvalidCatalogName',
};

const SYSTEM_NAMES: Record<string, string> = { postgresql: 'Postgres', mysql: 'MySQL', mariadb: 'MariaDB', mongodb: 'Mongo', redis: 'Redis', mssql: 'SqlServer', oracle: 'Oracle', sqlite: 'Sqlite' };

/** The type an error from a failed query is grouped under. */
export function dbErrorType(system: string, code: string | null, name?: string): string {
  if (code && system === 'postgresql' && SQLSTATE[code]) return SQLSTATE[code];
  // mysql2's codes are names already: ER_DUP_ENTRY.
  if (code && /^ER_[A-Z_]+$/.test(code)) return code;
  if (name && !/^(error|Error|DatabaseError)$/.test(name)) return name;
  return `${SYSTEM_NAMES[system] ?? 'Database'}Error`;
}

/** Frames of a stack that belong to the app's call: not this SDK, OpenTelemetry or Node's internals. */
export function callSiteFrames(stack: string | undefined): string[] {
  const frames = (stack ?? '')
    .split('\n')
    .slice(1)
    .filter((line) => /^\s+at /.test(line))
    .filter((line) => !/[\\/]@opentelemetry[\\/]|[\\/]@zharp[\\/]|\(node:|\bnode:internal\b|[\\/]require-in-the-middle[\\/]|[\\/]import-in-the-middle[\\/]/.test(line));
  // A query builder or ORM between the app and the driver: start at the app's own frame.
  const firstApp = frames.findIndex((line) => !/[\\/]node_modules[\\/]/.test(line));
  return (firstApp > 0 ? frames.slice(firstApp) : frames).slice(0, 40);
}

/** The app's call that ran a query, carried from the driver's `query()` to the query's span. */
const CALL_SITE = createContextKey('zharp.db.callSite');

/** The stack of the call into `fn`, from its caller on. */
function stackFrom(fn: Function): string | undefined {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  const holder: { stack?: string } = {};
  Error.captureStackTrace(holder, fn);
  Error.stackTraceLimit = limit;
  return holder.stack;
}

const attr = (attributes: Record<string, unknown>, ...names: string[]): string | null => {
  for (const name of names) {
    const value = attributes[name];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return null;
};

/** The report for a failed query, from what was seen of it. */
export function reportOf(failure: DbFailure): DbErrorReport {
  const error = failure.error;
  const code = (error?.code !== undefined ? String(error.code) : null) ?? failure.code;
  const type = dbErrorType(failure.system, code, error?.name);
  const message = error?.message || failure.scrubbed?.replace(/^.*?error of type '[^']*' occurred/i, `${SYSTEM_NAMES[failure.system] ?? 'Database'} error`) || 'The query failed';
  const stack = [`${type}: ${message}`, ...failure.frames].join('\n');
  const attributes: Record<string, string> = {
    'zharp.mechanism': 'db',
    'db.system': failure.system,
    ...(failure.statement ? { 'db.statement': failure.statement.slice(0, 4000) } : {}),
    ...(failure.database ? { 'db.name': failure.database } : {}),
    ...(code ? { 'db.error.code': code } : {}),
    ...(error?.constraint ? { 'db.error.constraint': error.constraint } : {}),
  };
  return { type, message, stack, attributes, spanContext: failure.spanContext };
}

/** How long a failed query outside any request waits for a framework to claim it. */
const LONE_WAIT_MS = 1500;
const MAX_PENDING = 200;

/**
 * Watches database spans: their call site when they start, their failure when they end.
 * `send` reports, as caught, what nothing else claimed.
 */
export class DbErrorSpanProcessor implements SpanProcessor {
  private readonly callSites = new WeakMap<object, { frames: string[]; exception?: Exception }>();
  /** Failures not yet reported, by trace. */
  private readonly pending = new Map<string, DbFailure[]>();

  constructor(private readonly send: (failure: DbFailure) => void) { }

  onStart(span: Span, parentContext?: Context): void {
    const attributes = (span as unknown as ReadableSpan).attributes ?? {};
    if (!attr(attributes, 'db.system', 'db.system.name')) return;
    // The driver wrapper's capture when there is one: a pooled query's span starts in the pool's
    // callback, long after the app's call. Else the stack here, from the caller of onStart on.
    const carried = (parentContext ?? context.active()).getValue(CALL_SITE) as string | undefined;
    const entry: { frames: string[]; exception?: Exception } = {
      frames: callSiteFrames(carried ?? stackFrom(DbErrorSpanProcessor.prototype.onStart)),
    };
    this.callSites.set(span, entry);
    // The instrumentation's exception is kept here, not as an event: it becomes the report below.
    const record = span.recordException.bind(span);
    span.recordException = (exception: Exception, time?: Parameters<Span['recordException']>[1]) => {
      if (entry.exception === undefined) entry.exception = exception;
      else record(exception, time);
    };
  }

  onEnd(span: ReadableSpan): void {
    const entry = this.callSites.get(span);
    if (entry && span.status.code === SpanStatusCode.ERROR) {
      const attributes = span.attributes ?? {};
      const exception = entry.exception;
      const failure: DbFailure = {
        spanContext: span.spanContext(),
        traceId: span.spanContext().traceId,
        system: attr(attributes, 'db.system', 'db.system.name') ?? 'database',
        statement: attr(attributes, 'db.statement', 'db.query.text'),
        database: attr(attributes, 'db.name', 'db.namespace'),
        code: attr(attributes, 'error.type', 'db.response.status_code'),
        frames: entry.frames,
        scrubbed: typeof exception === 'string' ? exception : (exception as { message?: string } | undefined)?.message ?? span.status.message ?? null,
        ...(exception instanceof Error ? { error: exception } : {}),
      };
      this.add(failure);
    }
    // The request (or the job) is over: whatever failed in it and wasn't claimed was caught by
    // the app. Not at once when the trace's root failed or was the query itself: the error may
    // still be on its way to a handler or to an unhandled rejection, which report it themselves.
    const root = span.kind === SpanKind.SERVER || !span.parentSpanContext || !!span.parentSpanContext.isRemote;
    if (root) {
      const traceId = span.spanContext().traceId;
      if (!this.pending.has(traceId)) return;
      if (entry || span.status.code === SpanStatusCode.ERROR) setTimeout(() => this.flush(traceId), LONE_WAIT_MS).unref?.();
      else this.flush(traceId);
    }
  }

  private add(failure: DbFailure): void {
    const list = this.pending.get(failure.traceId) ?? [];
    list.push(failure);
    this.pending.set(failure.traceId, list);
    if (this.pending.size > MAX_PENDING) this.flush(this.pending.keys().next().value!);
  }

  /** The driver's error, seen by the query wrapper: joined to the trace's latest failure. */
  attach(traceId: string | undefined, error: unknown): void {
    if (!traceId || !(error instanceof Error)) return;
    const list = this.pending.get(traceId);
    if (!list || list.some((f) => f.error === error)) return;
    const failure = [...list].reverse().find((f) => !f.error && !f.done);
    if (failure) failure.error = error as DbFailure['error'];
  }

  /**
   * `error` is being reported (by a framework's handler, as unhandled, or by captureError): the
   * failed query it came from, if any, so its details go into that one report and it isn't sent
   * again. Matched by the error itself, or what wraps it (`driverError`, `cause`); `latest` also
   * takes the request's latest failure whose driver error was never seen.
   */
  consume(traceId: string | undefined, error: unknown, latest = false): DbFailure | null {
    const inner = (candidate: unknown): unknown[] => {
      if (!candidate || typeof candidate !== 'object') return [];
      const c = candidate as { driverError?: unknown; cause?: unknown; originalError?: unknown };
      return [candidate, c.driverError, c.cause, c.originalError].filter(Boolean);
    };
    const wanted = inner(error);
    const lists = traceId ? [this.pending.get(traceId) ?? []] : [...this.pending.values()];
    for (const list of lists) {
      const failure = list.find((f) => !f.done && f.error && wanted.includes(f.error))
        ?? (latest && traceId ? [...list].reverse().find((f) => !f.done && !f.error) : undefined);
      if (failure) {
        failure.done = true;
        return failure;
      }
    }
    return null;
  }

  flush(traceId: string): void {
    const list = this.pending.get(traceId);
    if (!list) return;
    this.pending.delete(traceId);
    for (const failure of list) if (!failure.done) this.send(failure);
  }

  forceFlush(): Promise<void> {
    for (const traceId of [...this.pending.keys()]) this.flush(traceId);
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this.forceFlush();
  }
}

/**
 * Sees the driver's own error as a query fails, so the report has the real message and code
 * ("duplicate key value violates unique constraint "user_email_key"", 23505) rather than the
 * instrumentation's scrubbed line. Wraps pg's Client and Pool `query`, where it also takes the
 * app's call site for the query's span (a pooled query's span starts later, in the pool's
 * callback). The error goes on its way untouched.
 */
export class DbDriverErrorsInstrumentation extends InstrumentationBase {
  constructor(private readonly onError: (traceId: string | undefined, error: unknown) => void) {
    super('@zharp/node/db-driver-errors', VERSION, {});
  }

  protected init() {
    // Read when a query fails, not now: the base class calls init() before this class's fields are set.
    const onError = (traceId: string | undefined, err: unknown) => {
      try {
        this.onError(traceId, err);
      } catch {
        // Never break a query over its telemetry.
      }
    };
    const wrapQuery = (original: (...args: unknown[]) => unknown) => {
      const run = (self: unknown, args: unknown[]) => {
        const traceId = trace.getActiveSpan()?.spanContext().traceId;
        const callback = args.findIndex((a) => typeof a === 'function');
        if (callback >= 0) {
          const cb = args[callback] as (err: unknown, ...rest: unknown[]) => unknown;
          args[callback] = function (this: unknown, err: unknown, ...rest: unknown[]) {
            if (err) onError(traceId, err);
            return cb.call(this, err, ...rest);
          };
          return original.apply(self, args);
        }
        const result = original.apply(self, args) as { then?: unknown; submit?: unknown } | undefined;
        // A Submittable (a cursor, a stream) is returned as it is: it's not a promise.
        if (!result || typeof result.then !== 'function' || typeof result.submit === 'function') return result;
        (result as Promise<unknown>).then(undefined, (err: unknown) => onError(traceId, err));
        return result;
      };
      return function query(this: unknown, ...args: unknown[]) {
        // The first wrapper the app's call meets (Pool.query, or Client.query called directly) takes the stack.
        const active = context.active();
        if (active.getValue(CALL_SITE) !== undefined) return run(this, args);
        return context.with(active.setValue(CALL_SITE, stackFrom(query)), () => run(this, args));
      };
    };
    const patch = (moduleExports: any) => {
      for (const target of [moduleExports?.Client?.prototype, moduleExports?.Pool?.prototype]) {
        if (target?.query && !target.query.__zharpWrapped) {
          const wrapped = wrapQuery(target.query);
          (wrapped as any).__zharpWrapped = true;
          (wrapped as any).__zharpOriginal = target.query;
          target.query = wrapped;
        }
      }
      return moduleExports;
    };
    const unpatch = (moduleExports: any) => {
      for (const target of [moduleExports?.Client?.prototype, moduleExports?.Pool?.prototype]) {
        if (target?.query?.__zharpOriginal) target.query = target.query.__zharpOriginal;
      }
    };
    return [new InstrumentationNodeModuleDefinition('pg', ['>=8 <9'], patch, unpatch)];
  }
}
