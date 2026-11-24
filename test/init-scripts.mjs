/**
 * `zharp init` in a folder of scripts: PowerShell (*.ps1) and shell (*.sh).
 *
 *     node test/init-scripts.mjs
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
const { planFor, GUIDES } = await import(pathToFileURL(join(tmp, 'recipes.mjs')).href);
const { detect } = await import(pathToFileURL(join(tmp, 'detect.mjs')).href);
const c = { application: { id: 42, name: 'jobs', serviceName: 'jobs', ingestKey: 'zpk_abc' }, workspace: { id: 3, name: 'W' }, uploadKey: 'zh_up', appUrl: 'u' };
const API = 'https://api.zharp.io';

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
function project(name, files) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return detect(dir);
}

console.log('\nzharp init — scripts');

await test('PowerShell scripts: PowerShell tile, the module installed, the Invoke-Zharp lines for the entry script', () => {
  const p = project('ps', { 'backup.ps1': 'Copy-Item a b\n', 'lib/helpers.ps1': '' , 'scripts/rotate.ps1': '' });
  assert.equal(p.framework, 'powershell');
  assert.equal(p.platform, 'powershell');
  assert.equal(p.catalog, 'PowerShell');
  assert.equal(p.entry, 'backup.ps1');
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.changes, []);
  assert.equal(plan.env.file, '');
  assert.match(plan.commands[0].argv.join(' '), /Install-Module Zharp -Scope CurrentUser/);
  assert.equal(plan.manual[0].path, 'backup.ps1');
  assert.match(plan.manual[0].snippet, /Start-Zharp -Service 'jobs'\n\nInvoke-Zharp \{/);
  assert.ok(plan.notes[0].includes('ZHARP_KEY=zpk_abc'));
  assert.equal(GUIDES.powershell, 'https://zharp.io/docs/sdks/powershell');
});

await test('Shell scripts: CLI (Shell) tile, install and source lines, an entry named like one', () => {
  const p = project('sh', { 'util.sh': '', 'deploy.sh': '#!/bin/bash\n', 'bin/run.sh': '' });
  assert.equal(p.framework, 'shell');
  assert.equal(p.catalog, 'CLI (Shell)');
  assert.equal(p.entry, 'deploy.sh');
  const plan = planFor(p, c, 'http://localhost:3000');
  assert.match(plan.manual[0].snippet, /zharp\.io\/zharp\.sh/);
  assert.match(plan.manual[1].snippet, /^source \/usr\/local\/lib\/zharp\.sh/);
  assert.match(plan.manual[1].snippet, /zharp run --service jobs -- \.\/deploy\.sh/);
  assert.ok(plan.notes[0].includes('ZHARP_ENDPOINT=http://localhost:3000/api/v1/otlp'));
});

await test('More of one kind decides; scripts never win over a real project', () => {
  assert.equal(project('mixed', { 'a.sh': '', 'b.sh': '', 'c.ps1': '' }).framework, 'shell');
  assert.equal(project('node-with-scripts', { 'package.json': '{"name":"tool"}', 'deploy.sh': '' }).framework, 'node');
  assert.equal(project('go-with-scripts', { 'go.mod': 'module example.com/x\n', 'build.sh': '' }).framework, 'go');
  assert.equal(project('nothing', { 'README.md': '' }).framework, 'unknown');
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
