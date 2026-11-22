/**
 * End to end in the real Workers runtime: `wrangler dev` runs test/e2e (Hono, D1, KV, a Durable
 * Object, an outgoing fetch) bundled by Wrangler from the built package, and what it sends is
 * checked as it arrives. Then the production build: `wrangler deploy --dry-run --outdir` (what
 * the deploy script uploads source maps from), run as built, for a stack as Cloudflare reports it.
 *
 *     pnpm --filter @zharp/cloudflare build && node packages/cloudflare/test/e2e/run.mjs
 *
 * Against a Zharp backend as well — everything is forwarded there and its answers checked:
 *
 *     ZHARP_E2E_ENDPOINT=http://localhost:3000/api/v1/otlp ZHARP_E2E_KEY=zpk_… node …/run.mjs
 *
 * `--save-fixture <dir>` writes the production build, its map and the stack it threw there
 * (the backend's symbolication spec uses them).
 */
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', '..');
const wrangler = join(pkg, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const cli = join(pkg, '..', 'cli', 'dist', 'cli.js');
const forwardTo = process.env.ZHARP_E2E_ENDPOINT?.replace(/\/+$/, '');
const key = process.env.ZHARP_E2E_KEY || 'zpk_e2e_test';
const run = Math.random().toString(16).slice(2, 10);
const release = `e2e-${run}`;
const saveFixture = process.argv.includes('--save-fixture') ? process.argv[process.argv.indexOf('--save-fixture') + 1] : null;

// ── the collector (and the "origin" the Worker calls) ───────────────────

const received = [];
const answers = [];
const collector = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body = Buffer.concat(chunks);
    if (req.url === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ traceparent: req.headers.traceparent ?? null }));
      return;
    }
    const raw = body;
    if (req.headers['content-encoding'] === 'gzip') body = gunzipSync(body);
    const signal = req.url.split('/').pop();
    received.push({ signal, body: JSON.parse(body.toString('utf8')), auth: req.headers.authorization });
    if (forwardTo) {
      const response = await fetch(`${forwardTo}/v1/${signal}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: req.headers.authorization, ...(req.headers['content-encoding'] ? { 'content-encoding': req.headers['content-encoding'] } : {}) },
        body: raw,
      }).catch((error) => ({ status: 0, text: async () => String(error) }));
      answers.push({ signal, status: response.status, body: await response.text() });
      res.writeHead(response.status || 502, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve));
const collectorUrl = `http://127.0.0.1:${collector.address().port}`;

const attrs = (r) => Object.fromEntries((r.attributes ?? []).map(({ key, value }) => [key, value.stringValue ?? value.intValue ?? value.boolValue ?? value.doubleValue]));
const spans = () => received.filter((r) => r.signal === 'traces').flatMap((r) => r.body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((s) => s.spans)));
const logs = () => received.filter((r) => r.signal === 'logs').flatMap((r) => r.body.resourceLogs.flatMap((rl) => rl.scopeLogs.flatMap((s) => s.logRecords)));
const errors = () => logs().filter((l) => attrs(l)['exception.type']);
const resource = () => {
  const first = received[0]?.body;
  const r = first?.resourceSpans?.[0]?.resource ?? first?.resourceLogs?.[0]?.resource;
  return r ? attrs(r) : {};
};

// ── wrangler dev ────────────────────────────────────────────────────────

function kill(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

async function startWrangler(args, port) {
  const child = spawn(process.execPath, [wrangler, 'dev', '--port', String(port), '--ip', '127.0.0.1', '--log-level', 'warn', '--show-interactive-dev-session=false', ...args], { cwd: here, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return { child, output: () => output };
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  kill(child);
  throw new Error(`wrangler dev did not start:\n${output}`);
}

const vars = (extra = []) => ['--var', `ZHARP_KEY:${key}`, '--var', `ZHARP_ENDPOINT:${collectorUrl}/api/v1/otlp`, '--var', `ZHARP_RELEASE:${release}`, '--var', `ORIGIN:${collectorUrl}`, ...extra];

async function until(check, what, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const persist = mkdtempSync(join(tmpdir(), 'zharp-cf-e2e-'));
const port = 8780 + Math.floor(Math.random() * 100);
let dev;
console.log(`\n@zharp/cloudflare end to end (wrangler dev, run ${run})${forwardTo ? `, forwarded to ${forwardTo}` : ''}`);
try {
  dev = await startWrangler([...vars(['--var', 'ZHARP_LOGS:true']), '--persist-to', persist], port);
  const get = (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init);

  await test('a request is one SERVER span named by its Hono route, with the release and Cloudflare resource', async () => {
    received.length = 0;
    await get('/health');
    await until(() => spans().some((s) => s.kind === 2), 'the span');
    const server = spans().find((s) => s.kind === 2);
    assert.equal(server.name, 'GET /health');
    assert.equal(resource()['service.name'], 'e2e-worker');
    assert.equal(resource()['service.version'], release);
    assert.equal(resource()['cloud.platform'], 'cloudflare.workers');
    assert.ok(resource()['faas.version'], 'the version metadata binding gives the version id');
    assert.equal(received[0].auth, `Bearer ${key}`);
  });

  let stack;
  await test('an error is reported once, with the user, on the request’s span, with the route', async () => {
    received.length = 0;
    const response = await get('/checkout/7', { headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' } });
    assert.equal(response.status, 500);
    await until(() => errors().length && spans().some((s) => s.kind === 2), 'the error');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(errors().length, 1);
    const error = attrs(errors()[0]);
    assert.equal(error['exception.type'], 'TypeError');
    assert.equal(error['zharp.handled'], 'false');
    assert.equal(error['enduser.id'], 'u-1');
    stack = error['exception.stacktrace'];
    assert.match(stack, /at cartTotal/);
    const server = spans().find((s) => s.kind === 2);
    assert.equal(server.name, 'GET /checkout/:id');
    assert.equal(server.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.equal(errors()[0].spanId, server.spanId);
    assert.ok(spans().some((s) => s.name === 'KV put KV' && s.parentSpanId === server.spanId));
  });

  await test('a failed D1 query: its SQL and the app’s line, once', async () => {
    received.length = 0;
    await get('/orders/9');
    await until(() => errors().length, 'the query error');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(errors().length, 1);
    const error = attrs(errors()[0]);
    assert.equal(error['exception.type'], 'D1Error');
    assert.equal(error['db.statement'], 'SELECT * FROM order_lines WHERE order_id = ?');
    assert.match(error['exception.message'], /no such table: order_lines/);
    assert.match(error['exception.stacktrace'].split('\n')[1], /index\.ts|index\.js/);
  });

  await test('an outgoing fetch carries traceparent, in the same trace', async () => {
    received.length = 0;
    const body = await (await get('/origin')).json();
    await until(() => spans().some((s) => s.kind === 3 && s.name.startsWith('GET 127.0.0.1')), 'the client span');
    const client = spans().find((s) => s.kind === 3 && s.name.startsWith('GET 127.0.0.1'));
    assert.equal(body.traceparent, `00-${client.traceId}-${client.spanId}-01`);
  });

  await test('a Durable Object RPC call is a span of the caller’s trace', async () => {
    received.length = 0;
    const body = await (await get('/cart/c-1')).json();
    assert.deepEqual(body.items.slice(-1), ['A1']);
    await until(() => spans().some((s) => s.name === 'CartObject.add'), 'the RPC span');
  });

  await test('ZHARP_LOGS=true: console lines are sent with their trace; console.error(err) is a log, not an error', async () => {
    received.length = 0;
    await get('/log');
    await until(() => logs().some((l) => l.body.stringValue.startsWith('checkout started')), 'the log line');
    const line = logs().find((l) => l.body.stringValue.startsWith('checkout started'));
    assert.equal(line.severityText, 'INFO');
    assert.ok(line.traceId);
    assert.equal(errors().length, 0);
  });

  if (forwardTo) {
    await test('the backend accepted everything', async () => {
      assert.ok(answers.length > 0);
      for (const answer of answers) assert.equal(answer.status, 200, `${answer.signal}: ${answer.status} ${answer.body}`);
    });
  }
  kill(dev);
  dev = null;

  // ── the production build ──────────────────────────────────────────────
  const out = join(persist, 'dist');
  await test('the production build has a source map, and the CLI files it under the release', async () => {
    const result = spawnSync(process.execPath, [wrangler, 'deploy', '--dry-run', '--outdir', out], { cwd: here, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const bundle = readFileSync(join(out, 'index.js'));
    assert.ok(statSync(join(out, 'index.js.map')).size > 0);
    console.log(`    (the whole Worker, Hono included: ${(bundle.length / 1024).toFixed(1)} KB unminified)`);
    const upload = spawnSync(process.execPath, [cli, 'sourcemaps', 'upload', out, '--release', release, '--dry-run'], { encoding: 'utf8' });
    assert.equal(upload.status, 0, upload.stderr);
    assert.match(upload.stdout + upload.stderr, /matched to them by file name/);
    assert.match(upload.stdout, /index\.js \+ index\.js\.map/);
  });

  await test('run as built, a stack names the bundle as Cloudflare does', async () => {
    received.length = 0;
    const builtPort = port + 1;
    dev = await startWrangler([join(out, 'index.js'), '--no-bundle', ...vars(), '--persist-to', persist], builtPort);
    await fetch(`http://127.0.0.1:${builtPort}/total`);
    await until(() => errors().length, 'the error from the build');
    const built = attrs(errors()[0])['exception.stacktrace'];
    assert.match(built, /index\.js:\d+:\d+/);
    if (saveFixture) {
      mkdirSync(saveFixture, { recursive: true });
      copyFileSync(join(out, 'index.js'), join(saveFixture, 'worker-index.js'));
      copyFileSync(join(out, 'index.js.map'), join(saveFixture, 'worker-index.js.map'));
      // As Cloudflare reports it: the module's name, no local path.
      writeFileSync(join(saveFixture, 'worker.stack.txt'), built.replace(/file:\/\/\/[^\s)]*\/(index\.js)/g, '$1').replace(/\r\n/g, '\n'));
      writeFileSync(join(saveFixture, 'worker-otlp-logs.json'), JSON.stringify(received.find((r) => r.signal === 'logs').body, null, 2));
      console.log(`    (fixture written to ${saveFixture})`);
    }
  });
} catch (error) {
  if (dev) console.error(dev.output());
  throw error;
} finally {
  kill(dev);
  collector.close();
  try {
    rmSync(persist, { recursive: true, force: true });
  } catch {
    // workerd may still hold a file for a moment on Windows; the temp folder is left behind.
  }
}
console.log(`\n${passed} passed`);
process.exit(0);
