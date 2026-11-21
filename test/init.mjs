/**
 * `zharp init`: what it finds, and the edits it makes — only to files of the common shape, never
 * a guess. Bundled from source with esbuild.
 *
 *     node test/init.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'cli');
const tmp = mkdtempSync(join(pkg, '.test-'));
await esbuild.build({ entryPoints: [join(pkg, 'src', 'init', 'index.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(tmp, 'init.mjs'), logLevel: 'silent' });
await esbuild.build({ entryPoints: [join(pkg, 'src', 'init', 'recipes.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(tmp, 'recipes.mjs'), logLevel: 'silent' });
await esbuild.build({ entryPoints: [join(pkg, 'src', 'init', 'detect.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(tmp, 'detect.mjs'), logLevel: 'silent' });
const init = await import(pathToFileURL(join(tmp, 'init.mjs')).href);
const recipes = await import(pathToFileURL(join(tmp, 'recipes.mjs')).href);
const { detect } = await import(pathToFileURL(join(tmp, 'detect.mjs')).href);

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

const connected = { application: { id: 42, name: 'shop', serviceName: 'shop', ingestKey: 'zpk_x' }, workspace: { id: 3, name: 'W' }, uploadKey: 'zh_up', appUrl: 'https://zharp.io/dashboard/applications/42' };

console.log('\nzharp init');

await test('finds the framework, its package manager and the Next.js app directory', () => {
  const dir = join(tmp, 'next-app');
  mkdirSync(join(dir, 'src', 'app'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/shop', dependencies: { next: '^16.1.0', react: '19' }, devDependencies: { typescript: '5' } }));
  writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
  const p = detect(dir);
  assert.deepEqual([p.framework, p.label, p.name, p.packageManager, p.appDir, p.typescript], ['nextjs', 'Next.js 16', 'shop', 'pnpm', 'src/app', true]);
  const vite = join(tmp, 'vite-app');
  mkdirSync(vite);
  writeFileSync(join(vite, 'package.json'), JSON.stringify({ dependencies: { react: '19' }, devDependencies: { vite: '7' } }));
  assert.equal(detect(vite).framework, 'vite-react');
  const py = join(tmp, 'py');
  mkdirSync(py);
  writeFileSync(join(py, 'requirements.txt'), 'Django==5.1\n');
  assert.equal(detect(py).framework, 'django');
});

await test('next.config: a plain export is wrapped; anything else is left for a snippet', () => {
  const esm = "/** @type {import('next').NextConfig} */\nconst nextConfig = { reactStrictMode: true };\n\nexport default nextConfig;\n";
  const out = recipes.wrapNextConfig(esm, 42, true);
  assert.match(out, /^import \{ withZharp \} from '@zharp\/nextjs';/);
  assert.match(out, /export default withZharp\(nextConfig, \{ app: 42 \}\);\n$/);
  assert.ok(out.includes('reactStrictMode: true'));
  const cjs = "module.exports = { output: 'standalone' };\n";
  assert.match(recipes.wrapNextConfig(cjs, 7, false), /module\.exports = withZharp\(\{ output: 'standalone' \}, \{ app: 7 \}\);/);
  assert.equal(recipes.wrapNextConfig("import { withZharp } from '@zharp/nextjs';\nexport default withZharp({});", 1, true), null);
  assert.equal(recipes.wrapNextConfig('const x = 1;', 1, true), null);
});

await test('the root layout renders <ZharpClient /> first in <body>, imported after the other imports', () => {
  const layout = "import './globals.css';\nimport type { Metadata } from 'next';\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang=\"en\">\n      <body className={inter.className}>{children}</body>\n    </html>\n  );\n}\n";
  const out = recipes.addToLayout(layout, './zharp-client');
  assert.match(out, /import type \{ Metadata \} from 'next';\nimport \{ ZharpClient \} from '.\/zharp-client';/);
  assert.match(out, /<body className=\{inter\.className\}>\n {8}<ZharpClient \/>\n {8}\{children\}<\/body>/);
  assert.equal(recipes.addToLayout(out, './zharp-client'), null, 'twice: no');
  assert.equal(recipes.addToLayout('export default function L() { return children; }', './x'), null);
});

