/**
 * `zharp init` for Godot: a GDScript game, a C# game, a project that already has the addon, and
 * project.godot edits that keep what's there.
 *
 *     node test/init-godot.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'cli');
const tmp = mkdtempSync(join(pkg, '.test-'));
for (const name of ['recipes', 'detect', 'recipes-godot']) {
  await esbuild.build({ entryPoints: [join(pkg, 'src', 'init', `${name}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile: join(tmp, `${name}.mjs`), logLevel: 'silent' });
}
const { planFor, GUIDES } = await import(pathToFileURL(join(tmp, 'recipes.mjs')).href);
const { detect } = await import(pathToFileURL(join(tmp, 'detect.mjs')).href);
const godot = await import(pathToFileURL(join(tmp, 'recipes-godot.mjs')).href);
const c = { application: { id: 42, name: 'Shop Quest', serviceName: 'shop-quest', ingestKey: 'zpk_abc' }, workspace: { id: 3, name: 'W' }, uploadKey: 'zh_up', appUrl: 'u' };
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

// A new Godot 4.5 project, as the project manager writes it.
const PROJECT = `; Engine configuration file.
; It's best edited using the editor UI and not directly,
; since the parameters that go here are not all obvious.
;
; Format:
;   [section] ; section goes between []
;   param=value ; assign values to parameters

config_version=5

[application]

config/name="Shop Quest"
run/main_scene="uid://b5kx3x1h3v4k1"
config/features=PackedStringArray("4.5", "Forward Plus")
config/icon="res://icon.svg"

[editor_plugins]

enabled=PackedStringArray("res://addons/dialogue_manager/plugin.cfg")
`;

console.log('\nzharp init — Godot');

await test('a GDScript game: the addon copied in, enabled, the key and service under [zharp]', () => {
  const p = project('gd', { 'project.godot': PROJECT, 'main.gd': 'extends Node\n' });
  assert.equal(p.framework, 'godot');
  assert.equal(p.platform, 'godot');
  assert.equal(p.catalog, 'Godot');
  assert.equal(p.name, 'Shop Quest');
  assert.equal(p.label, 'Godot 4.5');
  const plan = planFor(p, c, API);
  assert.ok(change(plan, 'addons/zharp/plugin.cfg'));
  assert.ok(change(plan, 'addons/zharp/zharp.gd'));
  assert.ok(change(plan, 'addons/zharp/internal/logger.gd'));
  assert.equal(change(plan, 'addons/zharp/zharp.gd').kind, 'create');
  const text = change(plan, 'project.godot').content;
  assert.match(text, /\[autoload\]\n\nZharp="\*res:\/\/addons\/zharp\/zharp\.gd"\n/);
  assert.match(text, /enabled=PackedStringArray\("res:\/\/addons\/dialogue_manager\/plugin\.cfg", "res:\/\/addons\/zharp\/plugin\.cfg"\)/);
  assert.match(text, /\[debug\]\n\nsettings\/gdscript\/always_track_call_stacks=true\nfile_logging\/enable_file_logging=true\n/);
  assert.match(text, /\[zharp\]\n\nkey="zpk_abc"\nservice="shop-quest"\n$/);
  assert.ok(text.startsWith(PROJECT.replace(/\n$/, '').split('[editor_plugins]')[0]), 'what was there is kept');
  assert.equal(plan.commands.length, 0);
  assert.equal(plan.env.file, '');
  assert.equal(GUIDES.godot, 'https://zharp.io/docs/sdks/godot');
});

await test('a local Zharp: the endpoint under [zharp] too', () => {
  const p = project('gd-local', { 'project.godot': PROJECT });
  const text = change(planFor(p, c, 'http://localhost:4000'), 'project.godot').content;
  assert.match(text, /endpoint="http:\/\/localhost:4000\/api\/v1\/otlp"/);
});

await test('a C# game: Zharp.Godot added to its .csproj, and the line that starts it to paste', () => {
  const p = project('cs', {
    'project.godot': PROJECT.replace('"4.5", "Forward Plus"', '"4.5", "C#", "Forward Plus"'),
    'ShopQuest.csproj': '<Project Sdk="Godot.NET.Sdk/4.5.1">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n',
  });
  assert.equal(p.framework, 'godot', 'not .NET: project.godot wins');
  assert.equal(p.label, 'Godot 4.5 (C#)');
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.commands[0].argv, ['dotnet', 'add', 'ShopQuest.csproj', 'package', 'Zharp.Godot', '--version', godot.ZHARP_GODOT_VERSION]);
  assert.match(plan.manual[0].snippet, /ZharpGodot\.Start\(this\)/);
});

await test('the addon already there: left alone, the settings still written; run again: nothing to change', () => {
  const p = project('has-addon', { 'project.godot': PROJECT, 'addons/zharp/plugin.cfg': '[plugin]\nname="Zharp"\n' });
  const plan = planFor(p, c, API);
  assert.equal(plan.changes.filter((ch) => ch.path.startsWith('addons/')).length, 0);
  assert.match(plan.notes[0], /already there/);
  const once = change(plan, 'project.godot').content;
  assert.equal(godot.editProjectGodot(once, 'zpk_abc', 'shop-quest', null), null);
});

await test('settings Godot wrote already are kept: call stacks the developer turned off stay off', () => {
  const text = godot.editProjectGodot(`${PROJECT}\n[debug]\n\nsettings/gdscript/always_track_call_stacks=false\n`, 'zpk_abc', 'shop-quest', null);
  assert.match(text, /always_track_call_stacks=false/);
  assert.match(text, /file_logging\/enable_file_logging=true/);
});

await test('setSetting: replaces a key, adds one at the end of its section, or a new section', () => {
  const ini = '[a]\n\nx=1\n\n[b]\n\ny=2\n';
  assert.equal(godot.setSetting(ini, 'a', 'x', '3'), '[a]\n\nx=3\n\n[b]\n\ny=2\n');
  assert.equal(godot.setSetting(ini, 'a', 'z', '4'), '[a]\n\nx=1\nz=4\n\n[b]\n\ny=2\n');
  assert.equal(godot.setSetting(ini, 'c', 'w', '5'), '[a]\n\nx=1\n\n[b]\n\ny=2\n\n[c]\n\nw=5\n');
});

await test('an old Godot: said so', () => {
  const p = project('old', { 'project.godot': PROJECT.replace('"4.5", "Forward Plus"', '"4.3", "Forward Plus"') });
  assert.ok(planFor(p, c, API).notes.some((n) => /Godot 4\.3: the addon needs Godot 4\.5/.test(n)));
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed\n`);
