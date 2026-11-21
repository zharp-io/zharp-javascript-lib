/**
 * Readable Swift names for `zharp dsym upload`, with Xcode's tools stood in for.
 *
 *     node test/swift-names.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'cli');
const tmp = mkdtempSync(join(pkg, '.test-'));
try {
  await esbuild.build({ entryPoints: [join(pkg, 'src', 'swift-names.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(tmp, 'sn.mjs'), logLevel: 'silent' });
  const { swiftNames } = await import(pathToFileURL(join(tmp, 'sn.mjs')).href);

  const calls = [];
  const reads = [];
  // A DWARF file's bytes: the symbol table's "_$s…", the debug strings' "$s…" (an inlined
  // function is only there), among other bytes.
  const read = (file) => {
    reads.push(file);
    return Buffer.concat([
      Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0]),
      Buffer.from('_main\0_$s9CrashTest0aB3AppVACycfcyyScMYccfU0_\0_OBJC_CLASS_$_Foo\0'),
      Buffer.from([1, 2, 0]),
      Buffer.from('$s9CrashTest4CartV5totalSiyF\0$s9CrashTest0aB3AppVACycfcyyScMYccfU0_\0'),
    ]);
  };
  const tool = (name, args, input) => {
    calls.push([name, args, input]);
    if (name === 'swift-demangle') return input.trim().split('\n').map((n) => ({
      '$s9CrashTest4CartV5totalSiyF': 'Cart.total() -> Int',
      '$s9CrashTest0aB3AppVACycfcyyScMYccfU0_': 'closure #1 in CrashTestApp.init()',
    })[n] ?? n).join('\n') + '\n';
    return null;
  };

  const names = swiftNames(['/x/DWARF/CrashTest', '/x/DWARF/CrashTest'], tool, read);
  assert.deepEqual(names, {
    '$s9CrashTest4CartV5totalSiyF': 'Cart.total() -> Int',
    '$s9CrashTest0aB3AppVACycfcyyScMYccfU0_': 'closure #1 in CrashTestApp.init()',
  });
  assert.equal(reads.length, 1, 'each DWARF file read once (one file per architecture slice)');
  assert.equal(calls.length, 1, 'one swift-demangle call for every name');
  assert.deepEqual(calls.find(([n]) => n === 'swift-demangle')[1], ['--simplified', '--compact']);

  assert.equal(swiftNames(['/x'], () => null, read), null, 'no Xcode: nothing, and the upload carries on');
  assert.equal(swiftNames(['/x'], null), null, 'not a Mac');
  console.log('swift names: 3 passed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