await test('vite.config: the plugin goes at the end of plugins, nested calls and all', () => {
  const config = "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({\n  plugins: [react({ babel: { plugins: [] } })],\n  server: { port: 3000 },\n});\n";
  const out = recipes.addVitePlugin(config, 42);
  assert.match(out, /plugins: \[react\(\{ babel: \{ plugins: \[\] \} \}\), zharp\(\{ app: 42 \}\)\],/);
  assert.match(out, /import react from '@vitejs\/plugin-react';\nimport \{ zharp \} from '@zharp\/vite-plugin';/);
  assert.match(recipes.addVitePlugin("export default { plugins: [] }", 1), /plugins: \[zharp\(\{ app: 1 \}\)\]/);
  assert.equal(recipes.addVitePlugin('export default {}', 1), null);
});

await test('main.tsx: Zharp starts before React, and createRoot gets the error handlers', () => {
  const main = "import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.tsx';\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode><App /></StrictMode>,\n);\n";
  const out = recipes.addToViteMain(main, 'shop', false);
  assert.match(out, /import App from '.\/App.tsx';\nimport \{ Zharp \} from '@zharp\/browser';\n\nZharp\.init\(\{ key: import\.meta\.env\.VITE_ZHARP_KEY, service: 'shop' \}\);/);
  assert.match(out, /createRoot\(document\.getElementById\('root'\)!, \{\n {2}onUncaughtError: Zharp\.reactErrorHandler\(\),\n {2}onCaughtError: Zharp\.reactErrorHandler\(\),\n\}\)\.render/);
  const withOptions = "createRoot(el, { identifierPrefix: 'x' }).render(<App />);";
  assert.ok(!recipes.addToViteMain(withOptions, 's', false).includes('onUncaughtError'), 'its own options: left alone');
});

await test('the whole Next.js plan: new files, the edits, the keys, nothing outside the project', () => {
  const dir = join(tmp, 'next-plan');
  mkdirSync(join(dir, 'app'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'shop', dependencies: { next: '16' }, devDependencies: { typescript: '5' } }));
  writeFileSync(join(dir, 'next.config.ts'), "import type { NextConfig } from 'next';\nconst nextConfig: NextConfig = {};\nexport default nextConfig;\n");
  writeFileSync(join(dir, 'app', 'layout.tsx'), 'export default function L({ children }) { return <html><body>{children}</body></html>; }\n');
  const plan = recipes.planFor(detect(dir), connected, 'https://api.zharp.io');
  assert.deepEqual(plan.changes.map((c) => `${c.kind} ${c.path}`), ['create instrumentation.ts', 'edit next.config.ts', 'create app/zharp-client.tsx', 'edit app/layout.tsx']);
  assert.deepEqual(plan.env, { file: '.env.local', vars: { NEXT_PUBLIC_ZHARP_KEY: 'zpk_x', ZHARP_KEY: 'zpk_x', ZHARP_AUTH_TOKEN: 'zh_up' } });
  assert.deepEqual(plan.manual, []);
  const local = recipes.planFor(detect(dir), connected, 'http://localhost:3000');
  assert.equal(local.env.vars.NEXT_PUBLIC_ZHARP_ENDPOINT, 'http://localhost:3000/api/v1/otlp', 'a non-default API is said');
});

await test('env files: ours replaced or added, everything else kept', () => {
  assert.equal(init.mergeEnv('DATABASE_URL=x\nZHARP_KEY=old\n', { ZHARP_KEY: 'new', ZHARP_AUTH_TOKEN: 't' }), 'DATABASE_URL=x\nZHARP_KEY=new\n\n# Zharp (npx zharp init)\nZHARP_AUTH_TOKEN=t\n');
  assert.equal(init.mergeEnv('', { A: '1' }), '# Zharp (npx zharp init)\nA=1\n');
});

await test('keys never land in git: the env file is checked against .gitignore', () => {
  assert.equal(init.ignoredByGit('node_modules\n.env*.local\n', '.env.local'), true);
  assert.equal(init.ignoredByGit('.env*\n', '.env'), true);
  assert.equal(init.ignoredByGit('node_modules\n', '.env'), false);
  assert.equal(init.ignoredByGit('.env.*\n', '.env'), false, '.env.* does not cover .env');
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
