/**
 * End to end against a real Zharp stack: a page running @zharp/browser (in jsdom) calls a Node
 * server running @zharp/node, and what arrived is read back from ClickHouse.
 *
 * Nothing here is part of `pnpm test` — it needs the backend running. Keys come from the
 * environment and are never written to a file:
 *
 *     ZHARP_E2E_BROWSER_KEY=zpk_…  ZHARP_E2E_NODE_KEY=zpk_… \
 *     ZHARP_E2E_CLICKHOUSE='http://localhost:8123/?user=…&password=…&database=zharp' \
 *     [ZHARP_E2E_ENDPOINT=http://localhost:3000/api/v1/otlp] \
 *     [ZHARP_E2E_API_KEY=zh_live_…  (a dashboard API key, to check the replay)] \
 *     node test/e2e/run.mjs
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
for (const name of ['ZHARP_E2E_BROWSER_KEY', 'ZHARP_E2E_NODE_KEY', 'ZHARP_E2E_CLICKHOUSE']) {
  if (!process.env[name]) {
    console.error(`${name} is not set — see the comment at the top of ${fileURLToPath(import.meta.url)}`);
    process.exit(2);
  }
}
const endpoint = process.env.ZHARP_E2E_ENDPOINT || 'http://localhost:3000/api/v1/otlp';
const run = randomBytes(4).toString('hex');
const env = { ...process.env, ZHARP_E2E_ENDPOINT: endpoint, ZHARP_E2E_RUN: run };
console.log(`run ${run}`);

function start(args, { onLine } = {}) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => {
    out += d;
    onLine?.(out);
  });
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve({ code, out, err })));
  return { child, exited };
}

// ── Node server ───────────────────────────────────────────────────────────────
let port;
const server = start(['--import', './test/e2e/instrument.mjs', './test/e2e/server.mjs'], {
  onLine: (out) => {
    const match = /LISTENING (\d+)/.exec(out);
    if (match) port = Number(match[1]);
  },
});
while (!port) await new Promise((resolve) => setTimeout(resolve, 50));
const api = `http://127.0.0.1:${port}`;

// ── page ──────────────────────────────────────────────────────────────────────
const browser = await start(['./test/e2e/browser.mjs', api]).exited;
const line = browser.out.split('\n').find((l) => l.startsWith('RESULT '));
if (!line) {
  console.error(`browser fixture failed (${browser.code})\n${browser.out}\n${browser.err}`);
  process.exit(1);
}
const page = JSON.parse(line.slice(7));
console.log('\nbrowser: spans sent');
console.table(page.spans);
console.log('browser: requests to Zharp');
console.table(page.requests);

await fetch(`${api}/flush`);
server.child.kill();
const serverOut = await server.exited;
console.log(`\nserver output:\n${serverOut.out}${serverOut.err}`);

// ── crash ─────────────────────────────────────────────────────────────────────
const crash = await start(['--import', './test/e2e/instrument.mjs', './test/e2e/crash.mjs']).exited;
console.log(`crash.mjs exited ${crash.code}; stderr starts: ${JSON.stringify(crash.err.split('\n')[0])}`);

// ── what ClickHouse has ───────────────────────────────────────────────────────
await new Promise((resolve) => setTimeout(resolve, 3_000));
async function query(sql) {
  const response = await fetch(process.env.ZHARP_E2E_CLICKHOUSE, { method: 'POST', body: `${sql} FORMAT JSON` });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json()).data;
}
const failures = [];
const expect = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
};

const traceSpans = await query(
  `SELECT service, name, kind, status_code, http_status, span_id, parent_span_id, session_id, user_id, browser_name, browser_version, os_name, os_version
   FROM spans WHERE trace_id = '${page.checkoutTrace}' ORDER BY start`,
);
console.log(`\nspans in the checkout trace ${page.checkoutTrace}`);
console.table(traceSpans);
const failSpans = await query(
  `SELECT service, name, kind, status_code, http_status, session_id, user_id FROM spans WHERE trace_id = '${page.failTrace}' ORDER BY start`,
);
console.log(`spans in the failing XHR's trace ${page.failTrace}`);
console.table(failSpans);

const logs = await query(
  `SELECT service, severity, body, trace_id, span_id, session_id, user_id FROM logs
   WHERE (body LIKE '%${run}%' OR trace_id IN ('${page.checkoutTrace}', '${page.failTrace}')) ORDER BY timestamp`,
);
console.log('logs');
console.table(logs.map((l) => ({ ...l, body: l.body.slice(0, 60) })));

const errors = await query(
  `SELECT service, exception_type, message, handled, trace_id, session_id, user_id, browser_name, os_name, substring(stacktrace, 1, 60) AS stack
   FROM error_events WHERE message LIKE '%${run}%' ORDER BY timestamp`,
);
console.log('error_events');
console.table(errors);

const sessions = await query(`SELECT service, session_id, user_id, browser_name, os_name, event_count, error_count FROM sessions WHERE session_id = '${page.sessionId}'`);
console.log('sessions');
console.table(sessions);

console.log('\nchecks');
const web = traceSpans.filter((s) => s.service === 'checkout-web');
const apiSpans = traceSpans.filter((s) => s.service === 'checkout-api');
expect(web.some((s) => s.name === 'click “Pay now”') && web.some((s) => s.name === 'GET /api/checkout'), 'browser: interaction span and fetch span in the trace');
expect(apiSpans.some((s) => s.kind === 'SERVER'), 'node: SERVER span in the same trace');
const fetchSpan = web.find((s) => s.name === 'GET /api/checkout');
expect(apiSpans.some((s) => s.kind === 'SERVER' && s.parent_span_id === fetchSpan?.span_id), 'node SERVER span is a child of the browser fetch span');
expect(apiSpans.some((s) => s.name === 'price cart'), 'node: manual span from Zharp.startSpan');
expect(traceSpans.every((s) => s.session_id === page.sessionId && s.user_id === `e2e-user-${run}`), 'every span in the trace carries session_id and user_id (node via baggage)');
expect(web.every((s) => s.browser_name === 'Chrome' && s.os_name === 'macOS'), 'browser spans carry browser/os');
expect(failSpans.some((s) => s.service === 'checkout-web' && s.status_code === 'ERROR') && failSpans.some((s) => s.service === 'checkout-api' && s.http_status === 500), 'XHR trace: browser span ERROR, server span 500');
const nodeLog = logs.find((l) => l.service === 'checkout-api' && l.body === 'checkout requested');
expect(!!nodeLog && nodeLog.trace_id === page.checkoutTrace && nodeLog.session_id === page.sessionId && nodeLog.user_id === `e2e-user-${run}`, 'node Zharp.log.info carries trace_id, session_id, user_id');
expect(logs.some((l) => l.service === 'checkout-api' && l.body.startsWith('console line from the handler') && l.trace_id === page.checkoutTrace), 'node console.log bridged, with trace_id');
const browserLog = logs.find((l) => l.service === 'checkout-web' && l.body === `browser log ${run}`);
expect(!!browserLog && browserLog.session_id === page.sessionId && browserLog.user_id === `e2e-user-${run}`, 'browser Zharp.log.info carries session_id and user_id');
const byMessage = (text) => errors.find((e) => e.message.includes(text));
expect(byMessage('handled browser error')?.handled === 1, 'browser captureError → error_events, handled');
expect(byMessage("reading 'total'")?.handled === 0 && byMessage("reading 'total'")?.exception_type === 'TypeError', 'browser uncaught TypeError → error_events, unhandled');
const nodeHandled = byMessage('card declined');
expect(nodeHandled?.handled === 1 && nodeHandled?.trace_id === page.failTrace && nodeHandled?.session_id === page.sessionId, 'node captureError → error_events, handled, in the XHR trace with the session');
expect(byMessage(`crash ${run}`)?.handled === 0 && crash.code === 1, 'node uncaught exception → error_events, unhandled; process exited 1');
expect(sessions.length > 0, 'sessions row for the browser session');
const replays = page.requests.filter((r) => r.path === '/v1/replays');
expect(replays.length > 0 && replays.every((r) => r.hasError && r.traceIds > 0 && r.events > 0), 'buffered replay sent once the error happened (hasError, traceIds, events)');
expect(replays.every((r) => r.status !== 400 && r.status !== 401 && r.status !== 403), 'replay batches accepted by auth and validation (not 400/401/403)');
expect(replays.some((r) => r.status === 200), 'replay batch stored (200)');

if (process.env.ZHARP_E2E_API_KEY) {
  const base = endpoint.replace(/\/otlp$/, '');
  const response = await fetch(`${base}/apm/replays/${page.sessionId}`, { headers: { Authorization: `Bearer ${process.env.ZHARP_E2E_API_KEY}` } });
  const body = await response.json().catch(() => ({}));
  const text = JSON.stringify(body);
  console.log(`\nGET /apm/replays/${page.sessionId} → ${response.status}, ${text.length} bytes`);
  expect(response.ok && text.includes('"type"'), 'replay readable from the dashboard API');
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
// exitCode, not exit(): exiting while fetch's sockets close trips a libuv assertion on Windows.
process.exitCode = failures.length ? 1 : 0;
