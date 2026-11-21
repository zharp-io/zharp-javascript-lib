/**
 * `zharp init` on NestJS: with ES modules (newer `nest new` projects) the start scripts preload
 * Zharp, since a first import is too late; with CommonJS, main.ts imports it first.
 *
 *     node test/init-nest.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'cli');
const tmp = mkdtempSync(join(pkg, '.test-'));
for (const name of ['recipes', 'detect']) {
  await esbuild.build({ entryPoints: [join(pkg, 'src', 'init', `${name}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile: join(tmp, `${name}.mjs`), logLevel: 'silent' });
}
const recipes = await import(pathToFileURL(join(tmp, 'recipes.mjs')).href);
const { detect } = await import(pathToFileURL(join(tmp, 'detect.mjs')).href);
const connected = { application: { id: 42, name: 'api', serviceName: 'api', ingestKey: 'zpk_x' }, workspace: { id: 3, name: 'W' }, uploadKey: 'zh_up', appUrl: 'u' };
const NL = '\n';

// ES modules
const esm = join(tmp, 'nest-esm');
mkdirSync(join(esm, 'src'), { recursive: true });
const scripts = { start: 'nest start', 'start:dev': 'nest start --watch', 'start:prod': 'node dist/main', test: 'jest' };
// Hand-formatted, the way generators write it: an inline array that re-serializing would expand.
const pkgText = [
  '{',
  '  "name": "api",',
  '  "type": "module",',
  '  "scripts": {',
  ...Object.entries(scripts).map(([k, v], i, all) => `    "${k}": ${JSON.stringify(v)}${i < all.length - 1 ? ',' : ''}`),
  '  },',
  '  "dependencies": { "@nestjs/core": "11" },',
  '  "devDependencies": { "typescript": "5" },',
  '  "jest": { "moduleFileExtensions": ["js", "json", "ts"] }',
  '}',
  '',
].join(NL);
writeFileSync(join(esm, 'package.json'), pkgText);
writeFileSync(join(esm, 'src', 'main.ts'), ["import { NestFactory } from '@nestjs/core';", "import { AppModule } from './app.module.js';", ''].join(NL));
const plan = recipes.planFor(detect(esm), connected, 'https://api.zharp.io');
const pkgOut = plan.changes.find((c) => c.path === 'package.json').content;
const next = JSON.parse(pkgOut).scripts;
assert.ok(pkgOut.includes('"jest": { "moduleFileExtensions": ["js", "json", "ts"] }'), 'the rest of package.json keeps its formatting');
assert.equal(pkgOut.split(NL).length, pkgText.split(NL).length, 'no lines added or removed');
assert.equal(next.start, 'nest start --exec "node --import ./dist/instrument.js"');
assert.equal(next['start:dev'], 'nest start --watch --exec "node --import ./dist/instrument.js"');
assert.equal(next['start:prod'], 'node --import ./dist/instrument.js dist/main');
assert.equal(next.test, 'jest');
assert.ok(!plan.changes.some((c) => c.path === 'src/main.ts'), 'main.ts left alone');
assert.ok(plan.changes.some((c) => c.path === 'src/instrument.ts'));

// CommonJS
const cjs = join(tmp, 'nest-cjs');
mkdirSync(join(cjs, 'src'), { recursive: true });
writeFileSync(join(cjs, 'package.json'), JSON.stringify({ name: 'api', dependencies: { '@nestjs/core': '10' }, devDependencies: { typescript: '5' } }));
writeFileSync(join(cjs, 'src', 'main.ts'), "import { NestFactory } from '@nestjs/core';" + NL);
const cjsPlan = recipes.planFor(detect(cjs), connected, 'https://api.zharp.io');
assert.ok(cjsPlan.changes.find((c) => c.path === 'src/main.ts').content.startsWith("import './instrument';" + NL));

rmSync(tmp, { recursive: true, force: true });
console.log('  ✓ NestJS: ES modules preload from the start scripts; CommonJS imports first\n\n1 passed');
