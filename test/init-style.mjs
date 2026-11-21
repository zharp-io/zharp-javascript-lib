/**
 * `zharp init`: lines it adds follow the file's style — no semicolons where the file has none.
 *
 *     node test/init-style.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'cli');
const tmp = mkdtempSync(join(pkg, '.test-'));
await esbuild.build({ entryPoints: [join(pkg, 'src', 'init', 'recipes.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(tmp, 'recipes.mjs'), logLevel: 'silent' });
const recipes = await import(pathToFileURL(join(tmp, 'recipes.mjs')).href);

const NL = '\n';
const bareConfig = ["import react from '@vitejs/plugin-react'", "import { defineConfig } from 'vite'", '', 'export default defineConfig({', '  plugins: [react()],', '})', ''].join(NL);
const config = recipes.addVitePlugin(bareConfig, 1);
assert.ok(config.includes("import { zharp } from '@zharp/vite-plugin'" + NL), config);
assert.ok(!config.includes("vite-plugin';"), 'no semicolon added');

const bareMain = ["import { createRoot } from 'react-dom/client'", "import App from './App.tsx'", '', 'createRoot(el).render(<App />)', ''].join(NL);
const main = recipes.addToViteMain(bareMain, 's', false);
assert.ok(main.includes("import { Zharp } from '@zharp/browser'" + NL + NL + "Zharp.init({ key: import.meta.env.VITE_ZHARP_KEY, service: 's' })" + NL + NL + 'createRoot'), main);

const semiMain = ["import { createRoot } from 'react-dom/client';", '', 'createRoot(el).render(<App />);', ''].join(NL);
assert.ok(recipes.addToViteMain(semiMain, 's', false).includes("import { Zharp } from '@zharp/browser';"), 'semicolons where the file has them');

rmSync(tmp, { recursive: true, force: true });
console.log('  ✓ added lines follow the file\'s style\n\n1 passed');
