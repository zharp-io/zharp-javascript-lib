/**
 * Readable stack traces: @zharp/cli (inject, upload, native symbol files), the bundler plugins,
 * and the debug IDs @zharp/browser and @zharp/node attach to errors. Run `pnpm -r build` first
 * (`pnpm test` does).
 *
 * A local server stands in for Zharp: it parses the artifact uploads (multipart) and records
 * the SDKs' OTLP requests. Real bundles are built with esbuild and Rollup.
 *
 *     node test/readable-stacks.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { rollup } from 'rollup';
import * as cli from '@zharp/cli';
import { zharpEsbuildPlugin } from '@zharp/esbuild-plugin';
import { zharpRollupPlugin } from '@zharp/rollup-plugin';
import { ZharpWebpackPlugin } from '@zharp/webpack-plugin';
import { zharp as zharpVite } from '@zharp/vite-plugin';
import { withZharp } from '@zharp/nextjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const fixtures = join(here, 'readable-stacks');
const CLI = join(root, 'packages/cli/dist/cli.js');
const tmp = mkdtempSync(join(tmpdir(), 'zharp-readable-stacks-'));

// ── fake Zharp ───────────────────────────────────────────────────────────────

const uploads = [];
const otlp = [];
const attempts = new Map();
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let raw = Buffer.concat(chunks);
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (req.url.includes('/artifacts')) {
      const count = (attempts.get(token) ?? 0) + 1;
      attempts.set(token, count);
      if (token === 'bad-token') return reply(res, 401, { message: 'Invalid API key' });
      if (token === 'flaky-token' && count === 1) return reply(res, 503, { message: 'try again' });
      const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      const file = form.get('file');
      const fields = Object.fromEntries([...form.entries()].filter(([k]) => k !== 'file'));
      const data = Buffer.from(await file.arrayBuffer());
      uploads.push({ url: req.url, token, ...fields, fileName: file.name, type: file.type, data });
      return reply(res, 201, { id: uploads.length });
    }
    if (req.headers['content-encoding'] === 'gzip') raw = gunzipSync(raw);
    const text = raw.toString('utf8');
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    otlp.push({ path: req.url, key: token, text, body });
    reply(res, 200, {});
  });
});
function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;

function run(args, env = {}) {
  return new Promise((resolve) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ZHARP_')));
    const child = spawn(process.execPath, args, { cwd: root, env: { ...clean, ZHARP_TEST_ENDPOINT: url, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${String(error.stack || error.message).split('\n').join('\n        ')}`);
  }
}

/** A minified bundle of test/readable-stacks/src/<entry>, with a source map, in a fresh directory. */
async function bundle(name, options = {}) {
  const outdir = join(tmp, name);
  await esbuild.build({
    entryPoints: [join(fixtures, 'src/app.js'), join(fixtures, 'src/other.js')],
    bundle: true,
    minify: true,
    sourcemap: true,
    format: 'iife',
    globalName: 'App',
    outdir,
    logLevel: 'silent',
    ...options,
  });
  return outdir;
}
const read = (path) => readFileSync(path, 'utf8');
const debugIdOf = (path) => /\/\/# debugId=([0-9a-f-]{36})/.exec(read(path))?.[1];
const silent = cli.silentLogger;

// ── debug IDs in code and maps ───────────────────────────────────────────────

console.log('\n@zharp/cli: debug IDs');

await check('debugIdFromContent: a v4-shaped UUID, the same for the same content, different otherwise', () => {
  const a = cli.debugIdFromContent('console.log(1)');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(cli.debugIdFromContent('console.log(1)'), a);
  assert.notEqual(cli.debugIdFromContent('console.log(2)'), a);
});

await check('injectCode: registration and comment appended, sourceMappingURL stays last; existing lines untouched', () => {
  const code = 'var a=1;\nfunction b(){throw new Error("x")}\n//# sourceMappingURL=app.js.map\n';
  const { code: out, debugId, changed } = cli.injectCode(code);
  assert.ok(changed);
  const lines = out.split('\n');
  assert.deepEqual(lines.slice(0, 2), ['var a=1;', 'function b(){throw new Error("x")}']);
  assert.match(lines[2], /__zharpDebugIds=g\.__zharpDebugIds\|\|\{\}\)\[s\]="[0-9a-f-]{36}"/);
  assert.equal(lines[3], `//# debugId=${debugId}`);
  assert.equal(lines[4], '//# sourceMappingURL=app.js.map');
});

