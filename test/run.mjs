/**
 * End-to-end checks against the built packages (run `pnpm -r build` first; `pnpm test` does).
 *
 * A local HTTP server stands in for the Zharp backend and records every request. Each scenario
 * runs in its own Node process, as a real consumer would, loading `@zharp/logs` and `@zharp/apm`
 * by package name through the workspace links: the ESM builds imported from native .mjs files,
 * the CJS builds required from .cjs files, the `/init` entries preloaded with `--require` and
 * `--import`, a fake browser for the unload path, and jsdom for session replay. The parent never
 * loads the SDK, so its server is not traced.
 *
 *     node test/run.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const version = (pkg) => JSON.parse(readFileSync(join(root, 'packages', pkg, 'package.json'), 'utf8')).version;
const LOGS_SDK = `js-logs/${version('logs')}`;
const APM_SDK = `js-apm/${version('apm')}`;
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
    // A deleted key, rejected for good; and one rejected only on its first request.
    const key = req.headers['x-api-key'];
    if (key === 'rejected-key') status = 401;
    if (key === 'recovering-key' && requests.filter((r) => r.headers['x-api-key'] === key).length === 1) status = 401;
    if (req.url.startsWith('/api/v1/agent/replay') && req.headers['x-api-key'] === 'replay-flaky') {
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

/** The parent's environment without anything that would configure the SDK behind a test's back. */
function cleanEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('ZHARP_') || name === 'OTEL_SERVICE_NAME') delete env[name];
  }
  return env;
}

/**
 * Run a fixture in its own Node process, from the repository root so `--require @zharp/logs/init`
 * resolves the way it would in an application.
 */
function run(file, env = {}, args = [], nodeArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, join(here, 'fixtures', file), ...args], {
      cwd: root,
      env: { ...cleanEnv(), ZHARP_TEST_ENDPOINT: endpoint, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      if (code !== 0 || !line) return reject(new Error(`${file} exited ${code}\n${out}\n${err}`));
      resolve({ result: JSON.parse(line.slice(7)), stdout: out, stderr: err });
    });
  });
}

// ── tiny runner ──────────────────────────────────────────────────────────────

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

const keyOf = (r) => r.headers['x-api-key'] ?? decodeURIComponent(r.url.split('/').pop());
const ofType = (type, key) =>
  requests.filter((r) => r.url.startsWith(`/api/v1/agent/${type}`) && (key === undefined || keyOf(r) === key));
const logRequests = (key) => ofType('logs', key);
const traceRequests = (key) => ofType('traces', key);
const entriesOf = (reqs) => reqs.flatMap((r) => r.body?.logs ?? []);
const spansOf = (reqs) => reqs.flatMap((r) => r.body?.spans ?? []);
const lines = (text) => text.split(/\r?\n/).filter((l) => l.startsWith('[Zharp]'));

// ── Node: ESM and CJS, both packages ─────────────────────────────────────────

