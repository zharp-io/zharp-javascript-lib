/**
 * Cloudflare in the CLI: `zharp init` for Workers (Hono included) and Pages Functions, and
 * `zharp sourcemaps upload --release` for builds without debug IDs (what Wrangler deploys).
 *
 *     node test/init-cloudflare.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'cli');
const tmp = mkdtempSync(join(pkg, '.test-'));
for (const [name, entry] of [['recipes', 'init/recipes'], ['cloudflare', 'init/recipes-cloudflare'], ['detect', 'init/detect'], ['sourcemaps', 'sourcemaps']]) {
  await esbuild.build({ entryPoints: [join(pkg, 'src', `${entry}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile: join(tmp, `${name}.mjs`), logLevel: 'silent' });
}
const { planFor } = await import(pathToFileURL(join(tmp, 'recipes.mjs')).href);
const cf = await import(pathToFileURL(join(tmp, 'cloudflare.mjs')).href);
const { detect } = await import(pathToFileURL(join(tmp, 'detect.mjs')).href);
const { uploadSourcemaps, contentDebugId } = await import(pathToFileURL(join(tmp, 'sourcemaps.mjs')).href);
const c = { application: { id: 42, name: 'shop', serviceName: 'shop-worker', ingestKey: 'zpk_abc' }, workspace: { id: 3, name: 'W' }, uploadKey: 'zh_up', appUrl: 'u' };
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
const silent = { info() {}, warn() {} };

console.log('\nzharp init — Cloudflare');

const C3_ENTRY = [
  '/**',
  ' * Welcome to Cloudflare Workers!',
  ' */',
  '',
  'export default {',
  '\tasync fetch(request, env, ctx): Promise<Response> {',
  "\t\treturn new Response('Hello World! {');",
  '\t},',
  '} satisfies ExportedHandler<Env>;',
  '',
].join(NL);

await test('Workers (wrangler.jsonc): entry wrapped, config edited, deploy uploads source maps, key in .dev.vars', () => {
  const config = ['{', '\t"$schema": "node_modules/wrangler/config-schema.json",', '\t"name": "shop-worker",', '\t"main": "src/index.ts",', '\t"compatibility_date": "2025-09-27",', '\t"observability": { "enabled": true }', '}', ''].join(NL);
  const p = project('worker-jsonc', {
    'package.json': JSON.stringify({ name: 'shop-worker', scripts: { deploy: 'wrangler deploy', dev: 'wrangler dev' }, devDependencies: { wrangler: '^4.40.0', typescript: '^5' } }, null, '\t'),
    'wrangler.jsonc': config,
    'src/index.ts': C3_ENTRY,
  });
  assert.equal(p.framework, 'cloudflare-workers');
  assert.equal(p.platform, 'cloudflare');
  assert.equal(p.catalog, 'Cloudflare Workers');
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.install, ['@zharp/cloudflare']);
  assert.deepEqual(plan.devInstall, ['@zharp/cli']);

  const entry = change(plan, 'src/index.ts').content;
  assert.ok(entry.startsWith("import { withZharp } from '@zharp/cloudflare';" + NL + NL + '/**'), entry);
  assert.ok(entry.includes('export default withZharp({' + NL + '\tasync fetch'), entry);
  assert.ok(entry.endsWith('} satisfies ExportedHandler<Env>);' + NL), entry);

  const edited = change(plan, 'wrangler.jsonc').content;
  const parsed = JSON.parse(edited.replace(/,(\s*[}\]])/g, '$1'));
  assert.deepEqual(parsed.compatibility_flags, ['nodejs_compat']);
  assert.equal(parsed.upload_source_maps, true);
  assert.deepEqual(parsed.version_metadata, { binding: 'CF_VERSION_METADATA' });
  assert.deepEqual(parsed.vars, { ZHARP_SERVICE: 'shop-worker' });
  assert.equal(parsed.main, 'src/index.ts');

  const scripts = JSON.parse(change(plan, 'package.json').content).scripts;
  assert.equal(scripts.deploy, 'wrangler deploy --outdir .wrangler/zharp-dist --var ZHARP_RELEASE:$(git rev-parse --short HEAD) && zharp sourcemaps upload .wrangler/zharp-dist --release $(git rev-parse --short HEAD) --app 42');
  assert.equal(scripts.dev, 'wrangler dev');
  assert.deepEqual(plan.env, { file: '.dev.vars', vars: { ZHARP_KEY: 'zpk_abc' } });
  assert.ok(plan.notes.some((n) => n.includes('wrangler secret put ZHARP_KEY')));
});

