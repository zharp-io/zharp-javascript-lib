/**
 * End-to-end checks against the built package (run `pnpm run build` first).
 *
 * A local HTTP server stands in for the Zharp backend and records every request. Each scenario
 * runs in its own Node process, as a real consumer would: the ESM build imported from a native
 * .mjs file, the CJS build required from a .cjs file, a fake browser for the unload path, and
 * jsdom for the replay recorder. The parent never loads the SDK, so its server is not traced.
 *
 *     node test/run.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const SDK = 'js/1.4.0';
const FETCH_LIMIT = 1_000_000;
const BEACON_LIMIT = 60_000;

// ── fake backend ─────────────────────────────────────────────────────────────

const requests = [];
const replayAttempts = new Map();
let replayActive = 0;
let replayMaxActive = 0;

const server = http.createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', async () => {
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {}
    const record = { method: req.method, url: req.url, headers: req.headers, raw, bytes: Buffer.byteLength(raw), body };
    requests.push(record);

    let status = 200;
    if (req.url.startsWith('/api/v1/agent/replay')) {
      // Slow, so an overlapping flush would show up as two requests in flight.
      replayActive += 1;
      replayMaxActive = Math.max(replayMaxActive, replayActive);
      const seq = body?.sequence;
      const attempt = (replayAttempts.get(seq) ?? 0) + 1;
      replayAttempts.set(seq, attempt);
      if ((seq === 0 && attempt === 1) || seq === 1) status = 500;
      await new Promise((resolve) => setTimeout(resolve, 80));
      replayActive -= 1;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/api/v1`;

function run(file, env = {}, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, 'fixtures', file), ...args], {
      env: { ...process.env, ZHARP_TEST_ENDPOINT: endpoint, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      if (code !== 0 || !line) return reject(new Error(`${file} exited ${code}\n${out}\n${err}`));
      resolve({ result: JSON.parse(line.slice(7)), stderr: err });
    });
  });
}

// ── tiny runner ──────────────────────────────────────────────────────────────

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${String(error.message).split('\n').join('\n        ')}`);
  }
}

const logRequests = (key) => requests.filter((r) => r.url.startsWith('/api/v1/agent/logs') && (r.headers['x-api-key'] === key || r.url.endsWith(`/${key}`)));
const entriesOf = (reqs) => reqs.flatMap((r) => r.body?.logs ?? []);

// ── Node: ESM and CJS ────────────────────────────────────────────────────────

for (const [label, file] of [['esm', 'node-consumer.mjs'], ['cjs', 'node-consumer.cjs']]) {
  console.log(`\n${label.toUpperCase()} consumer (${file})`);
  const { result } = await run(file, { NODE_ENV: 'production' });
  const service = `${label}-app`;

  const logs = requests.filter((r) => r.url.startsWith('/api/v1/agent/logs') && entriesOf([r]).some((e) => e.service === service));
  const traces = requests.filter((r) => r.url.startsWith('/api/v1/agent/traces') && (r.body?.spans ?? []).some((s) => s.serviceName === service));
  const entries = entriesOf(logs);
  const spans = traces.flatMap((r) => r.body.spans);

  check('requests go to the key-less path with X-API-KEY and X-Zharp-SDK', () => {
    assert.ok(logs.length && traces.length, 'expected log and trace requests');
    for (const r of [...logs, ...traces]) {
      assert.match(r.url, /^\/api\/v1\/agent\/(logs|traces)$/, r.url);
      assert.equal(r.headers['x-api-key'], 'test-key-123');
      assert.equal(r.headers['x-zharp-sdk'], SDK);
    }
  });

  check('log body is { logs } only — no hostname/os/version', () => {
    for (const r of logs) assert.deepEqual(Object.keys(r.body), ['logs']);
  });

  check('trace body is flat { spans }', () => {
    for (const r of traces) assert.deepEqual(Object.keys(r.body), ['spans']);
  });

  check('every entry has top-level environment/version/source and metadata.environment', () => {
    for (const e of entries) {
      assert.equal(e.environment, 'staging');
      assert.equal(e.version, '2.0.0');
      assert.equal(e.source, 'worker');
      assert.equal(e.metadata.environment, 'staging');
    }
  });

  check('messages are always non-empty strings', () => {
    for (const e of entries) assert.ok(typeof e.message === 'string' && e.message.trim().length, JSON.stringify(e.message));
    const messages = entries.map((e) => e.message);
    for (const expected of ['plain', '{"order":1}', '42', 'boom-object']) assert.ok(messages.includes(expected), `missing ${expected}`);
    assert.equal(messages.filter((m) => m === '(empty message)').length, 2, "'' and undefined");
  });

  check(`requests are split by bytes (each <= ${FETCH_LIMIT})`, () => {
    const big = logs.filter((r) => entriesOf([r]).some((e) => e.message.startsWith('big-')));
    assert.ok(big.length >= 3, `30 x 100 KB went in ${big.length} request(s)`);
    for (const r of logs) assert.ok(r.bytes <= FETCH_LIMIT, `${r.bytes} bytes`);
    assert.equal(entries.filter((e) => e.message.startsWith('big-')).length, 30, 'no entry lost in the split');
  });

  check('SERVER spans are produced for incoming requests', () => {
    const serverA = spans.find((s) => s.kind === 'SERVER' && s.name === 'GET /a');
    const serverB = spans.find((s) => s.kind === 'SERVER' && s.name === 'GET /b');
    assert.ok(serverA && serverB, `spans: ${spans.map((s) => `${s.kind} ${s.name}`).join(', ')}`);
    const clientA = spans.find((s) => s.kind === 'CLIENT' && s.name === 'GET /a');
    assert.ok(clientA, 'client span for the outgoing http.get');
    assert.equal(serverA.parentSpanId, clientA.spanId, 'traceparent propagated client -> server');
  });

  check('context survives await and does not leak between concurrent requests', () => {
    const { a, b } = result;
    assert.ok(a.before, 'a trace is active inside the handler');
    assert.equal(a.before, a.after);
    assert.equal(b.before, b.after);
    assert.notEqual(a.before, b.before);
    const serverA = spans.find((s) => s.kind === 'SERVER' && s.name === 'GET /a');
    assert.equal(a.before, serverA.traceId);
    const log = entries.find((e) => e.message === 'inside request /a');
    assert.equal(log.metadata.traceId, serverA.traceId, 'log carries the request trace after await');
  });

  check('span resource carries environment, version and source', () => {
    for (const s of spans) {
      assert.equal(s.resource['deployment.environment.name'], 'staging');
      assert.equal(s.resource['deployment.environment'], 'staging');
      assert.equal(s.resource['service.version'], '2.0.0');
      assert.equal(s.resource['zharp.source'], 'worker');
    }
  });

  check('continueTrace(tp, fn, name) runs fn in a CONSUMER span', () => {
    const job = spans.find((s) => s.name === 'process-job');
    assert.ok(job, 'process-job span');
    assert.equal(job.kind, 'CONSUMER');
    assert.equal(job.traceId, 'a'.repeat(32));
    assert.equal(job.parentSpanId, 'b'.repeat(16));
    assert.equal(result.inner, 'a'.repeat(32));
    const asyncJob = spans.find((s) => s.name === 'async-job');
    assert.equal(asyncJob?.kind, 'CONSUMER');
    const log = entries.find((e) => e.message === 'in async job');
    assert.equal(log.metadata.traceId, 'e'.repeat(32));
    assert.equal(log.metadata.spanId, asyncJob.spanId, 'log inside the job is attached to its span');
  });

  check('continueTrace(tp, fn) without a name creates no span', () => {
    assert.equal(result.plain, 'c'.repeat(32));
    assert.ok(!spans.some((s) => s.traceId === 'c'.repeat(32)));
  });

  if (label === 'esm') {
    check('a named `get` import from node:http is traced too', () => {
      assert.ok(spans.some((s) => s.kind === 'CLIENT' && s.name === 'GET /named'), spans.map((s) => `${s.kind} ${s.name}`).join(', '));
    });
  }
}

// ── defaults from environment variables ─────────────────────────────────────

console.log('\nDefaults from environment variables (env-defaults.cjs)');
{
  await run('env-defaults.cjs', { ZHARP_SERVICE: 'env-svc', ZHARP_ENV: '', NODE_ENV: 'test', ZHARP_VERSION: '9.9.9', OTEL_SERVICE_NAME: '' }, ['vars']);
  const bare = { ZHARP_SERVICE: '', OTEL_SERVICE_NAME: '', ZHARP_ENV: '', NODE_ENV: '', ZHARP_VERSION: '' };
  const { stderr } = await run('env-defaults.cjs', bare, ['bare']);
  const entries = entriesOf(logRequests('test-key-env'));

  check('service/environment/version fall back to ZHARP_SERVICE, NODE_ENV, ZHARP_VERSION', () => {
    const e = entries.find((x) => x.message === 'env-check vars');
    assert.equal(e.service, 'env-svc');
    assert.equal(e.environment, 'test');
    assert.equal(e.version, '9.9.9');
    assert.equal('source' in e, false);
  });

  check("no service anywhere: warns and uses 'unknown-service'; no environment invented", () => {
    const e = entries.find((x) => x.message === 'env-check bare');
    assert.equal(e.service, 'unknown-service');
    assert.equal('environment' in e, false, `environment: ${e.environment}`);
    assert.equal('environment' in e.metadata, false);
    assert.match(stderr, /No service name/);
  });
}

// ── browser unload path ──────────────────────────────────────────────────────

console.log('\nBrowser unload (browser-beacon.mjs)');
{
  const { result } = await run('browser-beacon.mjs', { NODE_ENV: 'production' });
  const beacons = result.beacons;
  const fallback = logRequests('test-key-beacon');

  check(`beacons are chunked under ${BEACON_LIMIT} bytes and use /agent/logs/<key>`, () => {
    assert.ok(beacons.length >= 4, `${beacons.length} beacon(s)`);
    for (const b of beacons) {
      assert.ok(b.size <= BEACON_LIMIT, `${b.size} bytes`);
      assert.ok(b.url.endsWith('/api/v1/agent/logs/test-key-beacon'), b.url);
      assert.deepEqual(b.keys, ['logs']);
    }
  });

  check('a refused beacon falls back to fetch (key in header, no key in path)', () => {
    assert.equal(fallback.length, 1, `${fallback.length} fallback request(s)`);
    const r = fallback[0];
    assert.equal(r.url, '/api/v1/agent/logs');
    assert.equal(r.headers['x-api-key'], 'test-key-beacon');
    assert.ok(r.bytes <= BEACON_LIMIT);
    const refused = beacons.find((b) => !b.accepted);
    assert.deepEqual(entriesOf(fallback).map((e) => e.message), refused.messages);
  });

  check('nothing dropped: all 40 queued entries were sent', () => {
    const sent = [...beacons.filter((b) => b.accepted).flatMap((b) => b.messages), ...entriesOf(fallback).map((e) => e.message)];
    assert.equal(new Set(sent).size, 40);
  });

  check('browser: environment unset unless configured (NODE_ENV ignored)', () => {
    for (const b of beacons) assert.equal(b.environment, null);
  });
}

// ── replay retry ─────────────────────────────────────────────────────────────

console.log('\nReplay retry (replay-retry.mjs)');
{
  await run('replay-retry.mjs');
  const replay = requests.filter((r) => r.url.startsWith('/api/v1/agent/replay'));
  const bySeq = new Map();
  for (const r of replay) {
    if (!bySeq.has(r.body.sequence)) bySeq.set(r.body.sequence, []);
    bySeq.get(r.body.sequence).push(r);
  }

  check('replay uses the key-less path with X-API-KEY and X-Zharp-SDK', () => {
    for (const r of replay) {
      assert.equal(r.url, '/api/v1/agent/replay');
      assert.equal(r.headers['x-api-key'], 'replay-flaky');
      assert.equal(r.headers['x-zharp-sdk'], SDK);
    }
  });

  check('a retried batch is resent unchanged, under the same sequence', () => {
    for (const [seq, reqs] of bySeq) assert.equal(new Set(reqs.map((r) => r.raw)).size, 1, `sequence ${seq} sent with different bodies`);
    assert.equal(bySeq.get(0)?.length, 2, 'sequence 0: failed once, then delivered');
  });

  check('a batch that keeps failing is dropped after 3 attempts; its sequence is not reused', () => {
    assert.equal(bySeq.get(1)?.length, 3);
    assert.ok(bySeq.has(2), 'the next batch is sequence 2');
    const firstSeen = [...bySeq.keys()];
    assert.deepEqual(firstSeen, [...firstSeen].sort((x, y) => x - y), 'sequences increase');
  });

  check('only one flush in flight at a time', () => {
    assert.equal(replayMaxActive, 1);
  });
}

server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