await check('injectCode is idempotent, and keeps CRLF line endings', () => {
  const once = cli.injectCode('a();\r\nb();\r\n');
  const twice = cli.injectCode(once.code);
  assert.equal(twice.changed, false);
  assert.equal(twice.code, once.code);
  assert.equal(twice.debugId, once.debugId);
  assert.ok(!/[^\r]\n/.test(once.code), 'only CRLF');
});

await check('injectCode: a bundler-written debugId comment keeps its ID and gains the registration once', () => {
  const id = '11111111-2222-4333-8444-555555555555';
  const out = cli.injectCode(`x();\n//# debugId=${id}\n//# sourceMappingURL=x.js.map\n`);
  assert.equal(out.debugId, id);
  assert.ok(out.changed);
  assert.equal(out.code.split('.__zharpDebugIds=').length, 2);
  assert.ok(out.code.indexOf('__zharpDebugIds') < out.code.indexOf('//# debugId='));
  assert.equal(cli.injectCode(out.code).changed, false);
});

await check('injectCode with stripSourceMappingUrl drops the comment', () => {
  const out = cli.injectCode('x();\n//# sourceMappingURL=x.js.map\n', { stripSourceMappingUrl: true });
  assert.ok(!out.code.includes('sourceMappingURL'));
});

await check('the registration snippet is ES5 and registers the file by a stack taken inside it', () => {
  const snippet = cli.registrationSnippet('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.ok(!/=>|\blet\b|\bconst\b|\?\?|\|\|=|`/.test(snippet), snippet);
  const g = {};
  new Function('globalThis', snippet)(g);
  const [[stack, id]] = Object.entries(g.__zharpDebugIds);
  assert.equal(id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.match(stack, /^Error\n\s+at /);
});

await check('injectMap: debugId and debug_id set, mappings untouched', () => {
  const map = JSON.stringify({ version: 3, sources: ['a.js'], sourcesContent: ['x'], mappings: 'AAAA;AACA', names: [] });
  const out = cli.injectMap(map, 'abc');
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.debugId, 'abc');
  assert.equal(parsed.debug_id, 'abc');
  assert.equal(parsed.mappings, 'AAAA;AACA');
  assert.ok(out.hasSourcesContent);
  assert.equal(cli.injectMap(out.text, 'abc').changed, false);
});

await check('globs: ** across directories, * within one, a bare name at any depth', () => {
  const f = cli.pathFilter(['assets/**/*.js', 'main.mjs'], ['**/vendor-*.js']);
  assert.ok(f('assets/index.js'));
  assert.ok(f('assets/chunks/a.js'));
  assert.ok(f('nested/main.mjs'));
  assert.ok(!f('assets/vendor-1.js'));
  assert.ok(!f('other/index.js'));
});

// ── the CLI on a real bundle ─────────────────────────────────────────────────

console.log('\n@zharp/cli: sourcemaps inject / upload');
{
  const dir = await bundle('cli');
  const mapBefore = JSON.parse(read(join(dir, 'app.js.map')));
  const codeBefore = read(join(dir, 'app.js'));
  const inject = await run([CLI, 'sourcemaps', 'inject', dir]);

  await check('inject: exit 0, both files injected, progress printed', () => {
    assert.equal(inject.code, 0, inject.err);
    assert.match(inject.out, /injected [0-9a-f-]{36}\s+app\.js/);
    assert.match(inject.out, /Injected debug IDs into 2 file\(s\)/);
  });

  await check('inject: the file ends with registration + debugId + sourceMappingURL; the map carries the same ID', () => {
    const code = read(join(dir, 'app.js'));
    const id = debugIdOf(join(dir, 'app.js'));
    assert.ok(code.startsWith(codeBefore.replace(/\n\/\/# sourceMappingURL=.*\n$/, '')));
    assert.match(code, /\n\/\/# debugId=[0-9a-f-]{36}\n\/\/# sourceMappingURL=app\.js\.map\n$/);
    const map = JSON.parse(read(join(dir, 'app.js.map')));
    assert.equal(map.debugId, id);
    assert.equal(map.debug_id, id);
    assert.equal(map.mappings, mapBefore.mappings, 'mappings unchanged');
    assert.deepEqual(map.sourcesContent, mapBefore.sourcesContent);
  });

  await check('inject is idempotent; an identical rebuild gets the same IDs', async () => {
    const before = read(join(dir, 'app.js'));
    const again = await run([CLI, 'sourcemaps', 'inject', dir]);
    assert.equal(again.code, 0);
    assert.match(again.out, /already has/);
    assert.equal(read(join(dir, 'app.js')), before);
    const rebuilt = await bundle('cli-rebuild');
    await run([CLI, 'sourcemaps', 'inject', rebuilt]);
    assert.equal(debugIdOf(join(rebuilt, 'app.js')), debugIdOf(join(dir, 'app.js')));
  });

  await check('upload without ZHARP_AUTH_TOKEN: exit 1 and says what is missing', async () => {
    const r = await run([CLI, 'sourcemaps', 'upload', dir, '--app', '4']);
    assert.equal(r.code, 1);
    assert.match(r.err, /ZHARP_AUTH_TOKEN/);
    assert.match(r.err, /artifacts:write/);
  });

  await check('upload with a rejected key: exit 1, explains, does not retry', async () => {
    const r = await run([CLI, 'sourcemaps', 'upload', dir, '--app', '4'], { ZHARP_AUTH_TOKEN: 'bad-token', ZHARP_URL: url });
    assert.equal(r.code, 1);
    assert.match(r.err, /auth token was rejected/);
    assert.match(r.err, /Invalid API key/);
    assert.ok(attempts.get('bad-token') <= 2, `attempts: ${attempts.get('bad-token')}`); // two files in parallel, one try each
  });

  await check('upload --dry-run sends nothing and keeps the maps', async () => {
    const before = uploads.length;
    const r = await run([CLI, 'sourcemaps', 'upload', dir, '--app', '4', '--dry-run', '--delete-after']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /would upload app\.js \+ app\.js\.map/);
    assert.equal(uploads.length, before);
    assert.ok(existsSync(join(dir, 'app.js.map')));
  });

  const upload = await run([CLI, 'sourcemaps', 'upload', dir, '--app', '4', '--release', 'web@1.2.3', '--delete-after'], { ZHARP_AUTH_TOKEN: 'good-token', ZHARP_URL: url });
  const sent = uploads.filter((u) => u.token === 'good-token');

  await check('upload: the file and its map for each JS file, keyed by its debug ID, with the release', () => {
    assert.equal(upload.code, 0, upload.err);
    assert.equal(sent.length, 4);
    const id = debugIdOf(join(dir, 'app.js'));
    const min = sent.find((u) => u.kind === 'minified-source' && u.name === 'app.js');
    const map = sent.find((u) => u.kind === 'sourcemap' && u.name === 'app.js.map');
    assert.ok(min && map);
    for (const u of [min, map]) {
      assert.equal(u.url, '/api/v1/applications/4/artifacts');
      assert.equal(u.debugId, id);
      assert.equal(u.release, 'web@1.2.3');
    }
    assert.equal(JSON.parse(map.data.toString()).debugId, id);
    assert.equal(min.data.toString(), read(join(dir, 'app.js')));
  });

  await check('upload --delete-after removes the maps', () => {
    assert.deepEqual(readdirSync(dir).sort(), ['app.js', 'other.js']);
    assert.match(upload.out, /Deleted 2 source map/);
  });

  await check('uploadArtifact retries a 503 and succeeds', async () => {
    const connection = { url, authToken: 'flaky-token', app: 7 };
    await cli.uploadArtifact(connection, { kind: 'sourcemap', debugId: 'x', name: 'a.js.map', data: Buffer.from('{}') }, { backoffMs: 1 });
    assert.equal(attempts.get('flaky-token'), 2);
    assert.equal(uploads.at(-1).token, 'flaky-token');
  });
}

// ── native symbol files ──────────────────────────────────────────────────────

console.log('\n@zharp/cli: proguard, dart-symbols, dsym');

/** A minimal ELF file with a GNU build-id note, in a section (64-bit LE) or a PT_NOTE segment (32-bit BE). */
function elf({ bits, little, buildId, viaSection, machine }) {
  const id = Buffer.from(buildId, 'hex');
  const note = Buffer.alloc(12 + 4 + Math.ceil(id.length / 4) * 4);
  const w32 = (b, o, v) => (little ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));
  const w16 = (b, o, v) => (little ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const wAddr = (b, o, v) => (bits === 64 ? (little ? b.writeBigUInt64LE(BigInt(v), o) : b.writeBigUInt64BE(BigInt(v), o)) : w32(b, o, v));
  w32(note, 0, 4);
  w32(note, 4, id.length);
  w32(note, 8, 3);
  note.write('GNU\0', 12, 'latin1');
  id.copy(note, 16);
  const ehsize = bits === 64 ? 64 : 52;
  const entsize = viaSection ? (bits === 64 ? 64 : 40) : bits === 64 ? 56 : 32;
  const headers = Buffer.alloc(entsize * (viaSection ? 2 : 1));
  const noteOffset = ehsize + headers.length;
  const h = Buffer.alloc(ehsize);
  h.write('\x7fELF', 0, 'latin1');
  h[4] = bits === 64 ? 2 : 1;
  h[5] = little ? 1 : 2;
  h[6] = 1;
  w16(h, 18, machine);
  if (viaSection) {
    wAddr(h, bits === 64 ? 0x28 : 0x20, ehsize);
    w16(h, bits === 64 ? 0x3a : 0x2e, entsize);
    w16(h, bits === 64 ? 0x3c : 0x30, 2);
    // Section 0 is the null section; 1 is the note.
    const s = entsize;
    w32(headers, s + 4, 7);
    wAddr(headers, s + (bits === 64 ? 0x18 : 0x10), noteOffset);
    wAddr(headers, s + (bits === 64 ? 0x20 : 0x14), note.length);
  } else {
    wAddr(h, bits === 64 ? 0x20 : 0x1c, ehsize);
    w16(h, bits === 64 ? 0x36 : 0x2a, entsize);
    w16(h, bits === 64 ? 0x38 : 0x2c, 1);
    w32(headers, 0, 4);
    wAddr(headers, bits === 64 ? 0x08 : 0x04, noteOffset);
    wAddr(headers, bits === 64 ? 0x20 : 0x10, note.length);
  }
  return Buffer.concat([h, headers, note]);
}

/** A minimal Mach-O file with an LC_UUID. */
function macho(cpuType, cpuSubtype, uuidHex) {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(0xfeedfacf, 0);
  h.writeUInt32LE(cpuType, 4);
  h.writeUInt32LE(cpuSubtype, 8);
  h.writeUInt32LE(0xa, 12); // MH_DSYM
  h.writeUInt32LE(2, 16); // ncmds
  h.writeUInt32LE(24 + 16, 20);
  const other = Buffer.alloc(16);
  other.writeUInt32LE(0x2, 0); // LC_SYMTAB-ish, skipped
  other.writeUInt32LE(16, 4);
  const uuid = Buffer.alloc(24);
  uuid.writeUInt32LE(0x1b, 0);
  uuid.writeUInt32LE(24, 4);
  Buffer.from(uuidHex, 'hex').copy(uuid, 8);
  return Buffer.concat([h, other, uuid, Buffer.from('DWARF data')]);
}
function fat(slices) {
  const header = Buffer.alloc(8 + 20 * slices.length);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(slices.length, 4);
  let offset = 4096;
  const bodies = [];
  slices.forEach((s, i) => {
    const h = 8 + i * 20;
    header.writeUInt32BE(s.readUInt32LE(4), h);
    header.writeUInt32BE(s.readUInt32LE(8), h + 4);
    header.writeUInt32BE(offset, h + 8);
    header.writeUInt32BE(s.length, h + 12);
    header.writeUInt32BE(12, h + 16);
    bodies.push({ offset, s });
    offset += Math.ceil(s.length / 4096) * 4096;
  });
  const out = Buffer.alloc(offset);
  header.copy(out, 0);
  for (const { offset: o, s } of bodies) s.copy(out, o);
  return out;
}

await check('readElf: build ID from a note section (ELF64 LE) and a PT_NOTE segment (ELF32 BE)', () => {
  const a = cli.readElf(elf({ bits: 64, little: true, buildId: '0123456789abcdef0123456789abcdef', viaSection: true, machine: 183 }));
  assert.equal(a.buildId, '0123456789abcdef0123456789abcdef');
  assert.equal(a.arch, 'arm64');
  const b = cli.readElf(elf({ bits: 32, little: false, buildId: 'deadbeefcafe', viaSection: false, machine: 40 }));
  assert.equal(b.buildId, 'deadbeefcafe');
});

await check('readMachO: thin and universal files, uppercase UUIDs and arch names', () => {
  const arm64 = macho(0x0100000c, 0, '00112233445566778899aabbccddeeff');
  assert.deepEqual(cli.readMachO(arm64).map(({ uuid, arch }) => ({ uuid, arch })), [{ uuid: '00112233-4455-6677-8899-AABBCCDDEEFF', arch: 'arm64' }]);
  const x64 = macho(0x01000007, 3, 'ffeeddccbbaa99887766554433221100');
  const images = cli.readMachO(fat([arm64, x64]));
  assert.deepEqual(images.map((i) => i.arch), ['arm64', 'x86_64']);
  assert.equal(images[1].uuid, 'FFEEDDCC-BBAA-9988-7766-554433221100');
  assert.equal(images[1].offset, 8192);
});

{
  const native = join(tmp, 'native');
  mkdirSync(join(native, 'symbols'), { recursive: true });
  const dartArm64 = elf({ bits: 64, little: true, buildId: 'aabbccddeeff00112233445566778899', viaSection: true, machine: 183 });
  writeFileSync(join(native, 'symbols/app.android-arm64.symbols'), dartArm64);
  writeFileSync(join(native, 'symbols/app.android-x64.symbols'), elf({ bits: 64, little: true, buildId: '99887766554433221100ffeeddccbbaa', viaSection: true, machine: 62 }));
  const dwarf = join(native, 'Build/Runner.app.dSYM/Contents/Resources/DWARF');
  mkdirSync(dwarf, { recursive: true });
  const arm64 = macho(0x0100000c, 0, '00112233445566778899aabbccddeeff');
  writeFileSync(join(dwarf, 'Runner'), fat([arm64, macho(0x01000007, 3, 'ffeeddccbbaa99887766554433221100')]));
  writeFileSync(join(native, 'mapping.txt'), 'com.example.Main -> a.a:\n    void main() -> a\n');
  const env = { ZHARP_AUTH_TOKEN: 'native-token', ZHARP_URL: url };
  const native_ = () => uploads.filter((u) => u.token === 'native-token');

  const pg = await run([CLI, 'proguard', 'upload', join(native, 'mapping.txt'), '--app', '9', '--uuid', 'A1B2C3D4-0000-4000-8000-000000000001'], env);
  await check('proguard upload: gzipped mapping.txt under the build UUID', () => {
    assert.equal(pg.code, 0, pg.err);
    const u = native_().find((x) => x.kind === 'proguard');
    assert.equal(u.debugId, 'a1b2c3d4-0000-4000-8000-000000000001');
    assert.equal(u.fileName, 'mapping.txt.gz');
    assert.equal(gunzipSync(u.data).toString(), read(join(native, 'mapping.txt')));
  });
  const badUuid = await run([CLI, 'proguard', 'upload', join(native, 'mapping.txt'), '--app', '9'], env);
  await check('proguard upload without --uuid: exit 1, explains', () => {
    assert.equal(badUuid.code, 1);
    assert.match(badUuid.err, /--uuid/);
  });

  const obfuscation = JSON.stringify(['MyHomePage', 'aB', 'checkout', 'cD']);
  writeFileSync(join(native, 'obfuscation.json'), obfuscation); // next to the symbols directory
  const dart = await run([CLI, 'dart-symbols', 'upload', join(native, 'symbols'), '--app', '9', '--release', '1.0.0+1'], env);
  await check('dart-symbols upload: obfuscation.json next to the symbols is found and sent once per build ID', () => {
    const u = native_().filter((x) => x.kind === 'dart-obfuscation-map').sort((a, b) => a.debugId.localeCompare(b.debugId));
    assert.deepEqual(u.map((x) => [x.name, x.debugId, x.release]), [
      ['obfuscation.json', '99887766554433221100ffeeddccbbaa', '1.0.0+1'],
      ['obfuscation.json', 'aabbccddeeff00112233445566778899', '1.0.0+1'],
    ]);
    assert.equal(gunzipSync(u[0].data).toString(), obfuscation);
    assert.equal(u[0].url, '/api/v1/applications/9/artifacts');
  });

  // One build, two symbol files with the same build ID; the map given explicitly, elsewhere.
  const oneBuild = join(native, 'one-build');
  mkdirSync(join(oneBuild, 'symbols'), { recursive: true });
  writeFileSync(join(oneBuild, 'symbols/app.android-arm64.symbols'), elf({ bits: 64, little: true, buildId: '0f'.repeat(16), viaSection: true, machine: 183 }));
  writeFileSync(join(oneBuild, 'symbols/app.android-arm64.copy.symbols'), elf({ bits: 64, little: true, buildId: '0f'.repeat(16), viaSection: true, machine: 183 }));
  writeFileSync(join(native, 'Build/release.obfuscation.json'), obfuscation);
  const explicit = await run([CLI, 'dart-symbols', 'upload', join(oneBuild, 'symbols'), '--app', '9', '--obfuscation-map', join(native, 'Build/release.obfuscation.json')], { ...env, ZHARP_AUTH_TOKEN: 'obf-token' });
  await check('dart-symbols upload --obfuscation-map: one map upload for a build ID shared by several files', () => {
    assert.equal(explicit.code, 0, explicit.err);
    const u = uploads.filter((x) => x.token === 'obf-token' && x.kind === 'dart-obfuscation-map');
    assert.deepEqual(u.map((x) => [x.name, x.debugId]), [['release.obfuscation.json', '0f'.repeat(16)]]);
  });

  writeFileSync(join(oneBuild, 'bad.json'), '{"not": "a map"}');
  const bad = await run([CLI, 'dart-symbols', 'upload', join(oneBuild, 'symbols'), '--app', '9', '--obfuscation-map', join(oneBuild, 'bad.json')], { ...env, ZHARP_AUTH_TOKEN: 'bad-map-token' });
  await check('dart-symbols upload with a map that is not a JSON array: exit 1, nothing sent', () => {
    assert.equal(bad.code, 1);
    assert.match(bad.err, /not a Dart obfuscation map/);
    assert.equal(uploads.filter((x) => x.token === 'bad-map-token').length, 0);
  });
  await check('dart-symbols upload: one per symbol file, debug ID = ELF build ID, arch from the file name', () => {
    assert.equal(dart.code, 0, dart.err);
    const u = native_().filter((x) => x.kind === 'dart-symbols').sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(u.map((x) => [x.name, x.debugId, x.arch, x.release]), [
      ['app.android-arm64.symbols', 'aabbccddeeff00112233445566778899', 'arm64', '1.0.0+1'],
      ['app.android-x64.symbols', '99887766554433221100ffeeddccbbaa', 'x64', '1.0.0+1'],
    ]);
    assert.deepEqual(gunzipSync(u[0].data), dartArm64);
  });

  const dsym = await run([CLI, 'dsym', 'upload', join(native, 'Build'), '--app', '9'], env);
  await check('dsym upload: a folder of dSYMs, one upload per architecture slice, keyed by its UUID', () => {
    assert.equal(dsym.code, 0, dsym.err);
    const u = native_().filter((x) => x.kind === 'dsym').sort((a, b) => a.arch.localeCompare(b.arch));
    assert.deepEqual(u.map((x) => [x.name, x.arch, x.debugId]), [
      ['Runner', 'arm64', '00112233-4455-6677-8899-AABBCCDDEEFF'],
      ['Runner', 'x86_64', 'FFEEDDCC-BBAA-9988-7766-554433221100'],
    ]);
    assert.deepEqual(gunzipSync(u[0].data), arm64, 'the arm64 slice on its own');
  });
}

// ── bundler plugins ──────────────────────────────────────────────────────────

console.log('\nbundler plugins');

await check('esbuild plugin: maps emitted, injected, uploaded, then deleted (and no sourceMappingURL left)', async () => {
  const outdir = join(tmp, 'esbuild-plugin');
  await esbuild.build({
    entryPoints: [join(fixtures, 'src/app.js')],
    bundle: true,
    minify: true,
    format: 'esm',
    outdir,
    logLevel: 'silent',
    plugins: [zharpEsbuildPlugin({ app: 5, authToken: 'esbuild-token', url, release: 'r1', silent: true })],
  });
  assert.deepEqual(readdirSync(outdir), ['app.js']);
  const code = read(join(outdir, 'app.js'));
  assert.ok(!code.includes('sourceMappingURL'));
  const sent = uploads.filter((u) => u.token === 'esbuild-token');
  assert.deepEqual(sent.map((u) => u.kind).sort(), ['minified-source', 'sourcemap']);
  assert.ok(sent.every((u) => u.debugId === debugIdOf(join(outdir, 'app.js')) && u.release === 'r1'));
  assert.equal(JSON.parse(sent.find((u) => u.kind === 'sourcemap').data).debugId, debugIdOf(join(outdir, 'app.js')));
});

await check('esbuild plugin dryRun: injects, keeps the maps, sends nothing', async () => {
  const outdir = join(tmp, 'esbuild-dry');
  const before = uploads.length;
  await esbuild.build({ entryPoints: [join(fixtures, 'src/app.js')], bundle: true, outdir, logLevel: 'silent', plugins: [zharpEsbuildPlugin({ dryRun: true, silent: true })] });
  assert.deepEqual(readdirSync(outdir).sort(), ['app.js', 'app.js.map']);
  assert.equal(JSON.parse(read(join(outdir, 'app.js.map'))).debugId, debugIdOf(join(outdir, 'app.js')));
  assert.equal(uploads.length, before);
});

await check('Rollup plugin: hidden maps, injected, uploaded, deleted', async () => {
  const dir = join(tmp, 'rollup-plugin');
  const build = await rollup({ input: join(fixtures, 'src/app.js'), plugins: [zharpRollupPlugin({ app: 6, authToken: 'rollup-token', url, silent: true })] });
  await build.write({ dir, format: 'es' });
  await build.close();
  assert.deepEqual(readdirSync(dir), ['app.js']);
  const sent = uploads.filter((u) => u.token === 'rollup-token');
  assert.equal(sent.length, 2);
  assert.ok(sent.every((u) => u.debugId === debugIdOf(join(dir, 'app.js'))));
});

await check('Rollup plugin without credentials: injects, warns, still deletes the maps', async () => {
  const dir = join(tmp, 'rollup-nocreds');
  const warnings = [];
  const warn = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    const build = await rollup({ input: join(fixtures, 'src/app.js'), plugins: [zharpRollupPlugin({ silent: true })] });
    await build.write({ dir, format: 'es' });
  } finally {
    console.warn = warn;
  }
  assert.ok(debugIdOf(join(dir, 'app.js')));
  assert.deepEqual(readdirSync(dir), ['app.js']);
  assert.ok(warnings.some((w) => /not uploaded.*ZHARP_AUTH_TOKEN/s.test(w)), warnings.join('\n'));
});

await check('Vite plugin: hidden source maps on production builds only', () => {
  const plugin = zharpVite({});
  assert.deepEqual(plugin.config({}, { mode: 'production', command: 'build' }), { build: { sourcemap: 'hidden' } });
  assert.equal(plugin.config({ build: { sourcemap: true } }, { mode: 'production', command: 'build' }), null);
  assert.equal(plugin.config({}, { mode: 'development', command: 'build' }), null);
  assert.equal(plugin.apply, 'build');
});

await check('webpack plugin: an unset devtool becomes hidden-source-map in production; development is left alone', () => {
  const compiler = (mode, devtool) => ({ options: { mode, devtool }, hooks: { afterEmit: { tapPromise: () => {} } } });
  const prod = compiler('production', undefined);
  new ZharpWebpackPlugin({}).apply(prod);
  assert.equal(prod.options.devtool, 'hidden-source-map');
  const kept = compiler(undefined, 'source-map');
  new ZharpWebpackPlugin({}).apply(kept);
  assert.equal(kept.options.devtool, 'source-map');
  const dev = compiler('development', 'eval');
  new ZharpWebpackPlugin({}).apply(dev);
  assert.equal(dev.options.devtool, 'eval');
});

await check('withZharp: object and function configs; runAfterProductionCompile chains the app\'s own; webpack fallback adds the plugin', async () => {
  const calls = [];
  const config = withZharp(
    { reactStrictMode: true, compiler: { runAfterProductionCompile: async () => calls.push('own') } },
    { hook: 'runAfterProductionCompile', dryRun: true, silent: true },
  );
  assert.equal(config.reactStrictMode, true);
  assert.equal(config.productionBrowserSourceMaps, true);
  assert.equal(config.experimental.serverSourceMaps, true);
  const distDir = join(tmp, 'next-dist');
  cpSync(await bundle('next-static'), join(distDir, 'static/chunks'), { recursive: true });
  await config.compiler.runAfterProductionCompile({ distDir, projectDir: tmp });
  assert.deepEqual(calls, ['own']);
  assert.ok(debugIdOf(join(distDir, 'static/chunks/app.js')));

  const fn = withZharp(async () => ({ webpack: (c) => ({ ...c, touched: true }) }), { hook: 'webpack' });
  const resolved = await fn('phase-production-build', { defaultConfig: {} });
  const out = resolved.webpack({ plugins: [] }, { dev: false, isServer: true });
  assert.equal(out.touched, true);
  assert.equal(out.devtool, 'hidden-source-map');
  assert.ok(out.plugins[0] instanceof ZharpWebpackPlugin);
  const dev = resolved.webpack({ plugins: [] }, { dev: true, isServer: false });
  assert.equal(dev.plugins.length, 0);
});

// ── the SDKs ─────────────────────────────────────────────────────────────────

console.log('\nSDKs: zharp.debug_ids on errors');

const attrs = (list = []) => Object.fromEntries(list.map(({ key, value }) => [key, Object.values(value)[0]]));
{
  const dir = await bundle('browser-bundle');
  cli.injectDirectory(dir, { logger: silent });
  const appId = debugIdOf(join(dir, 'app.js'));
  const r = await run([join(fixtures, 'browser-debug-ids.mjs')], { BUNDLE_DIR: dir });
  const logs = otlp
    .filter((x) => x.key === 'debug-ids-browser' && x.path.endsWith('/v1/logs'))
    .flatMap((x) => x.body.resourceLogs.flatMap((rl) => rl.scopeLogs.flatMap((sl) => sl.logRecords.map((l) => attrs(l.attributes)))));

  await check('@zharp/browser: captureError, log.error with an error, and an uncaught error carry the bundle\'s ID, keyed by its URL', () => {
    assert.ok(r.result, r.err);
    assert.match(r.result.stack, /http:\/\/localhost:5173\/assets\/app\.js:\d+:\d+/);
    const fromBundle = logs.filter((l) => /assets\/app\.js/.test(l['exception.stacktrace'] ?? ''));
    assert.equal(fromBundle.length, 3, JSON.stringify(logs, null, 1));
    for (const l of fromBundle) assert.deepEqual(JSON.parse(l['zharp.debug_ids']), { 'http://localhost:5173/assets/app.js': appId });
  });

  await check('@zharp/browser: a registered file not in the stack is left out; an error with no bundle frames has no attribute', () => {
    assert.equal(r.result.registered.length, 2);
    const plain = logs.find((l) => l['exception.message'] === 'not from a bundle');
    assert.ok(plain);
    assert.equal(plain['zharp.debug_ids'], undefined);
  });
}
{
  const dir = await bundle('node-bundle', { format: 'cjs', platform: 'node', globalName: undefined, entryPoints: [join(fixtures, 'src/app.js')] });
  cli.injectDirectory(dir, { logger: silent });
  const file = join(dir, 'app.js');
  const appId = debugIdOf(file);
  const r = await run([join(fixtures, 'node-debug-ids.cjs')], { BUNDLE: file });
  const text = (path) => otlp.filter((x) => x.key === 'debug-ids-node' && x.path.endsWith(path)).map((x) => x.text).join('\n');
  const expected = JSON.stringify({ [file]: appId });

  await check('@zharp/node: captureError and log.error carry the server bundle\'s ID, keyed by its path', () => {
    assert.ok(r.result, r.err + r.out);
    assert.ok(r.result.stack.includes(file));
    const logs = text('/v1/logs');
    assert.equal(logs.split(expected).length - 1, 2, `expected ${expected} twice in the logs`);
  });

  await check('@zharp/node: an exception recorded on a span carries it too', () => {
    const spans = text('/v1/traces');
    assert.ok(spans.includes('zharp.debug_ids'), 'attribute on the exception event');
    assert.ok(spans.includes(expected));
  });
}

server.close();
rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed, ${passed} passed` : `\nAll ${passed} checks passed`);
process.exitCode = failures ? 1 : 0;
