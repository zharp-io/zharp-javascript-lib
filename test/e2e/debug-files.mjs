/**
 * `debug-files upload` end to end on real native builds, against a stand-in for the Zharp API
 * that keeps what each request sent. Run in a Linux container (not part of `pnpm test`), with the
 * CLI built (`pnpm -r build`) and dump_syms NOT on PATH, so its first-use download and checksum
 * run for real:
 *
 *     docker run --rm -v <repo>:/repo -v <builds>:/builds -v <sources>:/work/src node:22-bookworm \
 *       node /repo/test/e2e/debug-files.mjs /builds
 *
 * <builds> holds unstripped ELF executables (one per subfolder) whose DWARF names sources under
 * /work/src, so --include-sources finds them where they were built.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', '..', 'packages', 'cli', 'dist', 'cli.js');
const builds = process.argv[2] || '/builds';

/** The multipart body as fields and files (enough of RFC 7578 for what fetch's FormData sends). */
function parseMultipart(body, type) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type);
  const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const parts = {};
  let at = body.indexOf(marker);
  while (at >= 0) {
    const next = body.indexOf(marker, at + marker.length);
    if (next < 0) break;
    const part = body.subarray(at + marker.length + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    const headers = part.subarray(0, split).toString();
    const name = /name="([^"]+)"/.exec(headers)[1];
    const filename = /filename="([^"]*)"/.exec(headers)?.[1];
    const content = part.subarray(split + 4);
    parts[name] = filename !== undefined ? { filename, content } : content.toString();
    at = next;
  }
  return parts;
}

const received = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received.push({ url: req.url, auth: req.headers.authorization, parts: parseMultipart(Buffer.concat(chunks), req.headers['content-type']) });
    res.writeHead(201, { 'content-type': 'application/json' }).end('{"data":[]}');
  });
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const url = `http://127.0.0.1:${server.address().port}`;
const cache = mkdtempSync(join(tmpdir(), 'zharp-cache-'));
const run = (args, extra = {}) => {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ZHARP_AUTH_TOKEN: 'zk_e2e', ZHARP_URL: url, ZHARP_CACHE_DIR: cache, ...extra } });
  process.stdout.write(result.stdout + result.stderr);
  return result;
};

try {
  assert.notEqual(spawnSync('sh', ['-c', 'command -v dump_syms']).status, 0, 'dump_syms must not be on PATH: the download is what this checks');

  // 1. Real ELF builds: dump_syms downloaded and checked, .sym made, uploaded with sources.
  // Spawned, not spawnSync: this process's server has to answer while the CLI uploads.
  const upload = await new Promise((done) => {
    const p = spawn(process.execPath, [cli, 'debug-files', 'upload', builds, '--app', '7', '--include-sources', '--release', '1.4.2'], { env: { ...process.env, ZHARP_AUTH_TOKEN: 'zk_e2e', ZHARP_URL: url, ZHARP_CACHE_DIR: cache } });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (out += c));
    p.on('close', (status) => done({ status, out }));
  });
  process.stdout.write(upload.out);
  assert.equal(upload.status, 0);
  assert.match(upload.out, /Downloading dump_syms 2\.3\.9/);
  assert.ok(existsSync(join(cache, 'zharp', 'dump_syms-2.3.9', 'dump_syms')), 'cached for next time');

  const syms = received.filter((r) => r.parts.kind === 'breakpad-sym');
  const bundles = received.filter((r) => r.parts.kind === 'source-bundle');
  const folders = readdirSync(builds, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
  assert.equal(syms.length, folders, 'one .sym per build');
  for (const sym of syms) {
    assert.equal(sym.url, '/api/v1/applications/7/artifacts');
    assert.equal(sym.auth, 'Bearer zk_e2e');
    const text = gunzipSync(sym.parts.file.content).toString();
    const [, os, arch, id, name] = /^MODULE (\S+) (\S+) (\S+) (.+)$/m.exec(text);
    assert.deepEqual([sym.parts.debugId, sym.parts.name, sym.parts.arch, sym.parts.release, os], [id, name, arch, '1.4.2', 'Linux']);
    assert.match(text, /^FUNC .* Cart::total\(\) const$/m, 'functions from DWARF');
    assert.match(text, /^STACK CFI INIT /m, 'unwind info for the walker');
    const bundle = bundles.find((b) => b.parts.debugId === id);
    const files = JSON.parse(gunzipSync(bundle.parts.file.content).toString()).files;
    assert.ok(files['/work/src/cart.cpp'].includes('Cart::total'), 'the code that ran, under the path the .sym names');
    assert.ok(!Object.keys(files).some((p) => p.startsWith('/usr/')), 'no system headers');
  }
  const ids = syms.map((s) => s.parts.debugId);
  assert.equal(new Set(ids).size, ids.length, 'two builds, two debug IDs');

  // 2. A second run uses the cached dump_syms.
  received.length = 0;
  const again = run(['debug-files', 'upload', builds, '--app', '7', '--dry-run']);
  assert.equal(again.status, 0);
  assert.doesNotMatch(again.stdout + again.stderr, /Downloading/);
  assert.equal(received.length, 0, 'dry run sends nothing');

  // 3. A folder of .sym files from someone's own Breakpad setup: uploaded as they are.
  const own = mkdtempSync(join(tmpdir(), 'own-syms-'));
  writeFileSync(join(own, 'shop.sym'), gunzipSync(syms[0].parts.file.content));
  const dry = run(['debug-files', 'upload', own, '--app', '7', '--dry-run'], { ZHARP_DUMP_SYMS: '/nonexistent' });
  assert.equal(dry.status, 0, '.sym inputs never need dump_syms');
  assert.match(dry.stdout + dry.stderr, /would upload symbols shop x86_64/);

  console.log('debug-files e2e: passed');
} finally {
  server.close();
}
