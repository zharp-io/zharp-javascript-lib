/**
 * @zharp/electron end to end, in Docker (see docker.sh): a real Electron app under xvfb, driven
 * by Playwright's _electron, sending to a stand-in server (server.mjs).
 *
 * 1. Main and two sandboxed windows with a strict CSP: a handled main error, an uncaught error in
 *    each window, a failed fetch. Everything from the windows arrives through main (the page's
 *    CSP has no Zharp URL), with one session, the user and the device, and `app:///` paths.
 * 2. process.crash() in a renderer: a "render-process-gone" event, and its minidump from
 *    Electron's crash reporter with Zharp's annotations.
 * 3. An uncaught error in main: reported, then Electron's dialog as before.
 * 4. process.crash() in main: its minidump.
 * 5. Offline: a window's error kept on disk; sent on the next launch.
 * 6. (WALK=1) main's minidump walked with Electron's own published symbols.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { standIn } from './server.mjs';

const require = createRequire(join(process.cwd(), 'noop.js'));
const { _electron } = require('playwright-core');
const electronPath = require('electron');
const PORT = 8787;
const userData = join(tmpdir(), 'zharp-electron-ud');
const app = process.cwd();
let failures = 0;

function check(ok, what, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail !== undefined ? `\n     ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 1500)}` : ''}`);
  if (!ok) failures++;
}

async function until(fn, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// The renderer bundle, built as a release would be: minified, with maps and debug IDs.
require('esbuild').buildSync({ entryPoints: [join(app, 'renderer-src.js')], bundle: true, minify: true, sourcemap: true, outfile: join(app, 'dist/renderer.js'), format: 'iife' });
execFileSync(process.execPath, [join(app, 'node_modules/@zharp/cli/dist/cli.js'), 'sourcemaps', 'inject', 'dist'], { cwd: app, stdio: 'inherit' });

const server = await standIn(PORT, join(tmpdir(), 'zharp-electron-dumps'));
const { state } = server;
rmSync(userData, { recursive: true, force: true });

async function launch() {
  const electron = await _electron.launch({
    executablePath: electronPath,
    // Docker runs as root, where Chromium's sandbox can't start.
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), app],
    cwd: app,
    env: { ...process.env, STANDIN_PORT: String(PORT), TEST_USER_DATA: userData },
  });
  electron.process().stderr?.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
  electron.process().stdout?.on('data', (d) => process.env.VERBOSE && process.stdout.write(d));
  const windows = await until(async () => {
    const pages = electron.windows().filter((p) => p.url().includes('index.html'));
    if (pages.length < 2) return null;
    for (const p of pages) if (!(await p.evaluate(() => !!window.test).catch(() => false))) return null;
    return pages;
  });
  return { electron, windows };
}

/** Quit the app as a user would (Playwright's close), and check it's gone within 10 seconds. */
async function quit(electron) {
  const proc = electron.process();
  const exited = proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise((r) => proc.once('exit', r));
  const started = Date.now();
  electron.close().catch(() => {});
  const gone = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 10_000))]);
  check(gone, `the app quits (after flushing) — ${gone ? `${Date.now() - started} ms` : 'still running after 10 s'}`);
  if (!gone) proc.kill('SIGKILL');
}

const logRecords = () =>
  state.otlp.filter((r) => r.json?.resourceLogs).flatMap((r) =>
    r.json.resourceLogs.flatMap((rl) => rl.scopeLogs.flatMap((sl) => sl.logRecords.map((rec) => ({ resource: attrs(rl.resource.attributes), attrs: attrs(rec.attributes), body: rec.body?.stringValue, auth: r.auth })))));
const spans = () =>
  state.otlp.filter((r) => r.json?.resourceSpans).flatMap((r) => r.json.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans.map((s) => ({ ...s, a: attrs(s.attributes) })))));
const protobuf = () => state.otlp.filter((r) => !r.json).map((r) => r.text).join('\n');
function attrs(list = []) {
  return Object.fromEntries(list.map(({ key, value }) => [key, value.stringValue ?? value.intValue ?? value.boolValue ?? value.doubleValue]));
}

const only = process.env.ONLY;

