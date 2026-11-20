/**
 * @zharp/node: headers on HTTP spans, failed queries reported with the app's call site, and
 * errors a framework answers with a 5xx. The modules are bundled from source with esbuild and
 * driven with stand-in spans, so no database is needed.
 *
 *     node test/query-errors.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'packages', 'node', 'src');
// Inside the package, so the bundles' @opentelemetry imports resolve as the build's do.
const tmp = mkdtempSync(join(here, '..', 'packages', 'node', '.test-'));

async function load(name) {
  const outfile = join(tmp, `${name}.mjs`);
  await esbuild.build({
    entryPoints: [join(src, `${name}.ts`)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    external: ['@opentelemetry/*'],
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}


const db = await load('db-errors');
const headers = await load('headers');
const framework = await load('framework-errors');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

const ERROR = 2;
const SERVER = 1;
const INTERNAL = 0;
const CLIENT = 2;
let nextSpan = 1;
const TRACE = 'a'.repeat(32);

function span({ attributes = {}, kind = CLIENT, parent = true, traceId = TRACE } = {}) {
  const id = String(nextSpan++).padStart(16, '0');
  const s = {
    attributes,
    kind,
    events: [],
    status: { code: 0 },
    parentSpanContext: parent ? { traceId, spanId: 'f'.repeat(16), isRemote: false } : undefined,
    spanContext: () => ({ traceId, spanId: id, traceFlags: 1 }),
    recordException(exception) {
      this.events.push(exception);
    },
  };
  return s;
}

/** A query run from a named function, as an app's service method would. */
function runQueryFrom(processor, s) {
  function createUser() {
    processor.onStart(s);
  }
  createUser();
}

console.log('\nquery errors');

await test('the type comes from the driver code', () => {
  assert.equal(db.dbErrorType('postgresql', '23505'), 'UniqueViolation');
  assert.equal(db.dbErrorType('postgresql', '23503'), 'ForeignKeyViolation');
  assert.equal(db.dbErrorType('postgresql', '40P01'), 'DeadlockDetected');
  assert.equal(db.dbErrorType('mysql', 'ER_DUP_ENTRY'), 'ER_DUP_ENTRY');
  // pg names its errors "error": no help.
  assert.equal(db.dbErrorType('postgresql', '99999', 'error'), 'PostgresError');
  assert.equal(db.dbErrorType('mongodb', null, 'MongoServerError'), 'MongoServerError');
  assert.equal(db.dbErrorType('redis', null), 'RedisError');
});

await test('the call site keeps the app frames and drops the SDK, OpenTelemetry and Node', () => {
  const stack = [
    'Error',
    '    at DbErrorSpanProcessor.onStart (/app/node_modules/@zharp/node/dist/index.js:1:1)',
    '    at Tracer.startSpan (/app/node_modules/@opentelemetry/sdk-trace/build/index.js:2:2)',
    '    at UsersService.create (/app/src/users/users.service.ts:42:18)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
    '    at UsersController.signup (/app/src/users/users.controller.ts:20:12)',
  ].join('\n');
  assert.deepEqual(db.callSiteFrames(stack), [
    '    at UsersService.create (/app/src/users/users.service.ts:42:18)',
    '    at UsersController.signup (/app/src/users/users.controller.ts:20:12)',
  ]);
});

await test('a failed query is reported once, caught, with its call site, statement and real message', async () => {
  const sent = [];
  const processor = new db.DbErrorSpanProcessor((failure) => sent.push(db.reportOf(failure)));
  const s = span({ attributes: { 'db.system': 'postgresql', 'db.statement': 'INSERT INTO users(email) VALUES($1)', 'db.name': 'shop' } });
  runQueryFrom(processor, s);
  // What the pg instrumentation does on failure.
  s.recordException("PostgreSQL error of type 'error' occurred (code: 23505)");
  s.status = { code: ERROR };
  s.attributes['error.type'] = '23505';
  processor.onEnd(s);
  assert.equal(s.events.length, 0, 'the scrubbed exception is not put on the span');
  const driverError = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), { name: 'error', code: '23505', constraint: 'users_email_key' });
  processor.attach(TRACE, driverError);
  processor.attach(TRACE, driverError);
  // The request ends normally: the app caught it.
  const request = span({ kind: SERVER, parent: false });
  processor.onEnd(request);
  assert.equal(sent.length, 1);
  const [report] = sent;
  assert.equal(report.type, 'UniqueViolation');
  assert.equal(report.message, 'duplicate key value violates unique constraint "users_email_key"');
  assert.match(report.stack, /^UniqueViolation: duplicate key/);
  assert.match(report.stack, /at createUser \(/, 'the stack is where the query was run from');
  assert.doesNotMatch(report.stack, /onStart/);
  assert.equal(report.attributes['db.statement'], 'INSERT INTO users(email) VALUES($1)');
  assert.equal(report.attributes['db.error.code'], '23505');
  assert.equal(report.attributes['db.error.constraint'], 'users_email_key');
  assert.equal(report.spanContext.spanId, s.spanContext().spanId, 'sent in the query span');
});

