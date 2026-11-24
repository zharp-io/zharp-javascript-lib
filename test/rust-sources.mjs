/**
 * `zharp sources upload`: a Rust crate's src/ bundled under the build ID its build.rs computes.
 *
 *     node test/rust-sources.mjs
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'cli');
const tmp = mkdtempSync(join(pkg, '.test-'));
await esbuild.build({ entryPoints: [join(pkg, 'src', 'rust-sources.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(tmp, 'rs.mjs'), logLevel: 'silent' });
const rs = await import(pathToFileURL(join(tmp, 'rs.mjs')).href);
const silent = { info() {}, warn() {}, error() {} };

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}
function crate(files) {
  const dir = mkdtempSync(join(tmp, 'c-'));
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), data);
  }
  return dir;
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 32);

console.log('\nzharp sources upload — Rust');

await test('the build ID: the test vector, hashed as build.rs does', () => {
  const dir = crate({ 'Cargo.toml': '[package]\nname = "shop"\n', 'src/main.rs': 'fn main() {}\n', 'src/cart/mod.rs': 'pub fn total() {}\n' });
  const expected = sha(Buffer.from('src/cart/mod.rs\0pub fn total() {}\n\0src/main.rs\0fn main() {}\n\0', 'utf8'));
  assert.equal(rs.rustBuildId(dir), expected);
  assert.match(rs.rustBuildId(dir), /^[0-9a-f]{32}$/);
});

await test('only src/**/*.rs, in byte order; raw bytes (no line-ending changes); an empty crate hashes nothing', () => {
  const files = {
    'Cargo.toml': '[package]\nname = "x"\n',
    'build.rs': 'fn main() {}',
    'tests/it.rs': 'x',
    'src/main.rs': 'fn main() {}\r\n',
    'src/a.rs': 'a',
    'src/a/b.rs': 'ab',
    'src/a_b.rs': 'a_b',
    'src/B.rs': 'B',
    'src/build/mod.rs': 'build module',
    'src/notes.md': 'not code',
    'src/é.rs': 'accent',
  };
  const dir = crate(files);
  const order = rs.rustSourceFiles(dir).map((f) => f.path);
  assert.deepEqual(order, ['src/B.rs', 'src/a.rs', 'src/a/b.rs', 'src/a_b.rs', 'src/build/mod.rs', 'src/main.rs', 'src/é.rs']);
  const bytes = Buffer.concat(order.map((p) => Buffer.concat([Buffer.from(p, 'utf8'), Buffer.from([0]), Buffer.from(files[p], 'utf8'), Buffer.from([0])])));
  assert.equal(rs.rustBuildId(dir), sha(bytes));
  assert.equal(rs.rustBuildId(crate({ 'Cargo.toml': '' })), sha(Buffer.alloc(0)));
});

await test('upload (dry run): the bundle is src/, keyed from the crate, under the computed build ID; found from a folder inside the crate', async () => {
  const dir = crate({ 'Cargo.toml': '[package]\nname = "shop"\n', 'src/main.rs': 'fn main() {}\n', 'src/test/mod.rs': 'mod t;', 'target/debug/build/x/out/gen.rs': 'generated' });
  const { buildId, artifacts } = await rs.uploadRustSources(join(dir, 'src', 'test'), null, { dryRun: true, logger: silent, release: 'shop@1.0.0' });
  assert.equal(buildId, rs.rustBuildId(dir));
  assert.equal(artifacts.length, 1);
  const [a] = artifacts;
  assert.equal(a.kind, 'source-bundle');
  assert.equal(a.debugId, buildId);
  assert.equal(a.release, 'shop@1.0.0');
  assert.deepEqual(JSON.parse(Buffer.from(a.data).toString('utf8')).files, { 'src/main.rs': 'fn main() {}\n', 'src/test/mod.rs': 'mod t;' });
  void gunzipSync;
});

await test('--build-id overrides; the ID used is said', async () => {
  const dir = crate({ 'Cargo.toml': '[package]\nname = "a"\n', 'src/main.rs': 'fn main() {}\n' });
  const said = [];
  const { buildId, artifacts } = await rs.uploadRustSources(dir, null, { dryRun: true, buildId: 'abc123', logger: { info: (m) => said.push(m), warn() {}, error() {} } });
  assert.equal(buildId, 'abc123');
  assert.equal(artifacts[0].debugId, 'abc123');
  assert.ok(said[0].includes('abc123') && said[0].includes(rs.rustBuildId(dir)));
});

await test('a workspace root, or no Cargo.toml: a clear error', async () => {
  const ws = crate({ 'Cargo.toml': '[workspace]\nmembers = ["api"]\n', 'api/Cargo.toml': '[package]\nname = "api"\n', 'api/src/main.rs': 'fn main() {}' });
  await assert.rejects(rs.uploadRustSources(ws, null, { dryRun: true, logger: silent }), /workspace root/);
  const { buildId } = await rs.uploadRustSources(join(ws, 'api'), null, { dryRun: true, logger: silent });
  assert.equal(buildId, rs.rustBuildId(join(ws, 'api')));
});

await test('sent with the connection: one source-bundle upload under the build ID', async () => {
  const dir = crate({ 'Cargo.toml': '[package]\nname = "a"\n', 'src/main.rs': 'fn main() {}\n' });
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: { id: 1 } }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  await rs.uploadRustSources(dir, { url: 'https://api.example.com', authToken: 'zh_x', app: '42' }, { logger: silent, fetch, retries: 0 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/applications\/42\/artifacts$/);
  assert.equal(calls[0].init.body.get('kind'), 'source-bundle');
  assert.equal(calls[0].init.body.get('debugId'), rs.rustBuildId(dir));
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