// ── 1. errors from main and the windows ──────────────────────────────────────────────
if (!only) {
  const { electron, windows } = await launch();
  check(!!windows, 'two windows started with the bridge');
  const [w1, w2] = windows;
  const mainSession = await electron.evaluate(() => globalThis.test.zharp.sessionId);
  const deviceId = await electron.evaluate(() => globalThis.test.zharp.deviceId);
  const sessions = await Promise.all(windows.map((w) => w.evaluate(() => window.test.sessionId())));
  check(sessions.every((s) => s === mainSession), 'one session across main and both windows', { mainSession, sessions });

  await electron.evaluate(() => globalThis.test.mainError());
  await w1.evaluate(() => window.test.throwLater('window one boom'));
  await w2.evaluate(() => window.test.throwLater('window two boom'));
  await w1.evaluate(() => window.test.failedFetch());
  await new Promise((r) => setTimeout(r, 300));
  for (const w of windows) await w.evaluate(() => window.test.flush());
  await electron.evaluate(() => globalThis.test.zharp.flush());

  const one = await until(() => logRecords().find((r) => r.attrs['exception.message'] === 'window one boom'));
  const two = await until(() => logRecords().find((r) => r.attrs['exception.message'] === 'window two boom'));
  check(!!one && !!two, "both windows' errors arrived (through main: the page's CSP has no Zharp URL)");
  if (one) {
    check(one.attrs['session.id'] === mainSession && two?.attrs['session.id'] === mainSession, "the windows' errors carry main's session", { one: one.attrs['session.id'], mainSession });
    check(one.attrs['enduser.id'] === 'user-7' && one.attrs['enduser.email'] === 'ana@example.com', "the user main set is on the windows' errors", one.attrs);
    check(one.resource['device.id'] === deviceId && one.resource['zharp.sdk.platform'] === 'electron' && !!one.resource['electron.version'], 'device, platform and Electron version on the resource', one.resource);
    check(one.auth === 'Bearer zpk_electron_test', 'main sends with the key');
    const stack = one.attrs['exception.stacktrace'] ?? '';
    check(stack.includes('app:///dist/renderer.js') && !stack.includes('file://'), 'renderer stack frames read app:///dist/renderer.js', stack);
    const ids = JSON.parse(one.attrs['zharp.debug_ids'] ?? '{}');
    check(Object.keys(ids).some((k) => k === 'app:///dist/renderer.js'), 'debug IDs keyed by the same app:/// path', ids);
    check(!JSON.stringify(one).includes(app), 'no install path anywhere in the record');
  }
  const failed = await until(() => spans().find((s) => s.a['url.full']?.includes('/api/app/fail')));
  check(!!failed && String(failed.a['http.response.status_code']) === '500', 'the failed fetch is a span with its status', failed?.a);
  const pb = await until(() => (protobuf().includes('main handled boom') ? protobuf() : null));
  check(!!pb, "main's handled error arrived (@zharp/node, protobuf)");
  check(!!pb && pb.includes('app:///main.js') && !pb.includes(`${app}/main.js`), "main's stack reads app:///main.js", pb?.match(/[^\n]*main handled boom[\s\S]{0,300}/)?.[0]);
  check(!!pb && pb.includes(mainSession) && pb.includes(deviceId), "main's records carry the session and device ID");

  // ── 2. a renderer crashes ──────────────────────────────────────────────────────────
  await electron.evaluate(() => globalThis.test.crashWindow());
  const crasher = await until(() => electron.windows().find((p) => p.url().includes('crash.html')));
  await crasher.evaluate(() => window.crashNow()).catch(() => {});
  const gone = await until(() => logRecords().find((r) => r.attrs['exception.type'] === 'RendererProcessGone'));
  check(!!gone, 'process.crash() in a renderer: a RendererProcessGone event', logRecords().map((r) => r.attrs['exception.type']));
  if (gone) check(gone.attrs['electron.process.reason'] === 'crashed' && gone.attrs['session.id'] === mainSession && gone.attrs['enduser.id'] === 'user-7', "…crashed, in main's session, with the user", gone.attrs);
  const rendererDump = await until(() => state.minidumps.find((d) => d.annotations.process_type === 'renderer'), 30_000);
  check(!!rendererDump, "…and the renderer's minidump from Electron's crash reporter", state.minidumps);
  if (rendererDump) {
    const a = rendererDump.annotations;
    check(rendererDump.key === 'zpk_electron_test', '…sent with the key in the URL');
    check(a['zharp.release'] === '1.2.3' && a['zharp.device_id'] === deviceId && a['zharp.session_id'] === mainSession && a['zharp.user.id'] === 'user-7', '…with release, device, session and user', a);
    check(!!a.ver && a.platform === process.platform && a.prod === 'Electron', `…and Electron's own fields (ver ${a.ver}, platform ${a.platform})`, a);
  }

  // ── 3. an uncaught error in main ───────────────────────────────────────────────────
  await electron.evaluate(() => globalThis.test.mainThrow());
  const uncaught = await until(() => protobuf().includes('main uncaught boom'));
  check(!!uncaught, "an uncaught error in main is reported (and the app doesn't exit)");
  await new Promise((r) => setTimeout(r, 1000));
  check(electron.process().exitCode === null, '…the app is still running (Electron shows its dialog, as without Zharp)');

  // Electron's dialog is modal: main waits on it, as it would without Zharp. Done with this run.
  electron.process().kill('SIGKILL');
  await new Promise((r) => electron.process().once('exit', r).exitCode !== null && r());
}

