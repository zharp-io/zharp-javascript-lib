/**
 * `debug-files upload`: Breakpad .sym files for C/C++ minidump crashes, their sources, and the
 * dump_syms download's checksum. Runs without dump_syms (only .sym inputs); the conversion of
 * real PDB/ELF/Mach-O files is covered by test/e2e/debug-files (Docker).
 *
 *     node test/debug-files.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'cli');
const tmp = mkdtempSync(join(pkg, '.test-'));
await esbuild.build({ entryPoints: [join(pkg, 'src', 'index.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(tmp, 'cli.mjs'), logLevel: 'silent' });
const cli = await import(pathToFileURL(join(tmp, 'cli.mjs')).href);
const quiet = { info() {}, warn() {} };
let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
};

function sym(id, name, { funcs = true, files = [] } = {}) {
  return [
    `MODULE Linux x86_64 ${id} ${name}`,
    'INFO CODE_ID 89D6A0A60FFBDAA7F8AAD1DAB7F75D6C',
    ...files.map((file, i) => `FILE ${i} ${file}`),
    ...(funcs ? ['FUNC 2f50 2b 0 Cart::total() const', '2f50 4 5 0'] : []),
    'STACK CFI INIT 2f50 2b .cfa: $rsp 8 + .ra: .cfa -8 + ^',
    '',
  ].join('\n');
}

try {
  await test('MODULE line', () => {
    assert.deepEqual(cli.parseModuleLine('MODULE windows x86_64 E5A4B8C2D1F04A7B9C3D2E1F0A9B8C7D1 MyGame.pdb'), { os: 'windows', arch: 'x86_64', debugId: 'E5A4B8C2D1F04A7B9C3D2E1F0A9B8C7D1', name: 'MyGame.pdb' });
    assert.equal(cli.parseModuleLine('MODULE Linux x86_64 6EDC6ACDB282125843FD59DA9C81BD830 my game')?.name, 'my game', 'a name with a space');
    assert.equal(cli.parseModuleLine('FUNC 1 2 3 x'), null);
  });

  const build = join(tmp, 'build');
  const src = join(tmp, 'src');
  mkdirSync(join(build, 'sub'), { recursive: true });
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'cart.cpp'), 'int Cart::total() const {\n  return 0;\n}\n');
  const cart = join(src, 'cart.cpp').split('\\').join('/');
  writeFileSync(join(build, 'shop.sym'), sym('A6A0D689FB0FA7DAF8AAD1DAB7F75D6C0', 'shop', { files: [cart, '/usr/include/c++/13/bits/stl_vector.h', '/nowhere/gone.cpp'] }));
  // The same module from a stripped binary: CFI only, and the one with functions wins.
  writeFileSync(join(build, 'sub', 'shop-stripped.sym'), sym('a6a0d689fb0fa7daf8aad1dab7f75d6c0', 'shop', { funcs: false }));
  writeFileSync(join(build, 'sub', 'libcart.so.sym'), sym('11112222333344445555666677778888' + '0', 'libcart.so'));
  writeFileSync(join(build, 'notes.sym'), 'not a symbol file\n');
  writeFileSync(join(build, 'readme.txt'), 'MODULE Linux x86_64 0000000000000000000000000000000000 nope\n');

  await test('finds .sym files, one per debug ID', async () => {
    const modules = await cli.collectSyms([build], { logger: quiet });
    assert.deepEqual(modules.map((m) => m.module.name), ['libcart.so', 'shop']);
    assert.equal(modules.find((m) => m.module.name === 'shop').functions, 1, 'the .sym with functions wins over the stripped one');
  });

  await test('sources: the app files a .sym names, not system headers', async () => {
    const [shop] = (await cli.collectSyms([join(build, 'shop.sym')], { logger: quiet }));
    const sources = cli.collectSymSources(shop);
    assert.deepEqual(Object.keys(sources.files), [cart], 'keyed by the path exactly as in the FILE record');
    assert.equal(sources.missing, 1);
    // Built elsewhere: found under --sources by the same path.
    const moved = mkdtempSync(join(tmp, 'moved-'));
    mkdirSync(join(moved, 'work', 'src'), { recursive: true });
    writeFileSync(join(moved, 'work', 'src', 'cart.cpp'), 'moved');
    writeFileSync(join(build, 'ci.sym'), sym('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB0', 'ci', { files: ['/work/src/cart.cpp'] }));
    const [ci] = await cli.collectSyms([join(build, 'ci.sym')], { logger: quiet });
    assert.deepEqual(cli.collectSymSources(ci, { root: moved }).files, { '/work/src/cart.cpp': 'moved' });
    rmSync(join(build, 'ci.sym'));
  });

  await test('uploads breakpad-sym under the MODULE id and name, gzipped, with a source bundle', async () => {
    const sent = [];
    const fetch = async (url, init) => {
      const form = init.body;
      const file = form.get('file');
      sent.push({ url, auth: init.headers.Authorization, kind: form.get('kind'), debugId: form.get('debugId'), name: form.get('name'), arch: form.get('arch'), release: form.get('release'), fileName: file.name, data: gunzipSync(Buffer.from(await file.arrayBuffer())) });
      return new Response('{"data":[]}', { status: 201 });
    };
    const connection = { url: 'http://zharp.test', authToken: 'zk_test', app: 42 };
    await cli.uploadDebugFiles([build], connection, { logger: quiet, fetch, includeSources: true, release: '1.4.2' });
    const syms = sent.filter((s) => s.kind === 'breakpad-sym').sort((a, b) => a.name.localeCompare(b.name));
    assert.equal(syms.length, 2);
    assert.equal(syms[1].url, 'http://zharp.test/api/v1/applications/42/artifacts');
    assert.equal(syms[1].auth, 'Bearer zk_test');
    assert.deepEqual([syms[1].debugId, syms[1].name, syms[1].arch, syms[1].release, syms[1].fileName], ['A6A0D689FB0FA7DAF8AAD1DAB7F75D6C0', 'shop', 'x86_64', '1.4.2', 'shop.gz']);
    assert.ok(syms[1].data.toString().startsWith('MODULE Linux x86_64 A6A0D689FB0FA7DAF8AAD1DAB7F75D6C0 shop'));
    const bundle = sent.find((s) => s.kind === 'source-bundle');
    assert.equal(bundle.debugId, 'A6A0D689FB0FA7DAF8AAD1DAB7F75D6C0');
    assert.equal(JSON.parse(bundle.data.toString()).files[cart], 'int Cart::total() const {\n  return 0;\n}\n');
  });

  await test('a module with an all-zero debug ID (a PE with no PDB reference) is skipped, with a line saying so', async () => {
    const dir = mkdtempSync(join(tmp, 'nopdb-'));
    writeFileSync(join(dir, 'tbb12.sym'), sym('000000000000000000000000000000000', 'tbb12.dll'));
    writeFileSync(join(dir, 'game.sym'), sym('CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC1', 'game.pdb'));
    const lines = [];
    const logger = { info: (line) => lines.push(line), warn: (line) => lines.push(line) };
    const result = await cli.uploadDebugFiles([dir], null, { logger, dryRun: true });
    assert.deepEqual(result.modules.map((m) => m.module.name), ['game.pdb']);
    assert.ok(lines.includes('  skipped tbb12.sym: no debug info'), lines.join('\n'));
    assert.ok(cli.isEmptyDebugId('000000000000000000000000000000000') && !cli.isEmptyDebugId('A6A0D689FB0FA7DAF8AAD1DAB7F75D6C0'));
    rmSync(join(dir, 'game.sym'));
    await assert.rejects(cli.uploadDebugFiles([dir], null, { logger: quiet, dryRun: true }), /No debug files/, 'nothing left to upload');
  });

  await test("Windows' extended-length prefix comes off FILE paths (and so off the source bundle's keys)", async () => {
    assert.equal(cli.stripExtendedPathPrefix('\\\\?\\C:\\src\\a.cpp'), 'C:\\src\\a.cpp');
    assert.equal(cli.stripExtendedPathPrefix('\\\\?\\UNC\\build\\share\\a.cpp'), '\\\\build\\share\\a.cpp');
    assert.equal(cli.stripExtendedPathPrefix('C:\\src\\a.cpp'), 'C:\\src\\a.cpp');
    const local = join(src, 'cart.cpp');
    const raw = Buffer.from(sym('DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD1', 'game.pdb', { files: [`\\\\?\\${local}`, '\\\\?\\UNC\\build\\share\\b.cpp', 'D:\\plain.cpp'] }).replace('FUNC 2f50 2b 0 Cart::total() const', 'FUNC 2f50 2b 0 weird\\\\?\\name'));
    const clean = cli.stripSymPathPrefixes(raw).toString();
    assert.deepEqual(clean.split('\n').filter((l) => l.startsWith('FILE ')), [`FILE 0 ${local}`, 'FILE 1 \\\\build\\share\\b.cpp', 'FILE 2 D:\\plain.cpp']);
    assert.ok(clean.includes('FUNC 2f50 2b 0 weird\\\\?\\name'), 'only FILE paths change');
    const unchanged = Buffer.from(sym('EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE1', 'x'));
    assert.equal(cli.stripSymPathPrefixes(unchanged), unchanged, 'no copy when there is nothing to strip');

    const dir = mkdtempSync(join(tmp, 'prefix-'));
    writeFileSync(join(dir, 'game.sym'), raw);
    const sent = [];
    const fetch = async (url, init) => {
      const form = init.body;
      sent.push({ kind: form.get('kind'), data: gunzipSync(Buffer.from(await form.get('file').arrayBuffer())).toString() });
      return new Response('{"data":[]}', { status: 201 });
    };
    await cli.uploadDebugFiles([dir], { url: 'http://zharp.test', authToken: 'zk_test', app: 1 }, { logger: quiet, fetch, includeSources: true });
    assert.ok(sent.find((s) => s.kind === 'breakpad-sym').data.includes(`\nFILE 0 ${local}\n`), 'the uploaded .sym has plain paths');
    assert.deepEqual(Object.keys(JSON.parse(sent.find((s) => s.kind === 'source-bundle').data).files), [local]);
  });

  await test('dry run sends nothing and needs no connection', async () => {
    const result = await cli.uploadDebugFiles([build], null, { logger: quiet, dryRun: true, fetch: () => assert.fail('sent') });
    assert.equal(result.artifacts.length, 2);
  });

  await test('an empty folder is an error that says what to pass', async () => {
    const empty = mkdtempSync(join(tmp, 'empty-'));
    await assert.rejects(cli.uploadDebugFiles([empty], null, { logger: quiet, dryRun: true }), /No debug files/);
  });

  await test('dump_syms: a download that fails its checksum is never run', async () => {
    const saved = { cache: process.env.ZHARP_CACHE_DIR, bin: process.env.ZHARP_DUMP_SYMS };
    process.env.ZHARP_CACHE_DIR = mkdtempSync(join(tmp, 'cache-'));
    delete process.env.ZHARP_DUMP_SYMS;
    try {
      let asked = '';
      const fetch = async (url) => {
        asked = url;
        return new Response('tampered');
      };
      await assert.rejects(cli.findDumpSyms({ logger: quiet, fetch, ignorePath: true }), /checksum/);
      assert.match(asked, /^https:\/\/github\.com\/mozilla\/dump_syms\/releases\/download\/v2\.3\.9\/dump_syms-/);
      await assert.rejects(cli.findDumpSyms({ path: join(tmp, 'no-such-dump_syms') }), /not found/);
    } finally {
      if (saved.cache === undefined) delete process.env.ZHARP_CACHE_DIR;
      else process.env.ZHARP_CACHE_DIR = saved.cache;
      if (saved.bin !== undefined) process.env.ZHARP_DUMP_SYMS = saved.bin;
    }
  });

  console.log(`debug files: ${passed} passed`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