await test('Workers (wrangler.toml, Hono): the app wrapped by name; flags merged; a recent date needs no flag', () => {
  const toml = ['name = "api"', 'main = "src/index.ts"', 'compatibility_date = "2024-01-01"', 'compatibility_flags = ["global_fetch_strictly_public"]', '', '[[d1_databases]]', 'binding = "DB"', 'database_name = "shop"', ''].join(NL);
  const p = project('worker-toml', {
    'package.json': JSON.stringify({ name: 'api', scripts: { deploy: 'wrangler deploy --minify' }, dependencies: { hono: '^4' }, devDependencies: { wrangler: '4' } }),
    'wrangler.toml': toml,
    'src/index.ts': ["import { Hono } from 'hono'", '', 'const app = new Hono()', "app.get('/', (c) => c.text('hi'))", '', 'export default app', ''].join(NL),
  });
  assert.equal(p.label, 'Cloudflare Workers (Hono)');
  const plan = planFor(p, c, API);
  const entry = change(plan, 'src/index.ts').content;
  assert.ok(entry.startsWith("import { Hono } from 'hono'" + NL + "import { withZharp } from '@zharp/cloudflare'" + NL), entry);
  assert.ok(entry.includes('export default withZharp(app)' + NL), entry);
  const edited = change(plan, 'wrangler.toml').content;
  assert.ok(edited.includes('compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]'), edited);
  assert.ok(edited.includes('upload_source_maps = true' + NL + NL + '[[d1_databases]]'), edited);
  assert.ok(edited.includes('[vars]' + NL + 'ZHARP_SERVICE = "shop-worker"'), edited);
  assert.ok(edited.includes('[version_metadata]' + NL + 'binding = "CF_VERSION_METADATA"'), edited);
  // A deploy script that isn't the plain one is left alone, and said how to change.
  assert.ok(!change(plan, 'package.json'));
  assert.ok(plan.notes.some((n) => n.startsWith('Readable stacks: deploy with wrangler deploy --outdir')));

  const recent = cf.editWranglerConfig(['name = "x"', 'compatibility_date = "2026-10-01"', ''].join(NL), true, 'x');
  assert.ok(!recent.includes('nodejs_compat'), recent);
});

await test('Workers: a class default export or a second run is a snippet, not an edit', () => {
  assert.equal(cf.wrapWorkerEntry('export default class extends WorkerEntrypoint {}' + NL), null);
  assert.equal(cf.wrapWorkerEntry("import { withZharp } from '@zharp/cloudflare';" + NL + 'export default withZharp(app);' + NL), null);
  const p = project('worker-class', {
    'package.json': JSON.stringify({ name: 'svc', devDependencies: { wrangler: '4' } }),
    'wrangler.jsonc': '{ "name": "svc", "main": "src/index.ts", "compatibility_date": "2026-11-01", "compatibility_flags": ["nodejs_compat"] }' + NL,
    'src/index.ts': "import { WorkerEntrypoint, DurableObject } from 'cloudflare:workers';" + NL + 'export class Cart extends DurableObject {}' + NL + 'export default class extends WorkerEntrypoint {}' + NL,
  });
  const plan = planFor(p, c, API);
  assert.ok(!change(plan, 'src/index.ts'));
  assert.equal(plan.manual[0].path, 'src/index.ts');
  assert.ok(plan.notes.some((n) => n.includes('instrumentDurableObject')));
  assert.ok(!change(plan, 'wrangler.jsonc').content.includes('"nodejs_compat",\n'), 'the flag is not added twice');
});

await test('Pages Functions: functions/_middleware.ts created', () => {
  const p = project('pages', {
    'package.json': JSON.stringify({ name: 'site', devDependencies: { wrangler: '4', typescript: '5' } }),
    'wrangler.toml': ['name = "site"', 'pages_build_output_dir = "./dist"', 'compatibility_date = "2025-01-01"', ''].join(NL),
    'functions/api/hello.ts': 'export const onRequest = () => new Response("hi");' + NL,
  });
  assert.equal(p.framework, 'cloudflare-pages');
  assert.equal(p.catalog, 'Cloudflare Pages');
  const plan = planFor(p, c, API);
  assert.ok(change(plan, 'functions/_middleware.ts').content.includes('export const onRequest = zharpPagesPlugin();'));
  assert.ok(change(plan, 'wrangler.toml').content.includes('nodejs_compat'));
  assert.ok(plan.notes.some((n) => n.includes('wrangler pages secret put ZHARP_KEY')));
});

await test('A framework on its own Cloudflare adapter keeps its own setup', () => {
  const p = project('opennext', {
    'package.json': JSON.stringify({ name: 'web', dependencies: { next: '15.0.0', '@opennextjs/cloudflare': '1' } }),
    'wrangler.jsonc': '{ "name": "web", "main": ".open-next/worker.js" }' + NL,
  });
  assert.equal(p.framework, 'nextjs');
});

await test('sourcemaps upload --release: files without debug IDs are filed under the release, by content', async () => {
  const dir = join(tmp, 'wrangler-out');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.js'), 'export default{fetch(){throw new Error("x")}};' + NL + '//# sourceMappingURL=index.js.map' + NL);
  writeFileSync(join(dir, 'index.js.map'), JSON.stringify({ version: 3, sources: ['../src/index.ts'], sourcesContent: ['x'], names: [], mappings: 'AAAA' }));
  const sent = [];
  const fetch = async (url, init) => {
    sent.push(Object.fromEntries([...init.body.entries()].filter(([k]) => k !== 'file')));
    return new Response('{}', { status: 201 });
  };
  const connection = { url: 'http://zharp.test', authToken: 't', app: 42 };
  const none = await uploadSourcemaps(dir, connection, { logger: silent, fetch });
  assert.equal(none.files, 0);
  assert.deepEqual(none.skipped, ['index.js']);

  const result = await uploadSourcemaps(dir, connection, { release: 'abc123', logger: silent, fetch });
  assert.equal(result.files, 1);
  const id = contentDebugId(Buffer.from('export default{fetch(){throw new Error("x")}};' + NL + '//# sourceMappingURL=index.js.map' + NL));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(sent, [
    { kind: 'minified-source', debugId: id, name: 'index.js', release: 'abc123' },
    { kind: 'sourcemap', debugId: id, name: 'index.js.map', release: 'abc123' },
  ]);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
