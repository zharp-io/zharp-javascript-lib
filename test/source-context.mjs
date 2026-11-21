/**
 * @zharp/node: the code that ran goes with each error — read on the server, and for built
 * TypeScript through the build's own map, so the stack and the code are the sources.
 *
 *     node test/source-context.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'node');
const tmp = mkdtempSync(join(pkg, '.test-'));

const bundle = join(tmp, 'source.mjs');
await esbuild.build({
  entryPoints: [join(pkg, 'src', 'source.ts')], bundle: true, platform: 'node', format: 'esm',
  outfile: bundle, external: ['@opentelemetry/*'], logLevel: 'silent',
});
const source = await import(pathToFileURL(bundle).href);

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

console.log('\nthe code that ran');

await test('built TypeScript is read through its map: the stack and the code are the source', async () => {
  const project = join(tmp, 'app');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'users.service.ts'), [
    'export class UsersService {',
    '  create(email: string): number {',
    '    const clean: string = email.trim();',
    '    if (!clean) throw new Error("empty");',
    '    throw new Error("taken: " + clean);',
    '  }',
    '}',
  ].join('\n'));
  await esbuild.build({
    entryPoints: [join(project, 'src', 'users.service.ts')],
    outfile: join(project, 'dist', 'users.service.js'),
    format: 'cjs', platform: 'node', sourcemap: true, logLevel: 'silent',
  });
  const { UsersService } = createRequire(import.meta.url)(join(project, 'dist', 'users.service.js'));
  let stack = '';
  try {
    new UsersService().create('ada@example.com');
  } catch (error) {
    stack = error.stack;
  }
  assert.ok(stack.includes('users.service.js:'), 'Node itself reports the built file');
  const out = source.sourced(stack);
  assert.ok(out.stack.includes('users.service.ts:5:'), out.stack);
  const sent = JSON.parse(out.context);
  assert.ok(sent[0].file.endsWith('users.service.ts'), sent[0].file);
  assert.equal(sent[0].line, 5);
  assert.equal(sent[0].code.trim(), 'throw new Error("taken: " + clean);');
  assert.ok(sent[0].pre.some((l) => l.includes('const clean: string')));
});

await test('plain JavaScript is read as it is; never node_modules; nothing when off', async () => {
  const me = fileURLToPath(import.meta.url);
  const stack = `${new Error('x').stack}\n    at lib (${join(tmp, 'node_modules', 'x', 'index.js')}:1:1)`;
  const sent = JSON.parse(source.sourced(stack).context);
  assert.equal(sent[0].file, pathToFileURL(me).href, 'as the stack writes it, so the server matches it');
  assert.ok(sent.every((f) => !f.file.includes('node_modules')));
  source.setSourceContext(false);
  assert.equal(source.sourced(stack).context, null);
  source.setSourceContext(true);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
