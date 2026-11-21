/**
 * @zharp/react-native's build pieces: the Expo config plugin's edits and the Metro serializer's
 * debug ID, for each shape a serializer returns.
 *
 *     node test/react-native.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = join(here, '..', 'packages', 'react-native');
const plugin = require(join(pkg, 'app.plugin.js'));
const { withZharpConfig } = require(join(pkg, 'metro.js'));

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('\n@zharp/react-native — build pieces');

await test('app/build.gradle: zharp.gradle after React Native\'s plugin, once', () => {
  const gradle = 'apply plugin: "com.android.application"\napply plugin: "com.facebook.react"\n\nandroid {}\n';
  const once = plugin.addGradleLine(gradle);
  assert.match(once, /apply plugin: "com\.facebook\.react"\napply from: .*zharp\.gradle"\)\n/);
  assert.equal(plugin.addGradleLine(once), once);
});

await test('the bundle phase: a source map first, its upload last, once — React Native\'s and Expo\'s scripts', () => {
  const rn = 'set -e\n\nWITH_ENVIRONMENT="$REACT_NATIVE_PATH/scripts/xcode/with-environment.sh"\n/bin/sh -c "x"\n';
  const wired = plugin.wireBundlePhase(rn);
  const lines = wired.trim().split('\n');
  assert.equal(lines[0], 'set -e');
  assert.equal(lines[1], 'export SOURCEMAP_FILE="${SOURCEMAP_FILE:-$DERIVED_FILE_DIR/main.jsbundle.map}"');
  assert.match(lines.at(-1), /zharp-upload\.sh"$/);
  assert.equal(plugin.wireBundlePhase(wired), wired);
  const expo = 'if [[ -f "$PODS_ROOT/../.xcode.env" ]]; then\n  source "$PODS_ROOT/../.xcode.env"\nfi\n`"$NODE_BINARY" --print "x"`\n';
  assert.match(plugin.wireBundlePhase(expo), /^export SOURCEMAP_FILE=.*\nif \[\[/);
});

function graph(dev = false) {
  const module = (path, code) => ({ path, output: [{ type: 'js/module', data: { code } }], dependencies: new Map() });
  return {
    transformOptions: { dev },
    dependencies: new Map([['/app/index.js', module('/app/index.js', 'run()')], ['/app/cart.js', module('/app/cart.js', 'total()')]]),
  };
}

await test('serializer: a debug-ID module first; the ID in every map, whatever the shape', async () => {
  const seen = [];
  const shapes = {
    code: async () => 'bundle',
    codeAndMap: async () => ({ code: 'bundle', map: '{"version":3}' }),
    expoExport: async () => ({ artifacts: [{ filename: 'a.hbc', type: 'js', source: Buffer.from('x') }, { filename: 'a.hbc.map', type: 'map', source: '{"version":3}' }], assets: [] }),
    expoJson: async () => JSON.stringify([{ filename: 'a.js', type: 'js', source: 'x' }, { filename: 'a.js.map', type: 'map', source: '{"version":3}' }]),
  };
  for (const [name, serialize] of Object.entries(shapes)) {
    const config = withZharpConfig({ serializer: { customSerializer: async (entry, pre, g, o) => { seen.push(pre); return serialize(entry, pre, g, o); } } });
    const result = await config.serializer.customSerializer('/app/index.js', [], graph(), {});
    const module = seen.at(-1)[0];
    assert.equal(module.path, '__zharp_debug_id__', name);
    const id = /zharp-debug-id:([0-9a-f-]{36})/.exec(module.output[0].data.code)[1];
    if (name === 'codeAndMap') assert.equal(JSON.parse(result.map).debugId, id);
    if (name === 'expoExport') assert.equal(JSON.parse(result.artifacts[1].source).debugId, id);
    if (name === 'expoJson') assert.equal(JSON.parse(JSON.parse(result)[1].source).debugId, id);
    if (name === 'code') assert.equal(result, 'bundle');
  }
  // The same modules, the same ID.
  const ids = seen.map((pre) => pre[0].output[0].data.code);
  assert.equal(new Set(ids).size, 1);
});

await test('serializer: development bundles are left as they are', async () => {
  let pre;
  const config = withZharpConfig({ serializer: { customSerializer: async (e, p) => ((pre = p), 'dev bundle') } });
  assert.equal(await config.serializer.customSerializer('/app/index.js', [], graph(true), {}), 'dev bundle');
  assert.deepEqual(pre, []);
});

console.log(`\n${passed} passed`);