// ── 4. main crashes ────────────────────────────────────────────────────────────────
if (!only) {
  const { electron } = await launch();
  const mainSession = await electron.evaluate(() => globalThis.test.zharp.sessionId);
  const before = state.minidumps.length;
  await electron.evaluate(() => globalThis.test.mainCrash()).catch(() => {});
  const mainDump = await until(() => state.minidumps.slice(before).find((d) => d.annotations.process_type === 'browser'), 30_000);
  check(!!mainDump, "process.crash() in main: main's minidump", state.minidumps.slice(before));
  if (mainDump) check(mainDump.annotations['zharp.session_id'] === mainSession && mainDump.annotations['zharp.release'] === '1.2.3', '…with the session and release', mainDump.annotations);
  // Main crashed: whatever is left of the app (its helper processes) goes.
  electron.process().kill('SIGKILL');
  await Promise.race([electron.close().catch(() => {}), new Promise((r) => setTimeout(r, 5_000))]);
  globalThis.mainDump = mainDump;
}

// ── 5. offline, then the next launch ───────────────────────────────────────────────
{
  state.mode = 'offline';
  const { electron, windows } = await launch();
  await windows[0].evaluate(() => window.test.throwLater('offline boom'));
  await new Promise((r) => setTimeout(r, 300));
  await windows[0].evaluate(() => window.test.flush());
  const outbox = join(userData, 'zharp', 'outbox');
  const kept = await until(() => existsSync(outbox) && readdirSync(outbox).length > 0);
  check(!!kept, "offline: the window's batch is kept on disk", existsSync(outbox) ? readdirSync(outbox) : 'no outbox');
  await quit(electron);
  check(!logRecords().some((r) => r.attrs['exception.message'] === 'offline boom'), '…and nothing reached the server');

  state.mode = 'ok';
  const next = await launch();
  const sent = await until(() => logRecords().find((r) => r.attrs['exception.message'] === 'offline boom'));
  check(!!sent, '…sent on the next launch');
  const left = await until(() => !readdirSync(outbox).length);
  check(!!left, '…and removed from disk');
  await quit(next.electron);
}

// ── 6. main's minidump, walked with Electron's own symbols ─────────────────────────
if (process.env.WALK && globalThis.mainDump?.file) {
  const version = globalThis.mainDump.annotations.ver;
  const zip = `/syms/electron-v${version}-linux-x64-symbols.zip`;
  if (!existsSync(zip)) execFileSync('curl', ['-fsSL', '-o', zip, `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-linux-x64-symbols.zip`], { stdio: 'inherit' });
  const dir = `/tmp/esyms-${version}`;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    execFileSync('unzip', ['-q', zip, '-d', dir]);
  }
  // The zip holds breakpad_symbols/<module>/<id>/<module>.sym, the layout the walker reads.
  const symbols = existsSync(join(dir, 'breakpad_symbols')) ? join(dir, 'breakpad_symbols') : dir;
  const dump = globalThis.mainDump.file;
  const walk = execFileSync('minidump-stackwalk', ['--symbols-path', symbols, dump], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  const bare = execFileSync('minidump-stackwalk', [dump], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  const crashing = walk.split('\n').slice(0, 120).join('\n');
  console.log(crashing.split('\n').filter((l) => /^\s*\d+\s+\S+!/.test(l)).slice(0, 8).join('\n'));
  check(/^\s*0\s+electron!\S+/m.test(crashing), "main's minidump walks to a named crashing frame in electron, with Electron's symbols");
  check(!/^\s*0\s+electron!/m.test(bare), '…which it has no name for without them');

  // Fixtures for the backend's specs: the real dump and its upload's fields, every module the
  // zip has symbols for, and a small zip of two real .sym files from it.
  const { copyFileSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } = await import('node:fs');
  copyFileSync(dump, '/out/electron-main.dmp');
  writeFileSync('/out/electron-main.annotations.json', `${JSON.stringify(globalThis.mainDump.annotations, null, 2)}\n`);
  writeFileSync('/out/electron-main.walk.txt', crashing);
  const syms = execFileSync('find', [symbols, '-name', '*.sym'], { maxBuffer: 16 * 1024 * 1024 }).toString().trim().split('\n');
  const firstLine = (file) => {
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(512);
    readSync(fd, buf, 0, 512, 0);
    closeSync(fd);
    return buf.toString('latin1').split('\n')[0].trim();
  };
  writeFileSync(`/out/electron-v${version}-linux-x64.modules.txt`, `${syms.map((f) => `${firstLine(f)}\t${f.slice(dir.length + 1)}\t${statSync(f).size}`).join('\n')}\n`);
  // The smallest .sym, cut to its first 3000 lines (Linux has one: electron, 835 MB), zipped at
  // the path Electron's zip uses.
  const smallest = syms.map((f) => ({ f, size: statSync(f).size })).sort((x, y) => x.size - y.size)[0].f;
  const rel = smallest.slice(dir.length + 1);
  const cut = join(tmpdir(), 'zharp-small-syms');
  mkdirSync(join(cut, rel, '..'), { recursive: true });
  writeFileSync(join(cut, rel), execFileSync('head', ['-n', '3000', smallest], { maxBuffer: 64 * 1024 * 1024 }));
  rmSync('/out/electron-symbols-small.zip', { force: true });
  execFileSync('zip', ['-q', '-9', '/out/electron-symbols-small.zip', rel], { cwd: cut });
}

server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
