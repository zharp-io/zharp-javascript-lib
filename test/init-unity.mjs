/**
 * `zharp init` for Unity: the package from its Git URL or from OpenUPM, a manifest that has it
 * already, settings merged into an existing file, and an old Unity.
 *
 *     node test/init-unity.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'cli');
const tmp = mkdtempSync(join(pkg, '.test-'));
for (const name of ['recipes', 'detect', 'recipes-unity']) {
  await esbuild.build({ entryPoints: [join(pkg, 'src', 'init', `${name}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile: join(tmp, `${name}.mjs`), logLevel: 'silent' });
}
const { planFor, GUIDES } = await import(pathToFileURL(join(tmp, 'recipes.mjs')).href);
const { detect } = await import(pathToFileURL(join(tmp, 'detect.mjs')).href);
const unity = await import(pathToFileURL(join(tmp, 'recipes-unity.mjs')).href);
const c = { application: { id: 42, name: 'Shop Quest', serviceName: 'shop-quest', ingestKey: 'zpk_abc' }, workspace: { id: 3, name: 'W' }, uploadKey: 'zh_up', appUrl: 'u' };
const API = 'https://api.zharp.io';
const GIT = 'https://github.com/zharp-io/zharp-unity-lib.git#0.1.0';

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

const VERSION = 'm_EditorVersion: 6000.0.23f1\nm_EditorVersionWithRevision: 6000.0.23f1 (1c4764c07fb4)\n';

// A new Unity 6 project (Universal 3D template), as the Hub writes it.
const MANIFEST = `{
  "dependencies": {
    "com.unity.ai.navigation": "2.0.4",
    "com.unity.collab-proxy": "2.5.2",
    "com.unity.ide.rider": "3.0.31",
    "com.unity.ide.visualstudio": "2.0.22",
    "com.unity.inputsystem": "1.11.0",
    "com.unity.multiplayer.center": "1.0.0",
    "com.unity.render-pipelines.universal": "17.0.3",
    "com.unity.test-framework": "1.4.5",
    "com.unity.timeline": "1.8.7",
    "com.unity.ugui": "2.0.0",
    "com.unity.visualscripting": "1.9.4",
    "com.unity.modules.accessibility": "1.0.0",
    "com.unity.modules.ai": "1.0.0",
    "com.unity.modules.androidjni": "1.0.0",
    "com.unity.modules.animation": "1.0.0",
    "com.unity.modules.audio": "1.0.0",
    "com.unity.modules.imgui": "1.0.0",
    "com.unity.modules.jsonserialize": "1.0.0",
    "com.unity.modules.particlesystem": "1.0.0",
    "com.unity.modules.physics": "1.0.0",
    "com.unity.modules.physics2d": "1.0.0",
    "com.unity.modules.ui": "1.0.0",
    "com.unity.modules.uielements": "1.0.0",
    "com.unity.modules.unitywebrequest": "1.0.0",
    "com.unity.modules.video": "1.0.0",
    "com.unity.modules.vr": "1.0.0",
    "com.unity.modules.xr": "1.0.0"
  }
}
`;
const PROJECT_SETTINGS = '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!129 &1\nPlayerSettings:\n  m_ObjectHideFlags: 0\n  serializedVersion: 28\n  productGUID: 0a1b2c3d4e5f60718293a4b5c6d7e8f9\n  AndroidProfiler: 0\n  companyName: DefaultCompany\n  productName: Shop Quest\n  defaultCursor: {fileID: 0}\n';

const unityProject = (name, files = {}) => project(name, {
  'ProjectSettings/ProjectVersion.txt': VERSION,
  'ProjectSettings/ProjectSettings.asset': PROJECT_SETTINGS,
  'Packages/manifest.json': MANIFEST,
  'Assets/Scripts/Player.cs': 'using UnityEngine;\npublic class Player : MonoBehaviour {}\n',
  ...files,
});

console.log('\nzharp init — Unity');

await test('a Unity 6 project: the package from its Git URL, at the end of dependencies; the settings written', () => {
  // The IDE's .csproj and .sln are there too: Unity wins over .NET.
  const p = unityProject('git', { 'Assembly-CSharp.csproj': '<Project ToolsVersion="4.0">\n</Project>\n', 'git.sln': '\n' });
  assert.equal(p.framework, 'unity');
  assert.equal(p.platform, 'unity');
  assert.equal(p.catalog, 'Unity');
  assert.equal(p.name, 'Shop Quest');
  assert.equal(p.label, 'Unity 6000.0.23f1');
  const plan = planFor(p, c, API);
  const manifest = change(plan, 'Packages/manifest.json');
  assert.equal(manifest.kind, 'edit');
  assert.equal(manifest.content, MANIFEST.replace('"com.unity.modules.xr": "1.0.0"\n', `"com.unity.modules.xr": "1.0.0",\n    "io.zharp.unity": "${GIT}"\n`), 'only the package line is added');
  const settings = change(plan, 'Assets/Zharp/Resources/ZharpSettings.json');
  assert.equal(settings.kind, 'create');
  assert.equal(settings.content, '{\n  "key": "zpk_abc",\n  "service": "shop-quest",\n  "applicationId": "42"\n}\n');
  assert.equal(plan.changes.length, 2, 'no .meta file');
  assert.equal(plan.commands.length, 0);
  assert.equal(plan.env.file, '');
  assert.ok(!plan.notes.some((n) => /needs Unity 6/.test(n)));
  assert.ok(plan.notes.some((n) => /Project Settings › Zharp/.test(n)));
  assert.ok(plan.notes.some((n) => /ZHARP_AUTH_TOKEN/.test(n) && /ZHARP_APP_ID=42/.test(n) && /never put it in the project/.test(n)));
  assert.ok(!JSON.stringify(plan.changes).includes('zh_up'), 'the upload token is not written to the project');
  assert.equal(GUIDES.unity, 'https://zharp.io/docs/sdks/unity');
  assert.equal(unity.ZHARP_UNITY_GIT_URL, GIT);
});

await test('a local Zharp: the endpoint in the settings too', () => {
  const p = unityProject('local');
  const settings = JSON.parse(change(planFor(p, c, 'http://localhost:4000'), 'Assets/Zharp/Resources/ZharpSettings.json').content);
  assert.equal(settings.endpoint, 'http://localhost:4000/api/v1/otlp');
});

await test('the OpenUPM registry already there: io.zharp added to its scopes, the version from OpenUPM', () => {
  const manifest = JSON.parse(MANIFEST);
  const withRegistry = JSON.stringify({ scopedRegistries: [{ name: 'package.openupm.com', url: 'https://package.openupm.com', scopes: ['com.cysharp.unitask'] }], ...manifest }, null, 2) + '\n';
  const p = unityProject('openupm', { 'Packages/manifest.json': withRegistry });
  const next = JSON.parse(change(planFor(p, c, API), 'Packages/manifest.json').content);
  assert.deepEqual(next.scopedRegistries[0].scopes, ['com.cysharp.unitask', 'io.zharp']);
  assert.equal(next.dependencies['io.zharp.unity'], '0.1.0');
  assert.deepEqual(Object.keys(next), ['scopedRegistries', 'dependencies'], 'key order kept');
  assert.equal(Object.keys(next.dependencies).at(-1), 'io.zharp.unity');
  // A scope that covers it already: not added again.
  const covered = withRegistry.replace('"com.cysharp.unitask"', '"io.zharp"');
  assert.deepEqual(JSON.parse(unity.editManifest(covered).content).scopedRegistries[0].scopes, ['io.zharp']);
});

await test('the package already there: the manifest left as it is, the settings still written', () => {
  const pinned = MANIFEST.replace('"com.unity.ai.navigation"', '"io.zharp.unity": "https://github.com/zharp-io/zharp-unity-lib.git#main",\n    "com.unity.ai.navigation"');
  const p = unityProject('has-package', { 'Packages/manifest.json': pinned });
  const plan = planFor(p, c, API);
  assert.equal(change(plan, 'Packages/manifest.json'), undefined);
  assert.ok(plan.notes.some((n) => /already in Packages\/manifest\.json/.test(n)));
  assert.ok(change(plan, 'Assets/Zharp/Resources/ZharpSettings.json'));
});

await test('an existing settings file: merged, other settings kept; run again: nothing to change', () => {
  const existing = '{\n  "key": "zpk_old",\n  "logs": true,\n  "environment": "staging"\n}\n';
  const p = unityProject('has-settings', { 'Assets/Zharp/Resources/ZharpSettings.json': existing });
  const settings = change(planFor(p, c, API), 'Assets/Zharp/Resources/ZharpSettings.json');
  assert.equal(settings.kind, 'edit');
  assert.equal(settings.content, '{\n  "key": "zpk_abc",\n  "logs": true,\n  "environment": "staging",\n  "service": "shop-quest",\n  "applicationId": "42"\n}\n');
  assert.equal(unity.editSettings(settings.content, { key: 'zpk_abc', service: 'shop-quest', applicationId: '42' }), null);
  assert.equal(unity.editSettings('[1]', { key: 'k' }), 'invalid');
});

await test('an old Unity: said so, the setup still done', () => {
  const p = unityProject('old', { 'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 2022.3.45f1\nm_EditorVersionWithRevision: 2022.3.45f1 (a13dfa44d684)\n' });
  assert.equal(p.label, 'Unity 2022.3.45f1');
  const plan = planFor(p, c, API);
  assert.ok(plan.notes.some((n) => /Unity 2022\.3\.45f1: io\.zharp\.unity needs Unity 6\.0 LTS or 6\.3 LTS/.test(n)));
  assert.ok(change(plan, 'Packages/manifest.json'));
  assert.ok(unity.supportedUnity('6000.3.0f1'));
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed\n`);