for (const [label, file] of [['esm', 'node-consumer.mjs'], ['cjs', 'node-consumer.cjs']]) {
  console.log(`\n${label.toUpperCase()} consumer (${file})`);
  const { result, stdout } = await run(file, { NODE_ENV: 'production' });
  const service = `${label}-app`;

  const logs = logRequests().filter((r) => entriesOf([r]).some((e) => e.service === service));
  const traces = traceRequests().filter((r) => spansOf([r]).some((s) => s.serviceName === service));
  const entries = entriesOf(logs);
  const spans = spansOf(traces);

  check('one activation line per package', () => {
    assert.deepEqual(lines(stdout), [
      `[Zharp] Logging active — service "${service}", environment "staging"`,
      `[Zharp] APM active — service "${service}", environment "staging"`,
    ]);
  });

  check('requests go to the key-less path with X-API-KEY and each package\'s X-Zharp-SDK', () => {
    assert.ok(logs.length && traces.length, 'expected log and trace requests');
    for (const r of [...logs, ...traces]) {
      assert.match(r.url, /^\/api\/v1\/agent\/(logs|traces)$/, r.url);
      assert.equal(r.headers['x-api-key'], 'test-key-123');
    }
    for (const r of logs) assert.equal(r.headers['x-zharp-sdk'], LOGS_SDK);
    for (const r of traces) assert.equal(r.headers['x-zharp-sdk'], APM_SDK);
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

  check('span resource carries environment, version and source (taken from the logger)', () => {
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

// ── @zharp/logs: init() from the environment ─────────────────────────────────

console.log('\n@zharp/logs: init() from the environment (logs-init.cjs)');
{
  const fromEnv = {
    ZHARP_API_KEY: 'env-key',
    ZHARP_SERVICE: 'env-only',
    ZHARP_ENV: 'env-env',
    ZHARP_VERSION: '7.0.0',
    ZHARP_SOURCE: 'env-src',
    ZHARP_ENDPOINT: endpoint,
  };

  const envRun = await run('logs-init.cjs', fromEnv, ['', 'env']);
  check('init() with no arguments reads ZHARP_API_KEY/SERVICE/ENV/VERSION/SOURCE/ENDPOINT', () => {
    assert.equal(envRun.result.active, true);
    const reqs = logRequests('env-key').filter((r) => entriesOf([r]).some((e) => e.message === 'init-check env'));
    assert.equal(reqs.length, 1, `${reqs.length} request(s)`);
    const e = entriesOf(reqs)[0];
    assert.equal(e.service, 'env-only');
    assert.equal(e.environment, 'env-env');
    assert.equal(e.version, '7.0.0');
    assert.equal(e.source, 'env-src');
    assert.equal(reqs[0].headers['x-zharp-sdk'], LOGS_SDK);
  });
  check('prints one activation line', () => {
    assert.deepEqual(lines(envRun.stdout), ['[Zharp] Logging active — service "env-only", environment "env-env"']);
  });

  const otel = await run('logs-init.cjs', { ZHARP_API_KEY: 'otel-key', OTEL_SERVICE_NAME: 'otel-svc', NODE_ENV: 'node-env', ZHARP_ENDPOINT: endpoint }, ['', 'otel']);
  check('service falls back to OTEL_SERVICE_NAME, environment to NODE_ENV', () => {
    const e = entriesOf(logRequests('otel-key')).find((x) => x.message === 'init-check otel');
    assert.equal(e.service, 'otel-svc');
    assert.equal(e.environment, 'node-env');
    assert.match(otel.stdout, /Logging active — service "otel-svc", environment "node-env"/);
  });

  const before = requests.length;
  const noKey = await run('logs-init.cjs', { ZHARP_SERVICE: 'nokey-svc', ZHARP_ENDPOINT: endpoint }, ['', 'nokey']);
  check('no API key: prints the hint, starts nothing, sends nothing', () => {
    assert.equal(noKey.result.active, false);
    assert.match(noKey.stderr, /\[Zharp\] No API key found — set ZHARP_API_KEY or call ZharpLogger\.init\(\{ apiKey \}\)/);
    assert.equal(lines(noKey.stdout).length, 0, 'no activation line');
    assert.equal(requests.length, before, 'no request reached the backend');
  });

  const explicit = { service: 'explicit-svc', environment: 'explicit-env', appVersion: '8.0.0' };
  await run('logs-init.cjs', { ...fromEnv, ZHARP_API_KEY: 'override-key' }, [JSON.stringify(explicit), 'override']);
  check('explicit options override the environment; the rest still comes from it', () => {
    const e = entriesOf(logRequests('override-key')).find((x) => x.message === 'init-check override');
    assert.equal(e.service, 'explicit-svc');
    assert.equal(e.environment, 'explicit-env');
    assert.equal(e.version, '8.0.0');
    assert.equal(e.source, 'env-src', 'source still from ZHARP_SOURCE');
  });

  for (const value of ['true', '1']) {
    const beforeDisabled = requests.length;
    const disabled = await run('logs-init.cjs', { ...fromEnv, ZHARP_API_KEY: 'disabled-key', ZHARP_DISABLED: value }, ['', 'disabled']);
    check(`ZHARP_DISABLED=${value}: says so, starts nothing, sends nothing`, () => {
      assert.equal(disabled.result.active, false);
      assert.deepEqual(lines(disabled.stdout), ['[Zharp] Logging disabled by ZHARP_DISABLED — nothing will be sent']);
      assert.equal(requests.length, beforeDisabled);
    });
  }
}

// ── 1.4.0: defaults from environment variables with an explicit key ──────────

console.log('\nDefaults from environment variables (env-defaults.cjs)');
{
  await run('env-defaults.cjs', { ZHARP_SERVICE: 'env-svc', NODE_ENV: 'test', ZHARP_VERSION: '9.9.9' }, ['vars']);
  const pkg = await run('env-defaults.cjs', { NODE_ENV: '' }, ['pkg']);
  const { stderr } = await run('env-defaults.cjs', { NODE_ENV: '' }, ['bare']);
  const entries = entriesOf(logRequests('test-key-env'));

  check('service/environment/version fall back to ZHARP_SERVICE, NODE_ENV, ZHARP_VERSION', () => {
    const e = entries.find((x) => x.message === 'env-check vars');
    assert.equal(e.service, 'env-svc');
    assert.equal(e.environment, 'test');
    assert.equal(e.version, '9.9.9');
    assert.equal('source' in e, false);
  });

  check("no service given: the app's package.json name, without its scope", () => {
    const e = entries.find((x) => x.message === 'env-check pkg');
    assert.equal(e.service, 'checkout-api');
    assert.match(pkg.stdout + pkg.stderr, /Logging active — service "checkout-api"/);
    assert.doesNotMatch(pkg.stderr, /No service name/);
  });

  check("no service anywhere: warns and uses 'unknown-service'; no environment invented", () => {
    const e = entries.find((x) => x.message === 'env-check bare');
    assert.equal(e.service, 'unknown-service');
    assert.equal('environment' in e, false, `environment: ${e.environment}`);
    assert.equal('environment' in e.metadata, false);
    assert.match(stderr, /No service name/);
  });
}

// ── init() again replaces the running setup ──────────────────────────────────

console.log('\nRe-init replaces (reinit.cjs)');
{
  const { result, stdout } = await run('reinit.cjs');

  check('second init() is not refused: two activation lines per package', () => {
    assert.deepEqual(lines(stdout), [
      '[Zharp] Logging active — service "reinit-a", no environment set',
      '[Zharp] APM active — service "reinit-a", no environment set',
      '[Zharp] Logging active — service "reinit-b", no environment set',
      '[Zharp] APM active — service "reinit-b", no environment set',
    ]);
  });
  check('logs queued before re-init go out under the old key; later ones under the new', () => {
    assert.deepEqual(entriesOf(logRequests('reinit-a')).map((e) => `${e.service}:${e.message}`), ['reinit-a:reinit before']);
    assert.deepEqual(entriesOf(logRequests('reinit-b')).map((e) => `${e.service}:${e.message}`), ['reinit-b:reinit after']);
  });
  check('spans likewise', () => {
    assert.deepEqual(spansOf(traceRequests('reinit-a')).map((s) => `${s.serviceName}:${s.name}`), ['reinit-a:span-a']);
    assert.deepEqual(spansOf(traceRequests('reinit-b')).map((s) => `${s.serviceName}:${s.name}`), ['reinit-b:span-b']);
  });
  check('handlers are replaced, not added to; destroy() removes them all', () => {
    assert.deepEqual(result.afterSecond, result.afterFirst);
    assert.equal(result.afterFirst.uncaught, result.initial.uncaught + 1);
    assert.equal(result.afterFirst.rejection, result.initial.rejection + 1);
    assert.deepEqual(result.final, result.initial);
  });
}

// ── node --require / --import of the init entries ────────────────────────────

console.log('\nPreloading the init entries');
{
  const env = (service) => ({ ZHARP_API_KEY: 'preload-key', ZHARP_SERVICE: service, ZHARP_ENV: 'preload-env', ZHARP_ENDPOINT: endpoint });
  const cases = [
    ['--require @zharp/logs/init', 'preload-app.cjs', 'require-cjs'],
    ['--import @zharp/logs/init', 'preload-app.mjs', 'import-esm'],
    // The mixed case: the ESM init entry starts the logger, the CommonJS app requires it.
    ['--import @zharp/logs/init', 'preload-app.cjs', 'import-cjs'],
  ];
  for (const [flag, file, tag] of cases) {
    const { result, stdout } = await run(file, env(`preload-${tag}`), [tag], flag.split(' '));
    check(`node ${flag} ${file}: the app's logger is the one started, from the environment`, () => {
      assert.equal(result.active, true);
      assert.deepEqual(lines(stdout), [`[Zharp] Logging active — service "preload-${tag}", environment "preload-env"`]);
      const e = entriesOf(logRequests('preload-key')).find((x) => x.message === `preloaded ${tag}`);
      assert.ok(e, 'log sent');
      assert.equal(e.service, `preload-${tag}`);
    });
  }

  const apmCases = [
    ['--require @zharp/apm/init', 'preload-apm.cjs', 'apm-cjs'],
    ['--import @zharp/apm/init', 'preload-apm.mjs', 'apm-esm'],
  ];
  for (const [flag, file, tag] of apmCases) {
    const { result, stdout } = await run(file, env(`preload-${tag}`), [tag], flag.split(' '));
    check(`node ${flag} ${file}: http is traced with no code in the app`, () => {
      assert.equal(result.active, true);
      assert.deepEqual(lines(stdout), [`[Zharp] APM active — service "preload-${tag}", environment "preload-env"`]);
      const spans = spansOf(traceRequests('preload-key')).filter((s) => s.serviceName === `preload-${tag}`);
      const names = spans.map((s) => `${s.kind} ${s.name}`);
      assert.ok(names.includes(`SERVER GET /preloaded-${tag}`), names.join(', '));
      assert.ok(names.includes(`CLIENT GET /preloaded-${tag}`), names.join(', '));
    });
  }
}

// ── logs ⇄ apm through the shared handle ─────────────────────────────────────

console.log('\nLogs and APM together (correlation.cjs)');
{
  const { result, stdout } = await run('correlation.cjs');
  const entries = entriesOf(logRequests('test-key-corr'));
  const spans = spansOf(traceRequests('test-key-corr'));
  const find = (message) => entries.find((e) => e.message === message);

  check('ZharpAPM.init() with no options reuses the logger\'s key, service, environment, version, source and endpoint', () => {
    assert.match(stdout, /APM active — service "corr-app", environment "corr-env"/);
    const span = spans.find((s) => s.name === 'corr-span');
    assert.ok(span, 'span sent with the logger\'s key to the logger\'s endpoint');
    assert.equal(span.serviceName, 'corr-app');
    assert.equal(span.resource['deployment.environment.name'], 'corr-env');
    assert.equal(span.resource['service.version'], '3.1.4');
    assert.equal(span.resource['zharp.source'], 'corr-src');
  });
  check('logs carry traceId/spanId while APM is active', () => {
    const e = find('corr with apm');
    assert.equal(e.metadata.traceId, result.spanTrace);
    assert.equal(e.metadata.spanId, spans.find((s) => s.name === 'corr-span').spanId);
  });
  check('…and not before APM starts or after it stops', () => {
    assert.equal('traceId' in find('corr no apm').metadata, false);
    assert.equal('traceId' in find('corr after apm').metadata, false);
  });
  check('both packages use the same sessionId', () => {
    const [logsSession, apmSession] = result.sessions;
    assert.equal(logsSession, apmSession);
    for (const e of entries) assert.equal(e.metadata.sessionId, logsSession);
  });
  check('a warning logged during APM joins its breadcrumb trail', () => {
    assert.ok(result.crumbs.includes('log:corr with apm'), result.crumbs.join(', '));
  });
}

console.log('\nAPM without logs (apm-alone.cjs)');
{
  const { result, stdout } = await run('apm-alone.cjs', { ZHARP_API_KEY: 'apm-alone-key', ZHARP_SERVICE: 'apm-alone', ZHARP_ENV: 'alone-env', ZHARP_ENDPOINT: endpoint });
  check('init() from the environment traces http; @zharp/logs is never loaded', () => {
    assert.equal(result.active, true);
    assert.equal(result.logsLoaded, false);
    assert.equal(result.handleLogs, false);
    assert.deepEqual(lines(stdout), ['[Zharp] APM active — service "apm-alone", environment "alone-env"']);
    const spans = spansOf(traceRequests('apm-alone-key'));
    assert.ok(spans.some((s) => s.kind === 'SERVER' && s.name === 'GET /alone' && s.serviceName === 'apm-alone'));
    for (const r of traceRequests('apm-alone-key')) assert.equal(r.headers['x-zharp-sdk'], APM_SDK);
  });

  const before = requests.length;
  const noKey = await run('apm-alone.cjs', { ZHARP_SERVICE: 'apm-nokey', ZHARP_ENDPOINT: endpoint });
  check('no API key: prints the hint, patches nothing, sends nothing', () => {
    assert.equal(noKey.result.active, false);
    assert.match(noKey.stderr, /\[Zharp\] No API key found — set ZHARP_API_KEY or call ZharpAPM\.init\(\{ apiKey \}\)/);
    assert.equal(requests.length, before);
  });

  const disabled = await run('apm-alone.cjs', { ZHARP_API_KEY: 'apm-disabled', ZHARP_DISABLED: 'true', ZHARP_ENDPOINT: endpoint });
  check('ZHARP_DISABLED=true: APM says so and sends nothing', () => {
    assert.equal(disabled.result.active, false);
    assert.deepEqual(lines(disabled.stdout), ['[Zharp] APM disabled by ZHARP_DISABLED — nothing will be sent']);
    assert.equal(traceRequests('apm-disabled').length, 0);
  });

  const explicit = { apiKey: 'apm-explicit', service: 'apm-explicit-svc', environment: 'explicit-env' };
  await run('apm-alone.cjs', { ZHARP_API_KEY: 'apm-env-key', ZHARP_SERVICE: 'apm-env-svc', ZHARP_VERSION: '5.5.5', ZHARP_ENDPOINT: endpoint }, [JSON.stringify(explicit)]);
  check('explicit options override the environment', () => {
    assert.equal(traceRequests('apm-env-key').length, 0);
    const spans = spansOf(traceRequests('apm-explicit'));
    assert.ok(spans.length);
    for (const s of spans) {
      assert.equal(s.serviceName, 'apm-explicit-svc');
      assert.equal(s.resource['deployment.environment.name'], 'explicit-env');
      assert.equal(s.resource['service.version'], '5.5.5', 'version still from ZHARP_VERSION');
    }
  });
}

// ── a Node script that never calls destroy() ─────────────────────────────────

console.log('\nExit without destroy (exit-without-destroy.cjs)');
{
  const started = Date.now();
  const exited = await Promise.race([
    run('exit-without-destroy.cjs').then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 15_000)),
  ]);
  const entries = entriesOf(logRequests('test-key-exit'));

  check('the process exits on its own, well before the 60 s flush interval', () => {
    assert.equal(exited, true, 'still running after 15 s');
    assert.ok(Date.now() - started < 15_000);
  });
  check('what was queued at exit was sent — logs and spans', () => {
    assert.deepEqual(entries.map((e) => e.message).sort(), ['exit-check 0', 'exit-check 1', 'exit-check 2', 'exit-check in span']);
    assert.deepEqual(spansOf(traceRequests('test-key-exit')).map((s) => s.name), ['exit-span']);
  });
}

// ── captureConsole ───────────────────────────────────────────────────────────

console.log('\nConsole capture (console-capture.cjs)');
{
  const all = await run('console-capture.cjs', {}, ['all']);
  await run('console-capture.cjs', {}, ['list']);
  await run('console-capture.cjs', { ZHARP_API_KEY: 'test-key-console-env', ZHARP_CAPTURE_CONSOLE: 'warn,error' }, ['env']);
  await run('console-capture.cjs', {}, ['off']);
  const sent = (mode) => entriesOf(logRequests(`test-key-console-${mode}`));
  const pairs = (mode) => sent(mode).map((e) => `${e.level} ${e.message}`).sort();

  check("'all' sends every console method at its level, and the console still prints", () => {
    assert.deepEqual(pairs('all'), [
      'debug debug line',
      'error TypeError: bad thing while saving',
      'info info line',
      'info plain line {"a":1}',
      'warn careful',
    ]);
    assert.match(all.stdout, /plain line/);
    assert.match(all.stdout, /Logging active — .*capturing the console/);
  });
  check('an Error argument puts its stack in the metadata', () => {
    const e = sent('all').find((x) => x.level === 'error');
    assert.equal(e.metadata.origin, 'console');
    assert.equal(e.metadata.consoleMethod, 'error');
    assert.equal(e.metadata.name, 'TypeError');
    assert.match(e.metadata.stack, /TypeError: bad thing/);
  });
  check('with consoleErrors on as well, console.error is still sent once', () => {
    assert.equal(sent('all').filter((x) => x.level === 'error').length, 1);
  });
  check('the SDK\'s own "[Zharp]" lines are never sent', () => {
    assert.ok(sent('all').every((e) => !e.message.startsWith('[Zharp]')));
  });
  check('a list sends only those methods', () => {
    assert.deepEqual(pairs('list'), ['error TypeError: bad thing while saving', 'warn careful']);
  });
  check('ZHARP_CAPTURE_CONSOLE=warn,error does the same from the environment', () => {
    assert.deepEqual(pairs('env'), ['error TypeError: bad thing while saving', 'warn careful']);
  });
  check('off by default; and after destroy() the console is no longer copied', () => {
    assert.deepEqual(sent('off'), []);
    assert.ok(sent('all').every((e) => e.message !== 'after destroy'));
  });
}

// ── caught errors carry their stack ──────────────────────────────────────────

{
  console.log('\ncaught errors (errors-logged.cjs)');
  await run('errors-logged.cjs');
  const entries = entriesOf(logRequests('errors-logged'));
  const byMessage = (m) => entries.find((e) => e.message === m);

  check('error(err): the message, plus the name and stack from the error', () => {
    const e = byMessage('card declined');
    assert.equal(e.level, 'error');
    assert.equal(e.metadata.name, 'TypeError');
    assert.match(e.metadata.stack, /TypeError: card declined\n\s+at charge/);
  });

  check("error('…', { err }): err arrives as name, message, stack and its own fields — not {}", () => {
    const e = byMessage('Payment failed');
    assert.equal(e.metadata.orderId, 99);
    assert.equal(e.metadata.err.name, 'TypeError');
    assert.equal(e.metadata.err.message, 'card declined');
    assert.equal(e.metadata.err.code, 'E_CARD');
    assert.match(e.metadata.err.stack, /at charge/);
    assert.match(e.metadata.stack, /at charge/, 'its stack is also the log stack, for the Stack Trace view');
  });

  check('errors deeper in the metadata, and their cause, are sent too', () => {
    const [err] = byMessage('nested').metadata.result.errors;
    assert.equal(err.message, 'sync failed');
    assert.equal(err.cause.name, 'RangeError');
    assert.equal(err.cause.message, 'page out of range');
    assert.ok(err.stack);
    assert.equal(byMessage('nested').metadata.stack, undefined, 'only a top-level error sets the log stack');
  });

  check('a stack the caller gave is kept', () => {
    assert.equal(byMessage('explicit stack').metadata.stack, 'my own stack');
  });

  check('metadata without errors is unchanged', () => {
    const m = byMessage('plain').metadata;
    assert.equal(m.a, 1);
    assert.equal(m.when, '1970-01-01T00:00:00.000Z');
    assert.deepEqual(m.list, [1, 2]);
    assert.equal(m.stack, undefined);
  });
}

// ── a crashing Node app still crashes ────────────────────────────────────────

/** Run a fixture and report how it ended, whatever the exit code. */
function runRaw(file, args = [], nodeArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...nodeArgs, join(here, 'fixtures', file), ...args], {
      cwd: root,
      env: { ...cleanEnv(), ZHARP_TEST_ENDPOINT: endpoint },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

console.log('\nCrashes (crash.cjs)');
{
  const thrown = await runRaw('crash.cjs', ['throw']);
  const rejected = await runRaw('crash.cjs', ['reject']);
  const warnOnly = await runRaw('crash.cjs', ['reject'], ['--unhandled-rejections=warn']);
  const own = await runRaw('crash.cjs', ['own-handler']);
  const sent = (mode) => entriesOf(logRequests(`test-key-crash-${mode}`));

  check('an uncaught exception still ends the process with code 1, printing the error', () => {
    assert.equal(thrown.code, 1, thrown.stdout + thrown.stderr);
    assert.match(thrown.stderr, /Error: boom \(throw\)/);
    assert.doesNotMatch(thrown.stdout, /survived/);
  });
  check('…after the error and what was queued before it reached Zharp', () => {
    const messages = sent('throw').map((e) => e.message);
    assert.ok(messages.includes('before the crash'), JSON.stringify(messages));
    assert.ok(sent('throw').some((e) => e.level === 'error' && e.metadata?.type === 'uncaughtException'));
  });
  check("an unhandled rejection ends the process with code 1 too (Node's default mode)", () => {
    assert.equal(rejected.code, 1, rejected.stdout + rejected.stderr);
    assert.ok(sent('reject').some((e) => e.metadata?.type === 'unhandledRejection'));
  });
  check('with --unhandled-rejections=warn the process keeps running, as Node would', () => {
    assert.match(warnOnly.stdout, /survived/);
  });
  check('an app with its own uncaughtException handler stays in charge', () => {
    assert.equal(own.code, 0, own.stdout + own.stderr);
    assert.match(own.stdout, /survived/);
    assert.ok(sent('own-handler').some((e) => e.metadata?.type === 'uncaughtException'));
  });
}

// ── browser unload path ──────────────────────────────────────────────────────

console.log('\nBrowser unload (browser-beacon.mjs)');
{
  const { result, stdout } = await run('browser-beacon.mjs', { NODE_ENV: 'production' });
  const beacons = result.beacons;
  const fallback = logRequests('test-key-beacon');

  check('browser: one activation line via console.info', () => {
    assert.deepEqual(lines(stdout), ['[Zharp] Logging active — service "browser-app", no environment set']);
  });

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

// ── replay loads lazily ──────────────────────────────────────────────────────

console.log('\nReplay is loaded lazily (replay-lazy.mjs)');
{
  const sampledIn = await run('replay-lazy.mjs', {}, ['sampled-in']);
  check('rrweb is not loaded by ZharpAPM.init() without replay', () => {
    assert.equal(sampledIn.result.afterPlainInit, false);
  });
  check('rrweb is loaded, and recording starts, once replay is enabled', () => {
    assert.equal(sampledIn.result.afterReplayInit, true);
    assert.equal(sampledIn.result.recording, true);
    assert.equal(sampledIn.result.isReplaying, true);
  });
  check('the activation line mentions the replay sample rate', () => {
    assert.ok(lines(sampledIn.stdout).includes('[Zharp] APM active — service "lazy-app", no environment set, session replay at 50% of sessions'), sampledIn.stdout);
  });

  const cjs = await run('require-no-rrweb.cjs');
  check('require() of both CommonJS builds and ZharpAPM.init() do not load rrweb', () => {
    assert.equal(cjs.result.loaded, false);
  });

  const sampledOut = await run('replay-lazy.mjs', {}, ['sampled-out']);
  check('a session sampled out never loads rrweb', () => {
    assert.equal(sampledOut.result.afterReplayInit, false);
    assert.equal(sampledOut.result.recording, false);
    assert.equal(sampledOut.result.isReplaying, false);
  });
}

// ── replay retry ─────────────────────────────────────────────────────────────

console.log('\nReplay retry (replay-retry.mjs)');
{
  await run('replay-retry.mjs');
  const replay = ofType('replay', 'replay-flaky');
  const bySeq = new Map();
  for (const r of replay) {
    if (!bySeq.has(r.body.sequence)) bySeq.set(r.body.sequence, []);
    bySeq.get(r.body.sequence).push(r);
  }

  check('replay uses the key-less path with X-API-KEY and X-Zharp-SDK', () => {
    assert.ok(replay.length);
    for (const r of replay) {
      assert.equal(r.url, '/api/v1/agent/replay');
      assert.equal(r.headers['x-api-key'], 'replay-flaky');
      assert.equal(r.headers['x-zharp-sdk'], APM_SDK);
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

console.log('\nRejected API key (key-rejected.cjs)');
{
  const retry = { ZHARP_TEST_KEY_RETRY_MS: '300' };
  const rejected = await run('key-rejected.cjs', retry, ['rejected-key']);
  const sent = (key) => entriesOf(logRequests(key)).map((e) => e.message);

  check('a rejected key warns once, then stops sending; one batch is tried after the wait', () => {
    assert.deepEqual(sent('rejected-key'), ['first', 'after-wait'], 'while backed off and after the second rejection, nothing is sent');
    const warnings = lines(rejected.stderr).filter((l) => l.includes('rejected this API key'));
    assert.deepEqual(warnings, ['[Zharp] Zharp rejected this API key (HTTP 401) — logs are not being sent. Check ZHARP_API_KEY.']);
    assert.doesNotMatch(rejected.stdout, /accepted the API key again/);
  });

  const recovering = await run('key-rejected.cjs', retry, ['recovering-key']);
  check('when the key is accepted again, sending resumes and says so once', () => {
    assert.deepEqual(sent('recovering-key'), ['first', 'after-wait', 'last']);
    assert.equal(lines(recovering.stdout).filter((l) => l.includes('accepted the API key again')).length, 1);
  });
}

server.close();
console.log(failures ? `\n${failures} check(s) failed, ${passed} passed` : `\nAll ${passed} checks passed`);
process.exit(failures ? 1 : 0);
