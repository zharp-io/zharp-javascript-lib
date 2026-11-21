/**
 * Source bundles: what `dart-symbols upload` / `dsym upload` send of the app's own code.
 *
 *     node test/source-bundle.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'cli');
const tmp = mkdtempSync(join(pkg, '.test-'));
await esbuild.build({ entryPoints: [join(pkg, 'src', 'source-bundle.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(tmp, 'sb.mjs'), logLevel: 'silent' });
const sb = await import(pathToFileURL(join(tmp, 'sb.mjs')).href);

function project(files) {
  const dir = mkdtempSync(join(tmp, 'p-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

try {
  const flutter = project({
    'pubspec.yaml': 'name: shop',
    'lib/main.dart': 'void main() {}',
    'lib/cart/total.dart': 'int total() => 1;',
    'test/widget_test.dart': 'void main() {}',
    'build/app/x.dart': 'generated',
    '.dart_tool/y.dart': 'tool',
    'android/app/src/main/kotlin/MainActivity.kt': 'class MainActivity',
  });
  const got = sb.collectSources(flutter, sb.FLUTTER_SOURCES);
  assert.deepEqual(Object.keys(got.files).sort(), ['lib/cart/total.dart', 'lib/main.dart'], 'app code only: no tests, build output or tool caches');
  assert.equal(sb.projectRoot(join(flutter, 'build', 'app'), sb.isFlutterRoot), flutter, 'found from a folder inside the project');

  const ios = project({
    'Shop.xcodeproj/project.pbxproj': '',
    'Shop/CartView.swift': 'struct CartView {}',
    'Shop/Legacy.m': '@implementation Legacy @end',
    'ShopTests/CartTests.swift': 'final class CartTests {}',
    'Pods/Alamofire/Session.swift': 'pod',
    'Shop/Assets.xcassets/x.h': 'asset',
  });
  assert.deepEqual(Object.keys(sb.collectSources(ios, sb.APPLE_SOURCES).files).sort(), ['Shop/CartView.swift', 'Shop/Legacy.m']);
  assert.ok(sb.isAppleRoot(ios));

  const [artifact, ...rest] = sb.sourceBundleArtifacts(got, ['id-1', 'id-2', 'id-1'], '1.0.0+3');
  assert.equal(rest.length, 1, 'once per build ID');
  assert.equal(artifact.kind, 'source-bundle');
  assert.deepEqual(JSON.parse(Buffer.from(artifact.data).toString('utf8')).files['lib/cart/total.dart'], 'int total() => 1;');
  void gunzipSync;
  console.log('source bundles: 3 passed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