await test('without the driver error the scrubbed message is made readable', () => {
  const report = db.reportOf({
    spanContext: {}, traceId: TRACE, system: 'postgresql', statement: null, database: null, code: '23505', frames: [],
    scrubbed: "PostgreSQL error of type 'error' occurred (code: 23505)",
  });
  assert.equal(report.type, 'UniqueViolation');
  assert.equal(report.message, 'Postgres error (code: 23505)');
});

await test('an error the framework reports claims its query: not sent again as caught', () => {
  const sent = [];
  const processor = new db.DbErrorSpanProcessor((failure) => sent.push(failure));
  const s = span({ attributes: { 'db.system': 'postgresql' } });
  runQueryFrom(processor, s);
  s.status = { code: ERROR };
  processor.onEnd(s);
  const driverError = Object.assign(new Error('boom'), { code: '23505' });
  processor.attach(TRACE, driverError);
  // TypeORM wraps the driver's error.
  const wrapped = Object.assign(new Error('QueryFailedError: boom'), { driverError });
  const claimed = processor.consume(TRACE, wrapped);
  assert.ok(claimed);
  assert.equal(claimed.error, driverError);
  processor.onEnd(span({ kind: SERVER, parent: false }));
  assert.equal(sent.length, 0);
});

await test('a framework error with no seen driver error takes the request\'s latest failure', () => {
  const processor = new db.DbErrorSpanProcessor(() => {});
  const s = span({ attributes: { 'db.system': 'mysql' } });
  runQueryFrom(processor, s);
  s.status = { code: ERROR };
  processor.onEnd(s);
  assert.equal(processor.consume(TRACE, new Error('other'), false), null, 'not without asking');
  assert.ok(processor.consume(TRACE, new Error('other'), true));
});

await test('a query that is its own trace waits for a handler, then reports', async () => {
  const sent = [];
  const processor = new db.DbErrorSpanProcessor((failure) => sent.push(failure));
  const s = span({ attributes: { 'db.system': 'postgresql' }, parent: false, traceId: 'b'.repeat(32) });
  runQueryFrom(processor, s);
  s.status = { code: ERROR };
  processor.onEnd(s);
  assert.equal(sent.length, 0);
  await processor.forceFlush();
  assert.equal(sent.length, 1);
});

await test('spans that are not queries are left alone', () => {
  const processor = new db.DbErrorSpanProcessor(() => assert.fail('nothing to send'));
  const s = span({ kind: INTERNAL, attributes: { 'http.route': '/x' } });
  processor.onStart(s);
  s.recordException(new Error('kept'));
  assert.equal(s.events.length, 1);
  s.status = { code: ERROR };
  processor.onEnd(s);
});

console.log('\nheaders');

await test('headers are recorded, secrets filtered, long values cut', () => {
  const settings = headers.headerSettings(undefined, undefined);
  const out = headers.headerAttributes('request', {
    'User-Agent': 'curl/8', authorization: 'Bearer abc', cookie: 'sid=1', 'x-api-key': 'k', 'x-session-token': 't',
    accept: ['a', 'b'], 'x-long': 'y'.repeat(600),
  }, settings);
  assert.equal(out['http.request.header.user-agent'], 'curl/8');
  assert.equal(out['http.request.header.authorization'], '[Filtered]');
  assert.equal(out['http.request.header.cookie'], '[Filtered]');
  assert.equal(out['http.request.header.x-api-key'], '[Filtered]');
  assert.equal(out['http.request.header.x-session-token'], '[Filtered]');
  assert.equal(out['http.request.header.accept'], 'a, b');
  assert.equal(out['http.request.header.x-long'].length, 513);
});

await test('off by option or ZHARP_CAPTURE_HEADERS', () => {
  assert.equal(headers.headerSettings(false), null);
  assert.equal(headers.headerSettings(undefined, 'false'), null);
  assert.deepEqual(headers.headerSettings({ redact: ['x-tenant'] }).redact, ['x-tenant']);
});

console.log('\nframework errors');

await test('only 5xx and plain errors count as failures', () => {
  class HttpException extends Error {
    constructor(status) { super('x'); this.status = status; }
    getStatus() { return this.status; }
  }
  assert.equal(framework.statusOf(new Error('x')), 500);
  assert.equal(framework.statusOf(new HttpException(401)), 401);
  assert.equal(framework.statusOf(new HttpException(503)), 503);
  assert.equal(framework.statusOf(Object.assign(new Error('x'), { statusCode: 404 })), 404);
  assert.equal(framework.statusOf('text'), 500);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
