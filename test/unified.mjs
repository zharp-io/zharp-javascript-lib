/**
 * Checks for @zharp/browser and @zharp/node against a fake OTLP endpoint (run `pnpm -r build`
 * first; `pnpm test` does). Each scenario runs in its own Node process, loading the packages by
 * name as an application would; the browser ones in jsdom.
 *
 * The real thing — a page calling a server, read back from ClickHouse — is test/e2e/run.mjs.
 *
 *     node test/unified.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// ── fake endpoint ────────────────────────────────────────────────────────────

const requests = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let raw = Buffer.concat(chunks);
    if (req.headers['content-encoding'] === 'gzip') raw = gunzipSync(raw);
    const text = raw.toString('utf8');
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    const key = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    requests.push({ path: req.url, key, headers: req.headers, raw, text, body });
    res.writeHead(key === 'rejected-key' ? 401 : 200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ZHARP_TEST_ENDPOINT: endpoint, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
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

const byKey = (key, path) => requests.filter((r) => r.key === key && (!path || r.path.endsWith(path)));
const attrs = (list = []) => Object.fromEntries(list.map(({ key, value }) => [key, Object.values(value)[0]]));
const spansOf = (key) =>
  byKey(key, '/v1/traces').flatMap((r) =>
    r.body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans.map((s) => ({ ...s, attrs: attrs(s.attributes), resource: attrs(rs.resource.attributes) })))),
  );
const logsOf = (key) =>
  byKey(key, '/v1/logs').flatMap((r) =>
    r.body.resourceLogs.flatMap((rl) => rl.scopeLogs.flatMap((sl) => sl.logRecords.map((l) => ({ ...l, attrs: attrs(l.attributes), resource: attrs(rl.resource.attributes) })))),
  );
const browserVersion = JSON.parse(readFileSync(join(root, 'packages/browser/package.json'), 'utf8')).version;

// ── @zharp/browser ───────────────────────────────────────────────────────────

console.log('\n@zharp/browser: spans, propagation, logs, errors, sessions (browser-basics.mjs)');
{
  const { result, err } = await run(['test/unified/browser-basics.mjs']);
  assert.ok(result, err);
  const spans = spansOf('browser-key');
  const logs = logsOf('browser-key');
  const named = (name) => spans.find((s) => s.name === name);

  check('requests go to {endpoint}/v1/traces and /v1/logs as OTLP/JSON with the Bearer key', () => {
    const sent = byKey('browser-key');
    assert.ok(sent.length >= 2);
    for (const r of sent) {
      assert.match(r.path, /^\/v1\/(traces|logs)$/);
      assert.equal(r.headers['content-type'], 'application/json');
    }
  });

  check('resource: service, release, environment, sdk, browser and os from the user agent', () => {
    const resource = spans[0].resource;
    assert.deepEqual(
      [resource['service.name'], resource['service.version'], resource['deployment.environment.name'], resource['telemetry.sdk.name'], resource['telemetry.sdk.language'], resource['telemetry.sdk.version']],
      ['web-test', 'web@1', 'test', 'zharp', 'webjs', browserVersion],
    );
    assert.deepEqual([resource['browser.name'], resource['browser.version'], resource['os.name'], resource['os.version']], ['Chrome', '131', 'Windows', '10']);
  });

  check('a fresh session in sessionStorage is resumed, with its user; clearUser starts a new one', () => {
    assert.equal(result.resumedSession, 'stored-session');
    assert.equal(result.resumedUser, 'u-from-storage');
    assert.equal(result.beforeClear, 'stored-session');
    assert.notEqual(result.afterClear, 'stored-session');
  });

  check('a page load span, a navigation span, and a click span for the click that made a request', () => {
    const pageload = named('pageload /start');
    const navigation = named('navigation /next');
    const click = named('click “Save changes”');
    assert.ok(pageload && navigation && click, spans.map((s) => s.name).join(', '));
    for (const root of [pageload, navigation, click]) {
      assert.equal(root.parentSpanId, undefined);
      assert.equal(root.kind, 1);
    }
    const sameOrigin = named('GET /api/same-origin');
    assert.equal(sameOrigin.parentSpanId, click.spanId, 'request made by the click is its child');
    assert.equal(sameOrigin.kind, 3);
    assert.equal(sameOrigin.attrs['http.request.method'], 'GET');
    assert.equal(sameOrigin.attrs['http.response.status_code'], 200);
    assert.equal(sameOrigin.attrs['url.full'], 'http://localhost:5173/api/same-origin');
  });

  check('traceparent and baggage go to same-origin and tracingOrigins URLs only', () => {
    const req = (part) => result.appRequests.find((r) => r.url.includes(part));
    const same = req('/api/same-origin');
    const allowed = req('api.allowed.test');
    const third = req('third-party.test');
    const sameSpan = named('GET /api/same-origin');
    assert.equal(same.traceparent, `00-${sameSpan.traceId}-${sameSpan.spanId}-01`);
    assert.match(allowed.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    assert.equal(third.traceparent, null);
    assert.equal(third.baggage, null);
    assert.equal(same.baggage, 'session.id=stored-session,enduser.id=user%201');
    assert.equal(allowed.baggage, 'caller=1,session.id=stored-session,enduser.id=user%201', "the caller's baggage is kept");
  });

  check('third-party requests still get a span; the SDK\'s own requests do not', () => {
    assert.ok(named('GET /pixel'));
    assert.ok(!spans.some((s) => String(s.attrs['url.full']).startsWith(endpoint)));
  });

  check('a 500 marks the client span as an error', () => {
    const fail = named('GET /api/fail');
    assert.equal(fail.status.code, 2);
    assert.equal(fail.attrs['http.response.status_code'], 500);
  });

  check('XHR: a span and the trace headers', () => {
    const xhr = named('GET /api/xhr');
    assert.ok(xhr);
    const tp = result.xhrHeaders.find(([n]) => n === 'traceparent');
    assert.equal(tp?.[1], `00-${xhr.traceId}-${xhr.spanId}-01`);
    assert.ok(result.xhrHeaders.some(([n, v]) => n === 'baggage' && v.includes('session.id=stored-session')));
  });

  check('every span and log carries session.id and enduser.id', () => {
    for (const s of spans.filter((x) => x.name !== 'pageload /start')) {
      assert.equal(s.attrs['session.id'], 'stored-session', s.name);
      assert.equal(s.attrs['enduser.id'], 'user 1', s.name);
    }
    for (const l of logs) assert.equal(l.attrs['session.id'], 'stored-session');
  });

  check('Zharp.log.info: severity 9, body, attributes', () => {
    const hello = logs.find((l) => l.body.stringValue === 'hello');
    assert.equal(hello.severityNumber, 9);
    assert.equal(hello.severityText, 'INFO');
    assert.equal(hello.attrs.orderId, 7);
  });

  check('a log inside startSpan carries that span\'s trace and span id', () => {
    const manual = named('manual work');
    const inside = logs.find((l) => l.body.stringValue === 'inside manual');
    assert.equal(inside.traceId, manual.traceId);
    assert.equal(inside.spanId, manual.spanId);
  });

  check('captureError: handled, with type, message and a stack that starts "Type: message"; sent once', () => {
    const captured = logs.filter((l) => l.attrs['exception.message'] === 'captured once');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].severityNumber, 17);
    assert.equal(captured[0].attrs['exception.type'], 'RangeError');
    assert.equal(captured[0].attrs['zharp.handled'], 'true');
    assert.match(captured[0].attrs['exception.stacktrace'], /^RangeError: captured once\n/);
  });

  check('uncaught error and unhandled rejection: unhandled', () => {
    const uncaught = logs.find((l) => l.attrs['exception.message'] === 'uncaught one');
    assert.equal(uncaught.attrs['zharp.handled'], 'false');
    assert.equal(uncaught.attrs['exception.type'], 'TypeError');
    const rejected = logs.find((l) => l.attrs['zharp.mechanism'] === 'onunhandledrejection');
    assert.equal(rejected.attrs['exception.message'], 'a string reason');
    assert.equal(rejected.attrs['zharp.handled'], 'false');
  });
}

console.log('\n@zharp/browser: session replay (browser-replay.mjs)');
{
  const off = await run(['test/unified/browser-replay.mjs', 'off']);
  check('replay off: rrweb is never loaded and nothing is sent to /v1/replays', () => {
    assert.equal(off.result.loadedAtStart, false);
    assert.equal(byKey('replay-off', '/v1/replays').length, 0);
  });

  const buffer = await run(['test/unified/browser-replay.mjs', 'buffer']);
  const bufferBatches = byKey('replay-buffer', '/v1/replays').map((r) => r.body);
  check('onErrorSampleRate: recorded but nothing sent before the error', () => {
    assert.equal(buffer.result.loadedAtStart, true);
    assert.equal(buffer.result.decided, 'buffer');
    assert.ok(bufferBatches.length >= 2, `${bufferBatches.length} batches`);
    // The first batch holds what happened before the error.
    assert.ok(JSON.stringify(bufferBatches[0].events).includes('before the error'));
  });
  check('after the error: the buffer, then the rest of the session, numbered 0, 1, 2… with hasError', () => {
    assert.deepEqual(bufferBatches.map((b) => b.sequence), bufferBatches.map((_, i) => i));
    assert.ok(bufferBatches.every((b) => b.hasError === true && b.sessionId === buffer.result.sessionId));
    assert.ok(bufferBatches.some((b) => JSON.stringify(b.events).includes('later still')));
    assert.equal(buffer.result.modeAfter, 'session', 'the switch is remembered for the session');
    assert.equal(buffer.result.seq, bufferBatches.length, 'the next number is stored for a reload');
    assert.ok(bufferBatches[0].traceIds.every((id) => /^[0-9a-f]{32}$/.test(id)) && bufferBatches[0].traceIds.length >= 1);
    assert.equal(bufferBatches[0].url, 'http://localhost:5173/buffer');
  });

  await run(['test/unified/browser-replay.mjs', 'session']);
  const sessionBatches = byKey('replay-session', '/v1/replays').map((r) => r.body);
  check('sampleRate: the whole session is sent, without waiting for an error', () => {
    assert.ok(sessionBatches.length >= 2);
    assert.ok(JSON.stringify(sessionBatches[0].events).includes('before the error'));
    assert.ok(sessionBatches.every((b) => b.hasError === false));
    assert.ok(sessionBatches[0].events.some((e) => e.type === 2), 'starts with a full snapshot');
  });
}

console.log('\n@zharp/browser: script tag (browser-cdn.mjs) and a rejected key (browser-rejected.mjs)');
{
  const cdn = await run(['test/unified/browser-cdn.mjs']);
  check('dist/zharp.min.js defines a global Zharp with the same API', () => {
    assert.equal(cdn.result.type, 'object');
    assert.deepEqual(cdn.result.api, ['init', 'setUser', 'clearUser', 'captureError', 'startSpan', 'setTag', 'flush']);
    assert.deepEqual(cdn.result.log, ['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
  });
  const size = readFileSync(join(root, 'packages/browser/dist/zharp.min.js')).length;
  check(`dist/zharp.min.js stays small (${size} bytes) and does not contain rrweb`, () => {
    assert.ok(size < 40_000);
    assert.doesNotMatch(readFileSync(join(root, 'packages/browser/dist/zharp.min.js'), 'utf8'), /rrweb|takeFullSnapshot/);
  });

  const rejected = await run(['test/unified/browser-rejected.mjs']);
  check('rejected key: one warning, and nothing sent after the first refusal', () => {
    assert.equal(rejected.result.warnings.length, 1, rejected.result.warnings.join('\n'));
    assert.match(rejected.result.warnings[0], /key was rejected \(HTTP 401\)/);
    assert.equal(byKey('rejected-key').length, 1);
  });
}

console.log('\n@zharp/browser: tracing: false (browser-logs-only.mjs)');
{
  const { result, err } = await run(['test/unified/browser-logs-only.mjs']);
  assert.ok(result, err);
  const logs = logsOf('browser-logs-only');
  check('no spans are made or sent', () => {
    assert.equal(byKey('browser-logs-only', '/v1/traces').length, 0);
  });
  check('fetch and XHR are left alone: no traceparent or baggage, even same-origin and tracingOrigins', () => {
    assert.equal(result.fetchPatched, false);
    assert.ok(result.appRequests.length >= 2);
    for (const r of result.appRequests) assert.deepEqual([r.traceparent, r.baggage], [null, null], r.url);
    assert.ok(!result.xhrHeaders.some(([n]) => n === 'traceparent' || n === 'baggage'));
  });
  check('logs go out with session, user and tags, and no trace id', () => {
    const hello = logs.find((l) => l.body.stringValue === 'logs only hello');
    assert.ok(hello);
    assert.equal(hello.attrs.orderId, 8);
    assert.equal(hello.attrs['session.id'], result.sessionId);
    assert.equal(hello.attrs['enduser.id'], 'user 2');
    assert.equal(hello.attrs.plan, 'pro');
    assert.ok(!hello.traceId);
  });
  check('captureError and uncaught errors: exception.* and the handled flag', () => {
    const captured = logs.find((l) => l.attrs['exception.message'] === 'captured without tracing');
    assert.equal(captured.attrs['exception.type'], 'RangeError');
    assert.equal(captured.attrs['zharp.handled'], 'true');
    const uncaught = logs.find((l) => l.attrs['exception.message'] === 'uncaught without tracing');
    assert.equal(uncaught.attrs['zharp.handled'], 'false');
  });
  check('startSpan runs the callback and returns its value; a log inside has no span', () => {
    assert.equal(result.spanResult, 'ran:function');
    const inside = logs.find((l) => l.body.stringValue === 'inside manual, no span');
    assert.ok(inside && !inside.spanId);
  });
}

// ── @zharp/node ──────────────────────────────────────────────────────────────

const nodeArgs = (file, ...args) => ['--import', './test/unified/node-instrument.mjs', `./test/unified/${file}`, ...args];
const text = (key, path) => byKey(key, path).map((r) => r.text).join('\n');

console.log('\n@zharp/node (node-app.mjs, preloaded with --import)');
{
  const app = await run(nodeArgs('node-app.mjs'), { TEST_KEY: 'node-key' });
  check('one activation line', () => {
    assert.match(app.out, /\[Zharp\] Application monitoring active — service "node-test", environment "test"/);
  });
  check('OTLP protobuf, gzipped, to /v1/traces and /v1/logs with the Bearer key', () => {
    const sent = byKey('node-key');
    assert.ok(sent.some((r) => r.path === '/otlp/v1/traces') && sent.some((r) => r.path === '/otlp/v1/logs'), sent.map((r) => r.path).join(', '));
    for (const r of sent) {
      assert.equal(r.headers['content-type'], 'application/x-protobuf');
      assert.equal(r.headers['content-encoding'], 'gzip');
    }
  });
  const traces = text('node-key', '/v1/traces');
  const logs = text('node-key', '/v1/logs');
  check('resource: service, release, environment, telemetry.sdk.name zharp / nodejs', () => {
    for (const s of ['node-test', 'api@1', 'deployment.environment.name', 'zharp', 'nodejs']) assert.ok(traces.includes(s), s);
  });
  check('the incoming traceparent is continued', () => {
    const traceId = Buffer.from('0af7651916cd43dd8448eb211c80319c', 'hex');
    assert.ok(byKey('node-key', '/v1/traces').some((r) => r.raw.includes(traceId)), "spans in the caller's trace");
  });
  check('session.id and enduser.id from baggage on spans and logs', () => {
    for (const payload of [traces, logs]) {
      assert.ok(payload.includes('browser-session-1'), 'session id');
      assert.ok(payload.includes('user 1'), 'user id (decoded)');
    }
  });
  check('setUser inside a request reaches its spans and logs', () => {
    assert.ok(traces.includes('server-set-user'));
    assert.ok(logs.includes('server-set-user'));
  });
  check('Zharp.log, console.log and captureError are sent as logs', () => {
    for (const s of ['from the browser', 'console in handler', 'inside job', 'caught in handler', 'exception.stacktrace', 'zharp.handled']) assert.ok(logs.includes(s), s);
  });
  check('ESM import and CommonJS require get the same started instance', () => {
    assert.deepEqual(app.result, { sameInstance: true, active: true });
  });
}

console.log('\n@zharp/node: crashes (node-crash.mjs)');
for (const [mode, type] of [['throw', 'RangeError'], ['reject', 'SyntaxError']]) {
  const crash = await run(nodeArgs('node-crash.mjs', mode), { TEST_KEY: `crash-${mode}` });
  check(`${mode === 'throw' ? 'uncaught exception' : 'unhandled rejection'}: sent as unhandled, then exit 1 with the stack on stderr`, () => {
    assert.equal(crash.code, 1);
    assert.match(crash.err, new RegExp(`^${type}: `));
    const logs = text(`crash-${mode}`, '/v1/logs');
    assert.ok(logs.includes(type) && logs.includes('zharp.handled') && logs.includes('false'));
  });
}

console.log('\n@zharp/node: no key');
{
  const before = requests.length;
  const nokey = await run(nodeArgs('node-crash.mjs', 'none'), { TEST_KEY: '', ZHARP_API_KEY: '' });
  check('prints how to fix it, starts nothing, sends nothing', () => {
    assert.match(nokey.err, /\[Zharp\] No key found/);
    assert.equal(requests.length, before);
  });
}

console.log('\n@zharp/node: ZHARP_TRACING=false (node-logs-only.mjs)');
{
  const app = await run(nodeArgs('node-logs-only.mjs'), { TEST_KEY: 'node-logs-only', ZHARP_TRACING: 'false' });
  assert.ok(app.result, app.err);
  const logs = text('node-logs-only', '/v1/logs');
  check('activation line says logs only', () => {
    assert.match(app.out, /\[Zharp\] Application monitoring active \(logs only\)/);
  });
  check('no spans are sent', () => {
    assert.equal(byKey('node-logs-only', '/v1/traces').length, 0);
  });
  check('nothing is propagated to outgoing http.get or fetch', () => {
    assert.equal(app.result.downstreamHeaders.length, 4);
    for (const h of app.result.downstreamHeaders) assert.deepEqual(h, { traceparent: null, baggage: null });
  });
  check('Zharp.log, console and captureError are sent, with exception.* and the handled flag', () => {
    for (const s of ['logs only from the browser', 'logs only console', 'logs only caught', 'exception.stacktrace', 'zharp.handled', 'inside job, logs only']) assert.ok(logs.includes(s), s);
  });
  check("logs in a request carry the incoming traceparent's trace id, and session/user from baggage", () => {
    const traceId = Buffer.from('4bf92f3577b34da6a3ce929d0e0e4736', 'hex');
    assert.ok(byKey('node-logs-only', '/v1/logs').some((r) => r.raw.includes(traceId)));
    assert.ok(logs.includes('logs-only-session') && logs.includes('user 3'));
  });
  check('setUser inside a request stays with that request', () => {
    assert.equal(logs.split('logs-only-user').length - 1, 1);
  });
  check('startSpan runs the callback and returns its value', () => {
    assert.equal(app.result.spanResult, 42);
  });
}

console.log('\n@zharp/node: captureOutput (node-output.mjs)');
{
  const app = await run(nodeArgs('node-output.mjs'), { TEST_KEY: 'node-output' });
  assert.ok(app.result, app.err);
  const logs = text('node-output', '/v1/logs');
  const count = (s) => logs.split(s).length - 1;
  check('lines printed without console arrive: NestJS, JSON, raw stdout, stderr, split writes', () => {
    for (const s of ['nest-marker order placed', 'nest-error-marker payment failed', 'json-marker from a JSON logger', 'split-marker joined', 'stderr-marker something odd', 'outside-marker no newline']) {
      assert.ok(logs.includes(s), s);
    }
  });
  check("NestJS lines lose the colour codes and prefix; the context is kept as log.logger", () => {
    assert.ok(!logs.includes('[Nest] 61') && !logs.includes('\u001b['));
    assert.ok(logs.includes('log.logger') && logs.includes('OrdersService'));
  });
  check('levels come from the line: NestJS ERROR, JSON level 50 and stderr are not info', () => {
    assert.ok(logs.includes('ERROR') && logs.includes('WARN'));
  });
  check('a console line is sent once, not again by the output capture', () => {
    assert.equal(count('console-marker once'), 1);
  });
  check('no line is sent twice', () => {
    for (const s of ['nest-marker order placed', 'json-marker', 'split-marker joined', 'stderr-marker']) assert.equal(count(s), 1, s);
  });
  check("lines printed in a request carry that request's trace id", () => {
    const traceId = Buffer.from('5bf92f3577b34da6a3ce929d0e0e4736', 'hex');
    const withNest = byKey('node-output', '/v1/logs').filter((r) => r.text.includes('nest-marker'));
    assert.ok(withNest.length && withNest.every((r) => r.raw.includes(traceId)));
  });
  check('the app still prints every line itself', () => {
    for (const s of ['nest-marker order placed', 'json-marker', 'split-marker joined', 'console-marker once']) assert.ok(app.out.includes(s), s);
    assert.ok(app.err.includes('stderr-marker'));
  });
}

// ── captureBodies ────────────────────────────────────────────────────────────

console.log('\n@zharp/browser: captureBodies (browser-bodies.mjs)');
{
  const errors = await run(['test/unified/browser-bodies.mjs', 'errors']);
  assert.ok(errors.result, errors.err);
  const all = await run(['test/unified/browser-bodies.mjs', 'all']);
  assert.ok(all.result, all.err);
  const off = await run(['test/unified/browser-bodies.mjs', 'off']);
  assert.ok(off.result, off.err);
  const span = (key, name) => spansOf(key).find((s) => s.name === name);
  const login = span('bodies-errors', 'POST /api/login');

  check('errors: a failed request carries its request and response bodies, with the content types', () => {
    assert.ok(login.attrs['http.request.body'], JSON.stringify(login.attrs));
    assert.equal(login.attrs['http.request.header.content-type'], 'application/json');
    assert.equal(JSON.parse(login.attrs['http.response.body']).error, 'bad credentials');
    assert.equal(login.attrs['http.response.header.content-type'], 'application/json');
  });
  check('secret keys are [Filtered] (built-in and redactKeys), the rest is kept', () => {
    const sent = JSON.parse(login.attrs['http.request.body']);
    assert.deepEqual(sent, { email: 'a@b.test', password: '[Filtered]', dateOfBirth: '[Filtered]', remember: true });
    const got = JSON.parse(login.attrs['http.response.body']);
    assert.equal(got.token, '[Filtered]');
    assert.equal(got.user.apiKey, '[Filtered]');
    assert.equal(got.user.email, 'a@b.test');
  });
  check('the application still reads the response it captured', () => {
    assert.deepEqual(errors.result.consumed, ['bad credentials']);
  });
  check('errors: successful requests carry no bodies', () => {
    const ok = span('bodies-errors', 'PUT /api/ok');
    assert.ok(ok);
    assert.equal(ok.attrs['http.request.body'], undefined);
    assert.equal(ok.attrs['http.response.body'], undefined);
  });
  check('tracingOrigins are captured; third parties never are', () => {
    assert.equal(span('bodies-errors', 'POST /v1/fail').attrs['http.request.body'], '{"n":1}');
    const third = spansOf('bodies-errors').find((s) => String(s.attrs['url.full']).startsWith('https://third-party.test'));
    assert.ok(third);
    assert.equal(third.attrs['http.request.body'], undefined);
  });
  check('event streams and binary responses are described, not read', () => {
    assert.equal(span('bodies-errors', 'GET /api/events').attrs['http.response.body'], '[event stream]');
    assert.equal(span('bodies-errors', 'GET /api/image').attrs['http.response.body'], '[binary · image/png]');
  });
  check('a form upload keeps every field name; the file is described, the password filtered', () => {
    const upload = span('bodies-errors', 'POST /api/upload');
    assert.equal(upload.attrs['http.request.header.content-type'], 'multipart/form-data');
    assert.deepEqual(JSON.parse(upload.attrs['http.request.body']), { title: 'Holiday', password: '[Filtered]', photo: '[file photo.png · image/png · 2 KB]' });
  });
  check('inline images and long base64 become a short description; the fields after them stay', () => {
    const profile = span('bodies-errors', 'POST /api/profile');
    const sent = JSON.parse(profile.attrs['http.request.body']);
    assert.equal(sent.avatar, '[image/png · 32 KB]');
    assert.equal(sent.blob, '[base64 · 1 KB]');
    assert.equal(sent.name, 'Ada');
  });
  check('a secret object keeps its keys, every value filtered', () => {
    const sent = JSON.parse(span('bodies-errors', 'POST /api/profile').attrs['http.request.body']);
    assert.deepEqual(sent.card, { brand: '[Filtered]', last4: '[Filtered]' });
  });
  check('secret query values are filtered in url.full; the rest of the URL stays', () => {
    assert.equal(span('bodies-errors', 'POST /api/profile').attrs['url.full'], 'http://localhost:5173/api/profile?token=[Filtered]&page=2');
    assert.ok(!JSON.stringify(spansOf('bodies-off')).includes('url-secret'), 'even with captureBodies off');
  });
  check('all: successful requests too; forms are redacted; long bodies are cut at maxSize', () => {
    assert.equal(span('bodies-all', 'PUT /api/ok').attrs['http.request.body'], '{"name":"Ada"}');
    assert.equal(span('bodies-all', 'POST /api/form').attrs['http.request.body'], 'user=ada&password=[Filtered]');
    const big = span('bodies-all', 'GET /api/big');
    assert.equal(big.attrs['http.response.body'].length, 1000);
    assert.equal(big.attrs['http.response.body.truncated'], true);
  });
  check('the span keeps the time the response arrived, not the time its body was read', () => {
    const s = span('bodies-all', 'GET /api/big');
    assert.ok(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano));
  });
  check('off by default: no bodies at all', () => {
    for (const s of spansOf('bodies-off')) {
      assert.equal(s.attrs['http.request.body'], undefined, s.name);
      assert.equal(s.attrs['http.response.body'], undefined, s.name);
    }
    assert.ok(span('bodies-off', 'POST /api/login'));
  });
}

console.log('\n@zharp/node: captureBodies (node-bodies.mjs, ZHARP_CAPTURE_BODIES=errors)');
{
  const app = await run(nodeArgs('node-bodies.mjs'), { TEST_KEY: 'node-bodies', ZHARP_CAPTURE_BODIES: 'errors' });
  assert.ok(app.result, app.err + app.out);
  const traces = text('node-bodies', '/v1/traces');
  check('the app reads and answers exactly as without the SDK', () => {
    assert.match(app.result.signup, /email ada@x\.test taken/);
    assert.equal(app.result.later, 'failed for 60 bytes');
    assert.match(app.result.pay, /card declined/);
    assert.equal(app.result.list, '{"listed":true}');
    assert.equal(app.result.fine.text, '{"fine":true}');
  });
  check('incoming failed request: request and response bodies, secrets [Filtered]', () => {
    assert.ok(traces.includes('http.request.body'));
    assert.ok(traces.includes('"email":"ada@x.test","password":"[Filtered]"'), 'request body');
    assert.ok(traces.includes('"sessionToken":"[Filtered]"'), 'response body');
    assert.ok(traces.includes('http.response.header.content-type'), 'response content type from writeHead');
    assert.ok(!traces.includes('pw-secret') && !traces.includes('srv-token'));
  });
  check('a body read late, by async iteration, is still captured; a written-in-parts response is joined', () => {
    assert.ok(traces.includes('late-body-yyyy'));
    assert.ok(traces.includes('failed for 60 bytes'));
  });
  check('outgoing failed call: its request body and its gzipped response, inflated and redacted', () => {
    assert.ok(traces.includes('"amount":5,"cvv":"[Filtered]"'));
    assert.ok(traces.includes('"error":"card declined","cardNumber":"[Filtered]"'));
    assert.ok(!traces.includes('4242424242424242') && !traces.includes('"cvv":"123"'));
  });
  check('a form upload: every field by name, the 100 KB file described not sent, the password filtered', () => {
    assert.match(app.result.upload, /"received":10\d{4}/);
    assert.ok(traces.includes('"title":"Holiday","password":"[Filtered]","avatar":"[file me.png · image/png · 100 KB]","after":"still-here"'), 'multipart summary');
    assert.ok(!traces.includes('upload-secret'));
  });
  check('a binary response is described by type and size', () => {
    assert.equal(app.result.thumb, 3000);
    assert.ok(traces.includes('[binary · image/png · 3 KB]'));
  });
  check('secret query values are filtered on every span', () => {
    assert.ok(!traces.includes('query-secret-1'));
    assert.ok(traces.includes('token=[Filtered]&size=2'));
  });
  check('errors mode: successful requests, incoming and outgoing, carry no bodies', () => {
    assert.ok(!traces.includes('ok-request-body'));
    assert.ok(!traces.includes('ok-outgoing-body'));
  });
}

server.close();
console.log(failures ? `\n${failures} check(s) failed, ${passed} passed` : `\nAll ${passed} checks passed`);
process.exitCode = failures ? 1 : 0;
