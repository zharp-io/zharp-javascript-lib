/**
 * D1: a CLIENT span per query (`prepare().first()/all()/run()/raw()`, `batch()`, `exec()`), and
 * failed queries as errors that say where they came from.
 *
 * D1's error is made when the database's answer comes back, so its stack is D1's own code, not
 * the line of the app that ran the query. That line is taken when the query starts, and kept:
 * a failure is reported with it as its stack, the SQL, and SQLite's code — once. If the error
 * then reaches the handler (it threw it on), it is reported there as unhandled with these
 * details; if the app caught it, it is reported as handled when the request ends.
 */
import { debugIdAttributes } from '@zharp/internal/debug-ids';
import { safely } from '../../browser/src/util';
import { activeContext, requestOf, SpanKind, SpanStatusCode, startSpan, type ZharpSpan } from './tracing';
import type { RequestState } from './state';

export interface QueryFailure {
  error: unknown;
  span: ZharpSpan;
  claimed: boolean;
  attributes: Record<string, string>;
  exception(handled: boolean): Record<string, string>;
}

const failures = new WeakMap<object, QueryFailure>();

/** The failed query `value` came from, marked as reported. */
export function claimQueryFailure(value: unknown): QueryFailure | undefined {
  const failure = value && typeof value === 'object' ? failures.get(value) : undefined;
  if (failure) failure.claimed = true;
  return failure;
}

export function unclaimedQueryFailures(state: RequestState): QueryFailure[] {
  return state.queryFailures.filter((failure) => !failure.claimed);
}

/** The frames of the app's call into `boundary`, innermost first. */
function callSite(boundary: Function): string[] {
  const holder: { stack?: string } = {};
  const limit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 40;
    (Error as any).captureStackTrace?.(holder, boundary);
  } finally {
    Error.stackTraceLimit = limit;
  }
  return (holder.stack ?? '').split('\n').slice(1).filter((line) => /^\s+at /.test(line));
}

/** SQLite's result code at the end of a D1 message ("…: SQLITE_CONSTRAINT"), if any. */
export function sqliteCode(message: string): string | undefined {
  return /\b(SQLITE_[A-Z_]+)\b/.exec(message)?.[1];
}

const operationOf = (sql: string) => /^\s*(\w+)/.exec(sql)?.[1]?.toUpperCase() ?? 'QUERY';
const MAX_SQL = 4000;

function queryFailure(error: unknown, span: ZharpSpan, sql: string, database: string, frames: string[]): QueryFailure {
  const message = (error as Error)?.message ?? String(error);
  const code = sqliteCode(message);
  const type = 'D1Error';
  const attributes: Record<string, string> = {
    'zharp.mechanism': 'db',
    'db.system': 'sqlite',
    'db.statement': sql.slice(0, MAX_SQL),
    'db.name': database,
    ...(code ? { 'db.error.code': code } : {}),
  };
  return {
    error,
    span,
    claimed: false,
    attributes,
    exception(handled) {
      const stack = [`${type}: ${message}`, ...frames].join('\n');
      return {
        'exception.type': type,
        'exception.message': message,
        'exception.stacktrace': stack,
        'zharp.handled': handled ? 'true' : 'false',
        ...debugIdAttributes(stack),
      };
    },
  };
}

interface Query {
  database: string;
  sql: string;
  operation: string;
  frames: string[];
  captureErrors: boolean;
}

/** Run one query in its span. */
async function traced<T>(query: Query, run: () => Promise<T>): Promise<T> {
  const ctx = activeContext();
  const state = requestOf(ctx);
  if (!state) return run();
  const span = startSpan(`${query.operation} ${query.database}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      'db.system': 'sqlite',
      'db.system.name': 'sqlite',
      'db.namespace': query.database,
      'db.operation.name': query.operation,
      'db.statement': query.sql.slice(0, MAX_SQL),
      'db.query.text': query.sql.slice(0, MAX_SQL),
      'cloudflare.binding.type': 'd1',
    },
  }, ctx);
  try {
    const result = await run();
    safely(() => {
      const meta = (result as any)?.meta ?? (Array.isArray(result) ? (result as any)[0]?.meta : undefined);
      if (meta) {
        span.setAttributes({
          'cloudflare.d1.rows_read': meta.rows_read,
          'cloudflare.d1.rows_written': meta.rows_written,
          'cloudflare.d1.served_by': meta.served_by,
        });
      }
      const rows = (result as any)?.results;
      if (Array.isArray(rows)) span.setAttribute('db.response.returned_rows', rows.length);
    });
    return result;
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message });
    const code = sqliteCode(message);
    if (code) span.setAttribute('db.response.status_code', code);
    if (query.captureErrors && error && typeof error === 'object' && !failures.has(error)) {
      const failure = queryFailure(error, span, query.sql, query.database, query.frames);
      failures.set(error, failure);
      state.queryFailures.push(failure);
    }
    throw error;
  } finally {
    span.end();
  }
}

/** Our statement proxy → D1's own statement, for `batch()`; and its SQL, for naming the batch. */
const originals = new WeakMap<object, object>();
const sqlOf = new WeakMap<object, string>();
const RUNS = new Set(['first', 'all', 'run', 'raw']);

function wrapStatement(statement: any, sql: string, database: string, captureErrors: boolean): any {
  const proxy = new Proxy(statement, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop === 'bind') {
        return (...args: unknown[]) => wrapStatement(value.apply(target, args), sql, database, captureErrors);
      }
      if (typeof prop === 'string' && RUNS.has(prop)) {
        const run = function (...args: unknown[]) {
          const frames = callSite(run);
          return traced({ database, sql, operation: operationOf(sql), frames, captureErrors }, () => value.apply(target, args));
        };
        return run;
      }
      return value.bind(target);
    },
  });
  originals.set(proxy, statement);
  sqlOf.set(proxy, sql);
  return proxy;
}

/** A D1 database (or one of its sessions) whose queries are traced. */
export function wrapD1(db: any, database: string, captureErrors: boolean): any {
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop === 'prepare') {
        return (sql: string) => wrapStatement(value.call(target, sql), String(sql ?? ''), database, captureErrors);
      }
      if (prop === 'batch') {
        const batch = function (statements: unknown[]) {
          const frames = callSite(batch);
          const list = Array.isArray(statements) ? statements : [];
          const sql = list.map((s) => (s && typeof s === 'object' ? sqlOf.get(s) : undefined) ?? '?').join(';\n');
          const real = list.map((s) => (s && typeof s === 'object' ? originals.get(s) ?? s : s));
          return traced({ database, sql, operation: 'BATCH', frames, captureErrors }, () => value.call(target, real));
        };
        return batch;
      }
      if (prop === 'exec') {
        const exec = function (sql: string) {
          const frames = callSite(exec);
          return traced({ database, sql: String(sql ?? ''), operation: operationOf(String(sql ?? '')), frames, captureErrors }, () => value.call(target, sql));
        };
        return exec;
      }
      if (prop === 'withSession') {
        return (...args: unknown[]) => wrapD1(value.apply(target, args), database, captureErrors);
      }
      return value.bind(target);
    },
  });
}
