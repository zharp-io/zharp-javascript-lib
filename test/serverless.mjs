/**
 * @zharp/node in serverless functions: Zharp.lambda, Zharp.azureFunction, Zharp.cloudFunction.
 * Each platform runs in its own process (test/serverless/app.mjs) against a fake OTLP endpoint
 * that decodes the protobuf it receives, so spans and their attributes can be checked one by
 * one. Run `pnpm --filter @zharp/node build` first.
 *
 *     node test/serverless.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// ── OTLP protobuf, decoded just far enough ──────────────────────────────────

function fields(buf) {
  const out = [];
  let i = 0;
  const varint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = buf[i++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const key = Number(varint());
    const no = key >> 3;
    const type = key & 7;
    if (type === 0) out.push([no, varint()]);
    else if (type === 1) out.push([no, buf.subarray(i, (i += 8))]);
    else if (type === 2) {
      const length = Number(varint());
      out.push([no, buf.subarray(i, (i += length))]);
    } else if (type === 5) out.push([no, buf.subarray(i, (i += 4))]);
    else throw new Error(`wire type ${type}`);
  }
  return out;
}
const all = (buf, n) => fields(buf).filter(([no]) => no === n).map(([, v]) => v);
const one = (buf, n) => all(buf, n)[0];
function anyValue(buf) {
  const [field] = fields(buf);
  if (!field) return undefined;
  const [no, v] = field;
  if (no === 1) return v.toString('utf8');
  if (no === 2) return v !== 0n;
  if (no === 3) return Number(BigInt.asIntN(64, v));
  if (no === 4) return v.readDoubleLE(0);
  return '[complex]';
}
const attributes = (buf, n) => Object.fromEntries(all(buf, n).map((kv) => [one(kv, 1).toString('utf8'), one(kv, 2) && anyValue(one(kv, 2))]));
const hex = (b) => (b && b.length ? b.toString('hex') : undefined);

function decodeTraces(buf) {
  return all(buf, 1).flatMap((rs) => {
    const resource = one(rs, 1) ? attributes(one(rs, 1), 1) : {};
    return all(rs, 2).flatMap((ss) =>
      all(ss, 2).map((s) => {
        const status = one(s, 15);
        return {
          traceId: hex(one(s, 1)),
          spanId: hex(one(s, 2)),
          parentSpanId: hex(one(s, 4)),
          name: one(s, 5)?.toString('utf8'),
          kind: Number(one(s, 6) ?? 0n),
          attrs: attributes(s, 9),
          status: status ? Number(one(status, 3) ?? 0n) : 0,
          resource,
        };
      }),
    );
  });
}

function decodeLogs(buf) {
  return all(buf, 1).flatMap((rl) =>
    all(rl, 2).flatMap((sl) =>
      all(sl, 2).map((l) => ({
        severity: Number(one(l, 2) ?? 0n),
        body: one(l, 5) && anyValue(one(l, 5)),
        attrs: attributes(l, 6),
        traceId: hex(one(l, 9)),
        spanId: hex(one(l, 10)),
      })),
    ),
  );
}

// ── fake endpoint ────────────────────────────────────────────────────────────

const spans = {};
const logs = {};
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let raw = Buffer.concat(chunks);
    if (req.headers['content-encoding'] === 'gzip') raw = gunzipSync(raw);
    const key = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (key === 'slow-key') return; // never answers
    if (req.url.endsWith('/v1/traces')) (spans[key] ??= []).push(...decodeTraces(raw));
    if (req.url.endsWith('/v1/logs')) (logs[key] ??= []).push(...decodeLogs(raw));
    res.writeHead(200, { 'content-type': 'application/x-protobuf' });
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;

function run(mode, key, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, 'serverless', 'app.mjs'), mode], {
      cwd: root,
      env: { ...process.env, ZHARP_TEST_ENDPOINT: endpoint, TEST_KEY: key, ...env },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    // What has arrived at the moment the function asks — right after its handler returned.
    child.on('message', (m) => {
      child.send({
        id: m.id,
        received: {
          invocations: (spans[m.key] ?? []).map((s) => s.attrs['faas.invocation_id']).filter(Boolean),
          logs: (logs[m.key] ?? []).map((l) => l.body),
        },
      });
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      resolve({ code, out, err, result: line ? JSON.parse(line.slice(7)) : null });
    });
  });
}

let failures = 0;
let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${String(error.message).split('\n').join('\n        ')}`);
  }
}

const TRACE = '0af7651916cd43dd8448eb211c80319c';
const PARENT = 'b7ad6b7169203331';
const SERVER = 2;
const ERROR = 2;
const byInvocation = (key, id) => (spans[key] ?? []).filter((s) => s.attrs['faas.invocation_id'] === id);
const step = (result, label) => result.invocations.find((i) => i.label === label);

// ── AWS Lambda ───────────────────────────────────────────────────────────────

console.log('\nZharp.lambda');
{
  const env = { AWS_LAMBDA_FUNCTION_NAME: 'orders-fn', AWS_REGION: 'eu-west-1', AWS_LAMBDA_FUNCTION_MEMORY_SIZE: '512' };
  const app = await run('lambda', 'lambda-key', env);
  assert.ok(app.result, app.err + app.out);
  const r = app.result;
  const api = byInvocation('lambda-key', 'req-api');
  const sqs = byInvocation('lambda-key', 'req-sqs');
  const fail = byInvocation('lambda-key', 'req-fail');
  const cb = byInvocation('lambda-key', 'req-cb');

  check('the handler keeps its arity and its results', () => {
    assert.equal(r.arity, 2);
    assert.deepEqual(r.apiResult, { statusCode: 201, body: '{"ok":true}' });
    assert.deepEqual(r.sqsResult, { batchItemFailures: [] });
    assert.equal(r.callbackArity, 3);
    assert.deepEqual(r.callbackResult, { err: null, value: { statusCode: 204 } });
  });
  check('one SERVER span per invocation', () => {
    for (const list of [api, sqs, fail, cb]) {
      assert.equal(list.length, 1, JSON.stringify(spans['lambda-key'].map((s) => s.name)));
      assert.equal(list[0].kind, SERVER);
    }
    assert.equal(spans['lambda-key'].filter((s) => s.kind === SERVER).length, 4);
  });
  check('API Gateway v2: named by route, HTTP attributes, status from the result', () => {
    const [s] = api;
    assert.equal(s.name, 'GET /items/{id}');
    assert.equal(s.attrs['http.request.method'], 'GET');
    assert.equal(s.attrs['url.path'], '/items/42');
    assert.equal(s.attrs['http.route'], '/items/{id}');
    assert.equal(s.attrs['http.response.status_code'], 201);
    assert.equal(s.attrs['client.address'], '203.0.113.9');
  });
  check("the caller's trace is continued from the event's headers", () => {
    assert.equal(api[0].traceId, TRACE);
    assert.equal(api[0].parentSpanId, PARENT);
    assert.notEqual(sqs[0].traceId, TRACE, 'an SQS event starts its own trace');
  });
  check('FaaS attributes: trigger, invocation id, name, cloud provider; coldstart on the first only', () => {
    assert.deepEqual(
      [api[0].attrs['faas.trigger'], sqs[0].attrs['faas.trigger']],
      ['http', 'pubsub'],
    );
    for (const s of [api[0], sqs[0], fail[0], cb[0]]) {
      assert.equal(s.attrs['faas.name'], 'orders-fn');
      assert.equal(s.attrs['cloud.provider'], 'aws');
      assert.equal(s.attrs['cloud.account.id'], '123456789012');
    }
    assert.deepEqual([api, sqs, fail, cb].map((l) => l[0].attrs['faas.coldstart']), [true, false, false, false]);
  });
  check('resource: cloud.platform aws_lambda, faas.max_memory in bytes', () => {
    assert.equal(api[0].resource['cloud.platform'], 'aws_lambda');
    assert.equal(api[0].resource['faas.max_memory'], 512 * 1024 * 1024);
  });
  check('a thrown error is thrown on unchanged, reported once in its span, and fails the span', () => {
    assert.deepEqual(r.thrown, { type: 'TypeError', message: 'lambda boom' });
    const reports = logs['lambda-key'].filter((l) => l.attrs['exception.message'] === 'lambda boom');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].attrs['zharp.handled'], 'false');
    assert.equal(reports[0].attrs['zharp.mechanism'], 'aws-lambda');
    assert.equal(reports[0].spanId, fail[0].spanId);
    assert.equal(fail[0].status, ERROR);
  });
  check('everything was flushed before each invocation returned', () => {
    for (const [label, id] of [['api', 'req-api'], ['sqs', 'req-sqs'], ['fail', 'req-fail'], ['callback', 'req-cb']]) {
      const got = step(r, label).received;
      assert.ok(got.invocations.includes(id), `${label}: span not received in time`);
      assert.ok(got.logs.includes(`lambda ran ${id}`), `${label}: log not received in time`);
    }
    assert.ok(step(r, 'fail').received.logs.includes('TypeError: lambda boom'));
  });
  check("logs inside an invocation carry its span", () => {
    const log = logs['lambda-key'].find((l) => l.body === 'lambda ran req-api');
    assert.equal(log.traceId, TRACE);
    assert.equal(log.spanId, api[0].spanId);
  });
}

console.log('\nZharp.lambda with tracing off (ZHARP_TRACING=false)');
{
  const app = await run('lambda', 'lambda-logs-only', { ZHARP_TRACING: 'false', AWS_LAMBDA_FUNCTION_NAME: 'orders-fn' });
  assert.ok(app.result, app.err + app.out);
  check('no spans; the results are unchanged', () => {
    assert.equal((spans['lambda-logs-only'] ?? []).length, 0);
    assert.deepEqual(app.result.apiResult, { statusCode: 201, body: '{"ok":true}' });
    assert.deepEqual(app.result.thrown, { type: 'TypeError', message: 'lambda boom' });
  });
  check('logs and the error are sent, once, and flushed before each invocation returned', () => {
    const errors = logs['lambda-logs-only'].filter((l) => l.attrs['exception.message'] === 'lambda boom');
    assert.equal(errors.length, 1);
    assert.ok(step(app.result, 'api').received.logs.includes('lambda ran req-api'));
    assert.ok(step(app.result, 'fail').received.logs.includes('TypeError: lambda boom'));
  });
  check("a log in an HTTP invocation carries the caller's trace id", () => {
    assert.equal(logs['lambda-logs-only'].find((l) => l.body === 'lambda ran req-api').traceId, TRACE);
  });
}

// ── Azure Functions ──────────────────────────────────────────────────────────

console.log('\nZharp.azureFunction (v4 programming model)');
{
  const app = await run('azure', 'azure-key', { FUNCTIONS_WORKER_RUNTIME: 'node', WEBSITE_SITE_NAME: 'orders-app' });
  assert.ok(app.result, app.err + app.out);
  const r = app.result;
  const httpSpan = byInvocation('azure-key', 'az-http');
  const timer = byInvocation('azure-key', 'az-timer');
  const fail = byInvocation('azure-key', 'az-fail');
  check('the handler keeps its arity and its results', () => {
    assert.equal(r.arity, 2);
    assert.deepEqual(r.httpResult, { status: 202, jsonBody: { ok: true } });
    assert.deepEqual(r.thrown, { type: 'RangeError', message: 'azure boom' });
  });
  check('one SERVER span per invocation, with the FaaS attributes', () => {
    for (const list of [httpSpan, timer, fail]) assert.equal(list.length, 1);
    assert.equal(httpSpan[0].kind, SERVER);
    assert.equal(httpSpan[0].name, 'POST /api/orders');
    assert.equal(httpSpan[0].attrs['faas.trigger'], 'http');
    assert.equal(httpSpan[0].attrs['faas.name'], 'orders');
    assert.equal(httpSpan[0].attrs['cloud.provider'], 'azure');
    assert.equal(httpSpan[0].attrs['http.response.status_code'], 202);
    assert.equal(timer[0].name, 'nightly');
    assert.equal(timer[0].attrs['faas.trigger'], 'timer');
    assert.deepEqual([httpSpan, timer, fail].map((l) => l[0].attrs['faas.coldstart']), [true, false, false]);
    assert.equal(httpSpan[0].resource['service.name'], 'fn-test');
    assert.equal(httpSpan[0].resource['cloud.platform'], 'azure_functions');
  });
  check("the caller's trace is continued from the request's Headers", () => {
    assert.equal(httpSpan[0].traceId, TRACE);
    assert.equal(httpSpan[0].parentSpanId, PARENT);
  });
  check('the error is reported once, in its span', () => {
    const reports = logs['azure-key'].filter((l) => l.attrs['exception.message'] === 'azure boom');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].spanId, fail[0].spanId);
    assert.equal(fail[0].status, ERROR);
  });
  check('flushed before each invocation returned', () => {
    for (const [label, id] of [['http', 'az-http'], ['timer', 'az-timer'], ['fail', 'az-fail']]) {
      assert.ok(step(r, label).received.invocations.includes(id), label);
      assert.ok(step(r, label).received.logs.includes(`azure ran ${id}`), label);
    }
  });
}

// ── Google Cloud Functions ───────────────────────────────────────────────────

console.log('\nZharp.cloudFunction');
{
  const app = await run('gcf', 'gcf-key', { FUNCTION_TARGET: 'orders', K_SERVICE: 'orders', K_REVISION: 'orders-00002' });
  assert.ok(app.result, app.err + app.out);
  const r = app.result;
  const first = byInvocation('gcf-key', 'gcf-exec-1');
  const fail = byInvocation('gcf-key', 'gcf-exec-2');
  const event = byInvocation('gcf-key', 'ce-1');
  check('HTTP: the response is the one the handler wrote', () => {
    assert.equal(r.arity, 2);
    assert.deepEqual(r.first, { status: 200, body: '{"ok":true}' });
    assert.deepEqual(r.failed, { status: 500, body: 'crash' });
    assert.equal(r.eventResult, 'handled');
  });
  check('HTTP: one SERVER span per request — no second one from the http instrumentation', () => {
    assert.equal(first.length, 1);
    assert.equal(fail.length, 1);
    assert.equal(spans['gcf-key'].filter((s) => s.kind === SERVER).length, 3, JSON.stringify(spans['gcf-key'].map((s) => [s.name, s.kind])));
    assert.equal(first[0].name, 'GET /orders');
    assert.equal(first[0].attrs['faas.trigger'], 'http');
    assert.equal(first[0].attrs['faas.name'], 'orders');
    assert.equal(first[0].attrs['cloud.provider'], 'gcp');
    assert.equal(first[0].attrs['http.response.status_code'], 200);
    assert.equal(fail[0].attrs['http.response.status_code'], 500);
    assert.equal(fail[0].status, ERROR);
    assert.deepEqual([first, fail, event].map((l) => l[0].attrs['faas.coldstart']), [true, false, false]);
  });
  check("the caller's trace is continued: HTTP headers, and a CloudEvent's traceparent", () => {
    assert.equal(first[0].traceId, TRACE);
    assert.equal(first[0].parentSpanId, PARENT);
    assert.equal(event[0].traceId, TRACE);
    assert.equal(event[0].attrs['faas.trigger'], 'pubsub');
  });
  check('a thrown error is reported once, in its span', () => {
    const reports = logs['gcf-key'].filter((l) => l.attrs['exception.message'] === 'gcf boom');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].spanId, fail[0].spanId);
  });
  check('flushed before the response went out', () => {
    assert.ok(step(r, 'http').received.invocations.includes('gcf-exec-1'));
    assert.ok(step(r, 'http').received.logs.includes('gcf ran /orders?x=1'));
    assert.ok(step(r, 'fail').received.invocations.includes('gcf-exec-2'));
    assert.ok(step(r, 'fail').received.logs.includes('SyntaxError: gcf boom'));
    assert.ok(step(r, 'event').received.invocations.includes('ce-1'));
  });
}

console.log('\nA slow or unreachable endpoint');
{
  const app = await run('slow', 'slow-key');
  assert.ok(app.result, app.err + app.out);
  const r = app.result;
  check('the flush gives up after flushTimeout (300 ms here), and the result still comes back', () => {
    assert.equal(r.custom.value, 'done');
    assert.ok(r.custom.ms >= 250 && r.custom.ms < 1_000, `${r.custom.ms} ms`);
  });
  check('2 s by default', () => {
    assert.ok(r.byDefault.ms >= 1_900 && r.byDefault.ms < 2_800, `${r.byDefault.ms} ms`);
  });
  check("on Lambda, never past the invocation's remaining time", () => {
    assert.ok(r.nearTimeout.ms < 400, `${r.nearTimeout.ms} ms`);
  });
}

server.closeAllConnections?.();
server.close();
console.log(failures ? `\n${failures} check(s) failed, ${passed} passed` : `\nAll ${passed} checks passed`);
process.exitCode = failures ? 1 : 0;
