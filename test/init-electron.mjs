/**
 * `zharp init` for Electron: electron-vite, Electron Forge (Vite, webpack), electron-builder and
 * plain Electron apps, each as its template lays it out.
 *
 *     node test/init-electron.mjs
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
const { planFor } = await import(pathToFileURL(join(tmp, 'recipes.mjs')).href);
const { detect } = await import(pathToFileURL(join(tmp, 'detect.mjs')).href);
const c = { application: { id: 42, name: 'desk', serviceName: 'desk', ingestKey: 'zpk_abc' }, workspace: { id: 3, name: 'W' }, uploadKey: 'zh_up', appUrl: 'u' };
const API = 'https://api.zharp.io';
const NL = '\n';

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
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return detect(dir);
}
const change = (plan, path) => plan.changes.find((ch) => ch.path === path);

console.log('\nzharp init — Electron');

await test('electron-vite (React): main, the window, the key as MAIN_VITE_ZHARP_KEY; no preload edit', () => {
  const p = project('evite', {
    'package.json': JSON.stringify({ name: 'desk', main: './out/main/index.js', dependencies: { '@electron-toolkit/utils': '^4' }, devDependencies: { electron: '^45.4.1', 'electron-vite': '^4.0.0', vite: '^7', react: '^19', typescript: '^5' } }),
    'electron.vite.config.ts': "import { defineConfig } from 'electron-vite'\nexport default defineConfig({ main: {}, preload: {}, renderer: { plugins: [react()] } })\n",
    'src/main/index.ts': ["import { app, BrowserWindow } from 'electron'", "import { join } from 'path'", '', 'app.whenReady().then(() => {})', ''].join(NL),
    'src/preload/index.ts': "import { contextBridge } from 'electron'\n",
    'src/renderer/src/main.tsx': ["import './assets/main.css'", '', "import { StrictMode } from 'react'", "import { createRoot } from 'react-dom/client'", '', "createRoot(document.getElementById('root')!).render(<App />)", ''].join(NL),
  });
  assert.equal(p.framework, 'electron');
  assert.equal(p.label, 'Electron 45 (electron-vite)');
  assert.equal(p.catalog, 'Electron');
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.install, ['@zharp/electron']);
  assert.deepEqual(plan.devInstall, ['@zharp/vite-plugin']);
  // ES modules: init in a module of its own, imported before anything else.
  assert.equal(change(plan, 'src/main/zharp.ts').content, "import { Zharp } from '@zharp/electron/main'" + NL + NL + "Zharp.init({ key: import.meta.env.MAIN_VITE_ZHARP_KEY, service: 'desk' })" + NL);
  const main = change(plan, 'src/main/index.ts').content;
  assert.ok(main.startsWith("import './zharp'" + NL + "import { app, BrowserWindow } from 'electron'"), main);
  const renderer = change(plan, 'src/renderer/src/main.tsx').content;
  assert.ok(renderer.includes("import { createRoot } from 'react-dom/client'" + NL + NL + "import { Zharp } from '@zharp/electron/renderer'" + NL + NL + 'Zharp.init()' + NL), renderer);
  assert.equal(change(plan, 'src/preload/index.ts'), undefined);
  assert.deepEqual(plan.env, { file: '.env', vars: { MAIN_VITE_ZHARP_KEY: 'zpk_abc', ZHARP_AUTH_TOKEN: 'zh_up' } });
  assert.ok(plan.manual.some((m) => m.path === 'electron.vite.config.ts' && m.snippet.includes('zharp({ app: 42 })')));
});

await test('Electron Forge (Vite): main, the preload bridge, the window; VITE_ZHARP_KEY', () => {
  const p = project('forge-vite', {
    'package.json': JSON.stringify({ name: 'desk', main: '.vite/build/main.js', devDependencies: { electron: '45.4.1', '@electron-forge/cli': '^7', '@electron-forge/plugin-vite': '^7', typescript: '^5' } }),
    'src/main.ts': ["import { app, BrowserWindow } from 'electron';", "import path from 'node:path';", '', 'app.on(\'ready\', () => {});', ''].join(NL),
    'src/preload.ts': '// See the Electron documentation for details on how to use preload scripts:\n',
    'src/renderer.ts': ["import './index.css';", '', "console.log('hello');", ''].join(NL),
  });
  assert.equal(p.label, 'Electron 45 (Electron Forge (Vite))');
  const plan = planFor(p, c, API);
  assert.ok(change(plan, 'src/zharp.ts').content.includes("Zharp.init({ key: import.meta.env.VITE_ZHARP_KEY, service: 'desk' });"));
  assert.ok(change(plan, 'src/main.ts').content.startsWith("import './zharp';" + NL + "import { app"));
  assert.ok(change(plan, 'src/preload.ts').content.startsWith("import '@zharp/electron/preload';" + NL));
  assert.equal(change(plan, 'src/renderer.ts').content, ["import './index.css';", '', "import { Zharp } from '@zharp/electron/renderer';", '', 'Zharp.init();', '', "console.log('hello');", ''].join(NL));
  assert.deepEqual(plan.env.vars, { VITE_ZHARP_KEY: 'zpk_abc', ZHARP_AUTH_TOKEN: 'zh_up' });
});

await test('Electron Forge (webpack): the key written in main (bundled; no .env there)', () => {
  const p = project('forge-webpack', {
    'package.json': JSON.stringify({ name: 'desk', devDependencies: { electron: '^44.0.0', '@electron-forge/plugin-webpack': '^7' } }),
    'src/index.ts': "import { app, BrowserWindow } from 'electron';\n",
    'src/preload.ts': '',
    'src/renderer.ts': "import './index.css';\n",
  });
  const plan = planFor(p, c, API);
  assert.ok(change(plan, 'src/zharp.ts').content.includes("Zharp.init({ key: 'zpk_abc', service: 'desk' });"));
  assert.ok(change(plan, 'src/index.ts').content.startsWith("import './zharp';"));
  assert.ok(change(plan, 'src/preload.ts'));
  assert.deepEqual(plan.devInstall, ['@zharp/webpack-plugin']);
});

await test('plain Electron (CommonJS): require first in main, the script tag in index.html', () => {
  const p = project('plain', {
    'package.json': JSON.stringify({ name: 'desk', main: 'main.js', devDependencies: { electron: '^43.2.0' } }),
    'main.js': ["const { app, BrowserWindow } = require('electron')", "const path = require('node:path')", '', 'app.whenReady().then(() => {})', ''].join(NL),
    'index.html': ['<!DOCTYPE html>', '<html>', '  <head>', "    <meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; script-src 'self'\" />", '  </head>', '  <body>', '    <script src="./renderer.js"></script>', '  </body>', '</html>', ''].join(NL),
  });
  assert.equal(p.label, 'Electron 43');
  const plan = planFor(p, c, API);
  const main = change(plan, 'main.js').content;
  assert.ok(main.startsWith("const { Zharp } = require('@zharp/electron/main')" + NL + NL + "Zharp.init({ key: 'zpk_abc', service: 'desk' })" + NL + NL + "const { app, BrowserWindow }"), main);
  const html = change(plan, 'index.html').content;
  assert.ok(html.includes('    <script src="./node_modules/@zharp/electron/dist/renderer.min.js"></script>' + NL + '    <script src="./renderer.js"></script>'), html);
  assert.deepEqual(plan.env.vars, { ZHARP_AUTH_TOKEN: 'zh_up' });
});

await test('electron-builder: detected as such; a self-hosted Zharp gets its endpoint', () => {
  const p = project('builder', {
    'package.json': JSON.stringify({ name: 'desk', main: 'src/main.js', devDependencies: { electron: '^45', 'electron-builder': '^26' } }),
    'src/main.js': "import { app } from 'electron';\n",
    'src/index.html': '<html><head>\n</head><body></body></html>\n',
  });
  assert.equal(p.label, 'Electron 45 (electron-builder)');
  const plan = planFor(p, c, 'https://zharp.example.com');
  assert.ok(change(plan, 'src/zharp.js').content.includes("endpoint: 'https://zharp.example.com/api/v1/otlp'"));
  assert.ok(change(plan, 'src/index.html').content.includes('<script src="../node_modules/@zharp/electron/dist/renderer.min.js"></script>'));
});

await test('an app already set up is left alone', () => {
  const p = project('done', {
    'package.json': JSON.stringify({ name: 'desk', main: 'main.js', devDependencies: { electron: '^45' } }),
    'main.js': "const { Zharp } = require('@zharp/electron/main');\n",
    'index.html': '<script src="./node_modules/@zharp/electron/dist/renderer.min.js"></script>\n',
  });
  const plan = planFor(p, c, API);
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.manual.length, 0);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
