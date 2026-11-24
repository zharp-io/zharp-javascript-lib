/**
 * `zharp init` for Elixir: Phoenix (with Igniter, and by hand), Plug, plain Elixir, umbrellas.
 *
 *     node test/init-elixir.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'cli');
const tmp = mkdtempSync(join(pkg, '.test-'));
for (const name of ['recipes', 'detect', 'recipes-elixir']) {
  await esbuild.build({ entryPoints: [join(pkg, 'src', 'init', `${name}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile: join(tmp, `${name}.mjs`), logLevel: 'silent' });
}
const { planFor } = await import(pathToFileURL(join(tmp, 'recipes.mjs')).href);
const { detect } = await import(pathToFileURL(join(tmp, 'detect.mjs')).href);
const elixir = await import(pathToFileURL(join(tmp, 'recipes-elixir.mjs')).href);
const c = { application: { id: 42, name: 'shop', serviceName: 'shop', ingestKey: 'zpk_abc' }, workspace: { id: 3, name: 'W' }, uploadKey: 'zh_up', appUrl: 'u' };
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
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return detect(dir);
}
const change = (plan, path) => plan.changes.find((ch) => ch.path === path);

// As `mix phx.new shop` writes them (Phoenix 1.8).
const PHX_MIX = `defmodule Shop.MixProject do
  use Mix.Project

  def project do
    [
      app: :shop,
      version: "0.1.0",
      elixir: "~> 1.15",
      deps: deps()
    ]
  end

  defp deps do
    [
      {:phoenix, "~> 1.8.1"},
      {:phoenix_ecto, "~> 4.5"},
      {:bandit, "~> 1.5"}
    ]
  end
end
`;
const ENDPOINT = `defmodule ShopWeb.Endpoint do
  use Phoenix.Endpoint, otp_app: :shop

  plug Plug.Static, at: "/", from: :shop
  plug Plug.RequestId
  plug Plug.Telemetry, event_prefix: [:phoenix, :endpoint]
  plug ShopWeb.Router
end
`;
const RUNTIME = `import Config

if config_env() == :prod do
  config :shop, ShopWeb.Endpoint, server: true
end
`;

console.log('\nzharp init — Elixir');

await test('Phoenix without Igniter: the dependency, the plug before Plug.RequestId, runtime config, mix deps.get, key in .env', () => {
  const p = project('phx', { 'mix.exs': PHX_MIX, 'lib/shop_web/endpoint.ex': ENDPOINT, 'config/runtime.exs': RUNTIME, 'assets/package.json': '{}' });
  assert.equal(p.framework, 'phoenix');
  assert.equal(p.platform, 'elixir');
  assert.equal(p.catalog, 'Phoenix');
  assert.equal(p.label, 'Phoenix 1.8');
  assert.equal(p.name, 'shop');
  const plan = planFor(p, c, API);
  assert.ok(change(plan, 'mix.exs').content.includes('    [\n      {:zharp, "~> 0.1"},\n      {:phoenix, "~> 1.8.1"},'));
  assert.ok(change(plan, 'lib/shop_web/endpoint.ex').content.includes('  plug Zharp.Plug\n  plug Plug.RequestId'));
  assert.ok(change(plan, 'config/runtime.exs').content.endsWith('config :zharp,\n  key: System.get_env("ZHARP_KEY"),\n  environment: to_string(config_env())\n'));
  assert.deepEqual(plan.commands.map((cmd) => cmd.argv.join(' ')), ['mix deps.get']);
  assert.deepEqual(plan.env, { file: '.env', vars: { ZHARP_KEY: 'zpk_abc', ZHARP_SERVICE: 'shop' } });
  assert.ok(plan.notes.some((n) => n.includes('Zharp.Release.package_source')));
});

await test('Phoenix with Igniter: mix igniter.install zharp does it all', () => {
  const p = project('phx-igniter', { 'mix.exs': PHX_MIX.replace('{:bandit, "~> 1.5"}', '{:bandit, "~> 1.5"},\n      {:igniter, "~> 0.6", only: [:dev, :test]}'), 'lib/shop_web/endpoint.ex': ENDPOINT });
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.commands.map((cmd) => cmd.argv.join(' ')), ['mix igniter.install zharp --yes']);
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.env.vars.ZHARP_KEY, 'zpk_abc');
});

await test('running it again changes nothing', () => {
  const p = project('phx-again', {
    'mix.exs': PHX_MIX.replace('    [\n      {:phoenix', '    [\n      {:zharp, "~> 0.1"},\n      {:phoenix'),
    'lib/shop_web/endpoint.ex': ENDPOINT.replace('  plug Plug.RequestId', '  plug Zharp.Plug\n  plug Plug.RequestId'),
    'config/runtime.exs': RUNTIME + '\nconfig :zharp, key: System.get_env("ZHARP_KEY")\n',
  });
  assert.equal(planFor(p, c, API).changes.length, 0);
});

await test('Plug on Cowboy: the plug right after use Plug.Router', () => {
  const p = project('plug', {
    'mix.exs': PHX_MIX.replace('app: :shop', 'app: :api').replace(/\{:phoenix[^\n]*\n\s*\{:phoenix_ecto[^\n]*\n\s*\{:bandit[^}]*\}/, '{:plug_cowboy, "~> 2.7"}'),
    'lib/api/router.ex': 'defmodule Api.Router do\n  use Plug.Router\n\n  plug :match\n  plug :dispatch\nend\n',
  });
  assert.equal(p.framework, 'plug');
  assert.equal(p.catalog, 'Plug');
  const plan = planFor(p, c, API);
  assert.ok(change(plan, 'lib/api/router.ex').content.includes('  use Plug.Router\n  plug Zharp.Plug\n\n  plug :match'));
  assert.ok(change(plan, 'mix.exs').content.includes('{:zharp, "~> 0.1"},\n      {:plug_cowboy'));
});

await test('plain Elixir: the dependency only; a local Zharp gets ZHARP_ENDPOINT', () => {
  const p = project('worker', { 'mix.exs': 'defmodule Worker.MixProject do\n  use Mix.Project\n  def project, do: [app: :worker, deps: deps()]\n\n  defp deps do\n    []\n  end\nend\n' });
  assert.equal(p.framework, 'elixir');
  const plan = planFor(p, c, 'http://localhost:3000');
  assert.ok(change(plan, 'mix.exs').content.includes('[\n      {:zharp, "~> 0.1"},]'));
  assert.equal(plan.env.vars.ZHARP_ENDPOINT, 'http://localhost:3000/api/v1/otlp');
  assert.equal(change(plan, 'config/runtime.exs'), undefined);
});

await test('an umbrella: Phoenix found in apps/, the dependency added to the web app', () => {
  const p = project('umbrella', {
    'mix.exs': 'defmodule Store.Umbrella.MixProject do\n  use Mix.Project\n  def project, do: [apps_path: "apps", deps: deps()]\n  defp deps do\n    []\n  end\nend\n',
    'apps/store/mix.exs': 'defmodule Store.MixProject do\n  def project, do: [app: :store, deps: deps()]\n  defp deps do\n    [\n      {:ecto_sql, "~> 3.11"}\n    ]\n  end\nend\n',
    'apps/store_web/mix.exs': PHX_MIX.replace('app: :shop', 'app: :store_web'),
    'apps/store_web/lib/store_web/endpoint.ex': ENDPOINT,
  });
  assert.equal(p.framework, 'phoenix');
  const plan = planFor(p, c, API);
  assert.ok(change(plan, 'apps/store_web/mix.exs'));
  assert.ok(change(plan, 'apps/store_web/lib/store_web/endpoint.ex').content.includes('plug Zharp.Plug'));
});

await test('an endpoint without Plug.RequestId or Plug.Telemetry: the plug after use', () => {
  assert.equal(elixir.addEndpointPlug('defmodule E do\n  use Phoenix.Endpoint, otp_app: :a\n  plug R\nend\n'), 'defmodule E do\n  use Phoenix.Endpoint, otp_app: :a\n\n  plug Zharp.Plug\n  plug R\nend\n');
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
