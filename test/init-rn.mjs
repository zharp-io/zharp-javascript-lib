/**
 * `zharp init` for React Native and Expo, on files from fresh projects.
 *
 *     node test/init-rn.mjs
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'cli');
const fixtures = join(here, 'fixtures', 'react-native');
const tmp = mkdtempSync(join(pkg, '.test-'));
for (const name of ['recipes', 'recipes-rn', 'detect']) {
  await esbuild.build({ entryPoints: [join(pkg, 'src', 'init', `${name}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile: join(tmp, `${name}.mjs`), logLevel: 'silent' });
}
const { planFor } = await import(pathToFileURL(join(tmp, 'recipes.mjs')).href);
const rn = await import(pathToFileURL(join(tmp, 'recipes-rn.mjs')).href);
const { detect } = await import(pathToFileURL(join(tmp, 'detect.mjs')).href);
const plugin = createRequire(import.meta.url)(join(here, '..', 'packages', 'react-native', 'app.plugin.js'));
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
function project(name, files, copies = {}) {
  const dir = join(tmp, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  for (const [path, fixture] of Object.entries(copies)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    cpSync(join(fixtures, fixture), join(dir, path));
  }
  return detect(dir);
}
const change = (plan, path) => plan.changes.find((ch) => ch.path === path);

console.log('\nzharp init — React Native and Expo');

await test('bare React Native: detected before React; Metro wrapped, Zharp first in index.js, Android and iOS builds wired, the upload key where git ignores it', () => {
  const p = project('rn-app', {
    'package.json': JSON.stringify({ name: 'RnFresh', dependencies: { react: '19.2.0', 'react-native': '0.88.1' } }),
    '.gitignore': '# Android/IntelliJ\nlocal.properties\n.xcode.env.local\n',
    'android/local.properties': 'sdk.dir=/sdk\n',
  }, { 'metro.config.js': 'metro.config.js', 'index.js': 'index.js', 'android/app/build.gradle': 'build.gradle', 'ios/RnFresh.xcodeproj/project.pbxproj': 'project.pbxproj' });
  assert.equal(p.framework, 'react-native');
  assert.equal(p.platform, 'react-native');
  assert.equal(p.label, 'React Native 0.88');
  const plan = planFor(p, c, API);
  assert.deepEqual(plan.install, ['@zharp/react-native']);
  const metro = change(plan, 'metro.config.js').content;
  assert.match(metro, /require\('@react-native\/metro-config'\);\nconst \{ withZharpConfig \} = require\('@zharp\/react-native\/metro'\);/);
  assert.match(metro, /module\.exports = withZharpConfig\(mergeConfig\(getDefaultConfig\(__dirname\), config\)\);/);
  const index = change(plan, 'index.js').content;
  assert.ok(index.indexOf("import { Zharp } from '@zharp/react-native';") > index.indexOf("import { name as appName }"), index);
  assert.ok(index.indexOf('Zharp.init({') < index.indexOf('AppRegistry.registerComponent'), index);
  assert.match(index, /key: 'zpk_abc',\n {2}service: 'shop',\n\}\);/);
  assert.match(change(plan, 'android/app/build.gradle').content, /apply plugin: "com\.facebook\.react"\napply from: .*zharp\.gradle"\)/);
  assert.equal(change(plan, 'android/local.properties').content, 'sdk.dir=/sdk\nzharp.authToken=zh_up\nzharp.appId=42\n');
  const pbx = change(plan, 'ios/RnFresh.xcodeproj/project.pbxproj').content;
  const script = JSON.parse(/name = "Bundle React Native code and images";[\s\S]*?shellScript = ("(?:[^"\\]|\\.)*");/.exec(pbx)[1]);
  assert.equal(script, plugin.wireBundlePhase(JSON.parse(/name = "Bundle React Native code and images";[\s\S]*?shellScript = ("(?:[^"\\]|\\.)*");/.exec(readFileSync(join(fixtures, 'project.pbxproj'), 'utf8'))[1])), 'the same edit as the Expo plugin');
  assert.match(change(plan, 'ios/.xcode.env.local').content, /^export ZHARP_AUTH_TOKEN=zh_up\nexport ZHARP_APP=42\n$/);
  assert.equal(plan.env.file, '', 'no .env: the key is in code, the upload key in the native files');
  assert.equal(rn.wireXcodeProject(pbx), null, 'twice: no');
});

await test('Expo with Expo Router: metro.config.js created, the plugin in app.json, Zharp and its screens in the root layout, the upload key in .env.local', () => {
  const layout = [
    "import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';",
    "import { Stack } from 'expo-router';",
    "import { StatusBar } from 'expo-status-bar';",
    "import 'react-native-reanimated';",
    '',
    "import { useColorScheme } from '@/hooks/use-color-scheme';",
    '',
    'export const unstable_settings = {',
    "  anchor: '(tabs)',",
    '};',
    '',
    'export default function RootLayout() {',
    '  const colorScheme = useColorScheme();',
    '  return null;',
    '}',
    '',
  ].join('\n');
  const p = project('expo-router-app', {
    'package.json': JSON.stringify({ name: 'shop', main: 'expo-router/entry', dependencies: { expo: '~58.0.26', 'expo-router': '~6.0.0', react: '19.2.0', 'react-native': '0.88.1' } }),
    'app.json': JSON.stringify({ expo: { name: 'shop', plugins: ['expo-router'] } }, null, 2),
    'app/_layout.tsx': layout,
    'tsconfig.json': '{}',
    '.gitignore': '.env*.local\n',
  });
  assert.equal(p.framework, 'expo');
  assert.equal(p.label, 'Expo SDK 58');
  const plan = planFor(p, c, API);
  assert.match(change(plan, 'metro.config.js').content, /module\.exports = withZharpConfig\(getDefaultConfig\(__dirname\)\);/);
  assert.deepEqual(JSON.parse(change(plan, 'app.json').content).expo.plugins, ['expo-router', '@zharp/react-native']);
  const out = change(plan, 'app/_layout.tsx').content;
  assert.match(out, /import \{ Stack, useNavigationContainerRef \} from 'expo-router';/, "into the file's own import");
  assert.ok(out.indexOf('Zharp.init({') > out.indexOf("import { useColorScheme }"), out);
  assert.ok(out.indexOf('Zharp.init({') < out.indexOf('export const unstable_settings'), out);
  assert.match(out, /export default function RootLayout\(\) \{\n {2}\/\/ Each screen[^\n]*\n {2}useZharpNavigation\(useNavigationContainerRef\(\)\);\n {2}const colorScheme/);
  assert.deepEqual(plan.env, { file: '.env.local', vars: { ZHARP_AUTH_TOKEN: 'zh_up', ZHARP_APP: '42' } });
  assert.ok(plan.notes.some((n) => n.includes('eas env:create')));
});

await test('Expo without a router: Zharp first in the entry file; an existing metro.config.js wrapped', () => {
  const p = project('expo-blank', {
    'package.json': JSON.stringify({ name: 'blank', main: 'index.ts', dependencies: { expo: '~58.0.0', react: '19.2.0', 'react-native': '0.88.1' } }),
    'app.json': JSON.stringify({ expo: { name: 'blank' } }),
    'index.ts': "import { registerRootComponent } from 'expo';\n\nimport App from './App';\n\nregisterRootComponent(App);\n",
    'metro.config.js': "const { getDefaultConfig } = require('expo/metro-config');\n\nconst config = getDefaultConfig(__dirname);\n\nmodule.exports = config;\n",
  });
  const plan = planFor(p, c, 'http://localhost:3000');
  const entry = change(plan, 'index.ts').content;
  assert.ok(entry.indexOf('Zharp.init({') > entry.indexOf("import App from './App';") && entry.indexOf('Zharp.init({') < entry.indexOf('registerRootComponent(App)'), entry);
  assert.match(entry, /endpoint: 'http:\/\/localhost:3000\/api\/v1\/otlp',/);
  assert.match(change(plan, 'metro.config.js').content, /module\.exports = withZharpConfig\(config\);/);
  assert.deepEqual(JSON.parse(change(plan, 'app.json').content).expo.plugins, ['@zharp/react-native']);
  assert.equal(plan.env.vars.ZHARP_URL, 'http://localhost:3000');
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
