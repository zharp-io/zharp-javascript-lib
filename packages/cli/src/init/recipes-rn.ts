/**
 * `zharp init` for React Native and Expo: @zharp/react-native installed and started, release
 * builds made readable (the Metro serializer, then the source map uploaded by the Android and
 * iOS builds), and the upload key kept where git ignores it.
 *
 * - Expo: metro.config.js (Expo's default + withZharpConfig), the config plugin in app.json, Zharp
 *   started in the root layout (Expo Router, with screens) or the entry file; the upload key in
 *   .env.local for local builds, and EAS secrets for EAS Build.
 * - React Native: metro.config.js wrapped, Zharp started first in index.js, android/app/build.gradle
 *   and the Xcode bundle phase wired as the config plugin wires Expo's; the upload key in
 *   android/local.properties and ios/.xcode.env.local.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connected } from './connect';
import type { Project } from './detect';
import type { Plan } from './recipes';

const read = (dir: string, path: string): string | null => {
  try {
    return readFileSync(join(dir, path), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
};
const first = (dir: string, paths: string[]) => paths.find((p) => existsSync(join(dir, p))) ?? null;

function emptyPlan(): Plan {
  return { install: [], devInstall: [], changes: [], manual: [], notes: [], env: { file: '', vars: {} }, commands: [] };
}

/** The ingest endpoint, when it isn't Zharp's own. */
function endpointOf(api: string): string | null {
  const clean = api.replace(/\/+$/, '');
  return /^https:\/\/api\.zharp\.io$/.test(clean) ? null : `${clean}/api/v1/otlp`;
}

// ── shared with app.plugin.js (keep the two in step) ─────────────────────────

export const GRADLE_LINE =
  `apply from: new File(["node", "--print", "require.resolve('@zharp/react-native/package.json')"].execute(null, rootDir).text.trim(), "../zharp.gradle")`;

/** app/build.gradle with zharp.gradle applied after React Native's plugin (once). */
export function addGradleLine(text: string): string {
  if (text.includes('zharp.gradle')) return text;
  const anchor = /^apply plugin: ["']com\.facebook\.react["'][^\n]*$/m;
  if (anchor.test(text)) return text.replace(anchor, (line) => `${line}\n${GRADLE_LINE}`);
  return `${text.replace(/\s*$/, '')}\n\n${GRADLE_LINE}\n`;
}

/** The bundle phase's script with a source map written first and uploaded after the bundle (once). */
export function wireBundlePhase(script: string): string {
  if (script.includes('zharp-upload.sh')) return script;
  const sourceMap = 'export SOURCEMAP_FILE="${SOURCEMAP_FILE:-$DERIVED_FILE_DIR/main.jsbundle.map}"';
  const lines = script.split('\n');
  lines.splice(lines[0].trim() === 'set -e' ? 1 : 0, 0, sourceMap);
  const upload = '/bin/bash "$PODS_ROOT/../../node_modules/@zharp/react-native/ios/zharp-upload.sh"';
  return `${lines.join('\n').replace(/\s*$/, '')}\n${upload}\n`;
}

/**
 * project.pbxproj with the "Bundle React Native code and images" phase wired, or null when the
 * phase isn't there (or is already wired). The script is one quoted string in the file.
 */
export function wireXcodeProject(pbxproj: string): string | null {
  const phase = /(name = "Bundle React Native code and images";[\s\S]*?shellScript = )("(?:[^"\\]|\\.)*")(;)/.exec(pbxproj);
  if (!phase) return null;
  let script: string;
  try {
    script = JSON.parse(phase[2]);
  } catch {
    return null;
  }
  const wired = wireBundlePhase(script);
  if (wired === script) return null;
  return pbxproj.replace(phase[0], `${phase[1]}${JSON.stringify(wired)}${phase[3]}`);
}

// ── edits ────────────────────────────────────────────────────────────────────

/** metro.config.js with withZharpConfig around what it exports, or null when its shape is unknown. */
export function wrapMetroConfig(text: string): string | null {
  if (text.includes('withZharpConfig')) return null;
  const exportLine = /^module\.exports\s*=\s*([\s\S]+?);?\s*$/m;
  const m = exportLine.exec(text);
  if (!m) return null;
  const require = "const { withZharpConfig } = require('@zharp/react-native/metro');";
  const lines = text.split('\n');
  let lastRequire = -1;
  lines.forEach((line, i) => {
    if (/^\s*const .*=\s*require\(/.test(line)) lastRequire = i;
  });
  lines.splice(lastRequire + 1, 0, require);
  return lines.join('\n').replace(exportLine, (_, value: string) => `module.exports = withZharpConfig(${value.trim().replace(/;$/, '')});`);
}

/** The Zharp.init call, with the app's key (it can only send, so it is safe in the app). */
function initBlock(c: Connected, api: string, typescript: boolean): string {
  void typescript;
  const endpoint = endpointOf(api);
  return [
    "// The app's key can only send data to this app, so it is safe in the app.",
    'Zharp.init({',
    `  key: '${c.application.ingestKey}',`,
    `  service: '${c.application.serviceName}',`,
    ...(endpoint ? [`  endpoint: '${endpoint}',`] : []),
    '});',
  ].join('\n');
}

/** `block` (and an import) after a file's leading imports. */
function afterImports(text: string, imports: string[], block: string): string {
  const lines = text.split('\n');
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^import\b/.test(line)) {
      last = i;
      // A multi-line import runs on to its "from '…';".
      while (last < lines.length - 1 && !/from\s+['"][^'"]+['"];?\s*$|^import\s+['"][^'"]+['"];?\s*$/.test(lines[last].trim())) last++;
      i = last;
    } else if (line && !line.startsWith('//') && !line.startsWith('/*') && !line.startsWith('*') && !line.startsWith("'use") && !line.startsWith('"use')) break;
  }
  const missing = imports.filter((i) => !text.includes(i));
  lines.splice(last + 1, 0, ...missing, ...(block ? ['', block] : []));
  return lines.join('\n');
}

/** Expo Router's root layout with Zharp started and its screens followed. */
function editRootLayout(text: string, c: Connected, api: string, typescript: boolean): string | null {
  if (text.includes('@zharp/react-native')) return null;
  const fn = /export default function (\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\n/.exec(text);
  if (!fn) return null;
  let out = afterImports(text, ["import { Zharp, useZharpNavigation } from '@zharp/react-native';"], initBlock(c, api, typescript));
  if (!/import\s*\{[^}]*\buseNavigationContainerRef\b[^}]*\}\s*from\s*['"]expo-router['"]/.test(out)) {
    // Into the file's own `import { … } from 'expo-router'` when it has one.
    const existing = /import\s*\{([^}]*)\}\s*from\s*(['"])expo-router\2;?/.exec(out);
    out = existing
      ? out.replace(existing[0], existing[0].replace(`{${existing[1]}}`, `{${existing[1].replace(/\s*$/, '')}, useNavigationContainerRef }`))
      : afterImports(out, ["import { useNavigationContainerRef } from 'expo-router';"], '');
  }
  const again = /export default function (\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\n/.exec(out)!;
  return out.replace(again[0], `${again[0]}  // Each screen the app shows, with the requests it made.\n  useZharpNavigation(useNavigationContainerRef());\n`);
}

function gitIgnores(dir: string, file: string): boolean {
  const ignore = read(dir, '.gitignore') ?? '';
  const lines = ignore.split('\n').map((l) => l.trim());
  const name = file.split('/').pop()!;
  return lines.some((l) => l === file || l === `/${file}` || l === name || l === `*.${name.split('.').pop()}` || (l === '.env*.local' && /^\.env.*\.local$/.test(name)) || (l === '.xcode.env.local' && name === '.xcode.env.local'));
}

// ── the recipes ──────────────────────────────────────────────────────────────

function metroChange(project: Project, plan: Plan, expo: boolean): void {
  const dir = project.dir;
  const path = first(dir, ['metro.config.js', 'metro.config.cjs']);
  if (!path) {
    if (expo) {
      plan.changes.push({
        path: 'metro.config.js', kind: 'create', note: 'Expo’s config, with release bundles stamped for readable errors',
        content: [
          "const { getDefaultConfig } = require('expo/metro-config');",
          "const { withZharpConfig } = require('@zharp/react-native/metro');",
          '',
          'module.exports = withZharpConfig(getDefaultConfig(__dirname));',
          '',
        ].join('\n'),
      });
    } else {
      plan.manual.push({ path: 'metro.config.js', why: 'wrap its config so release errors are readable', snippet: "const { withZharpConfig } = require('@zharp/react-native/metro');\nmodule.exports = withZharpConfig(config);" });
    }
    return;
  }
  const text = read(dir, path)!;
  const wrapped = wrapMetroConfig(text);
  if (wrapped) plan.changes.push({ path, kind: 'edit', content: wrapped, note: 'release bundles stamped for readable errors' });
  else if (!text.includes('withZharpConfig')) plan.manual.push({ path, why: 'wrap what it exports so release errors are readable', snippet: "const { withZharpConfig } = require('@zharp/react-native/metro');\nmodule.exports = withZharpConfig(/* your config */);" });
}

function expo(project: Project, c: Connected, api: string): Plan {
  const plan = emptyPlan();
  const dir = project.dir;
  plan.install = ['@zharp/react-native'];
  metroChange(project, plan, true);

  // The config plugin, in app.json (an app.config.js/ts is code: shown, not edited).
  const appJson = read(dir, 'app.json');
  if (appJson && !first(dir, ['app.config.js', 'app.config.ts'])) {
    try {
      const config = JSON.parse(appJson);
      const root = config.expo ?? config;
      const plugins: unknown[] = Array.isArray(root.plugins) ? root.plugins : [];
      if (!plugins.some((p) => (Array.isArray(p) ? p[0] : p) === '@zharp/react-native')) {
        root.plugins = [...plugins, '@zharp/react-native'];
        plan.changes.push({ path: 'app.json', kind: 'edit', content: `${JSON.stringify(config, null, 2)}\n`, note: 'the config plugin: builds upload their source maps' });
      }
    } catch {
      plan.manual.push({ path: 'app.json', why: 'add the config plugin', snippet: '"plugins": ["@zharp/react-native"]' });
    }
  } else {
    plan.manual.push({ path: 'app.config', why: 'add the config plugin', snippet: "plugins: ['@zharp/react-native']" });
  }

  // Started first: the root layout (Expo Router, with its screens), else the entry file.
  const layout = first(dir, ['app/_layout.tsx', 'app/_layout.jsx', 'app/_layout.js', 'src/app/_layout.tsx', 'src/app/_layout.jsx']);
  const entry = (() => {
    const main = project.packageJson?.main;
    if (typeof main === 'string' && !main.includes('expo-router') && existsSync(join(dir, main))) return main;
    return first(dir, ['index.ts', 'index.tsx', 'index.js', 'App.tsx', 'App.js']);
  })();
  if (layout) {
    const edited = editRootLayout(read(dir, layout)!, c, api, project.typescript);
    if (edited) plan.changes.push({ path: layout, kind: 'edit', content: edited, note: 'starts Zharp; screens from Expo Router' });
  } else if (entry) {
    const text = read(dir, entry)!;
    if (!text.includes('@zharp/react-native')) {
      plan.changes.push({ path: entry, kind: 'edit', content: afterImports(text, ["import { Zharp } from '@zharp/react-native';"], initBlock(c, api, project.typescript)), note: 'starts Zharp' });
    }
  } else {
    plan.manual.push({ path: 'your entry file', why: 'start Zharp before the app renders', snippet: `import { Zharp } from '@zharp/react-native';\n\n${initBlock(c, api, project.typescript)}` });
  }

  // The upload key: .env.local for local builds (expo run), EAS secrets for EAS Build.
  plan.env = { file: '.env.local', vars: { ZHARP_AUTH_TOKEN: c.uploadKey, ZHARP_APP: String(c.application.id), ...(endpointOf(api) ? { ZHARP_URL: api.replace(/\/+$/, '') } : {}) } };
  plan.notes.push(`EAS Build: add the upload key as secrets — eas env:create --name ZHARP_AUTH_TOKEN --value <the key in .env.local> --visibility secret, and ZHARP_APP=${c.application.id}.`);
  plan.notes.push('EAS Update: after eas update (or npx expo export --source-maps), upload with npx zharp react-native upload --dir dist.');
  return plan;
}

function reactNative(project: Project, c: Connected, api: string): Plan {
  const plan = emptyPlan();
  const dir = project.dir;
  plan.install = ['@zharp/react-native'];
  metroChange(project, plan, false);

  const entry = first(dir, ['index.js', 'index.ts', 'index.tsx']);
  if (entry) {
    const text = read(dir, entry)!;
    if (!text.includes('@zharp/react-native')) {
      plan.changes.push({ path: entry, kind: 'edit', content: afterImports(text, ["import { Zharp } from '@zharp/react-native';"], initBlock(c, api, project.typescript)), note: 'starts Zharp, before the app registers' });
    }
  }
  plan.notes.push('Screens: useZharpNavigation(navigationRef) next to your NavigationContainer (React Navigation).');

  // Android: zharp.gradle after React Native's plugin; the upload key in local.properties.
  const gradle = read(dir, 'android/app/build.gradle');
  if (gradle !== null) {
    const edited = addGradleLine(gradle);
    if (edited !== gradle) plan.changes.push({ path: 'android/app/build.gradle', kind: 'edit', content: edited, note: 'release builds upload their source map' });
    const local = read(dir, 'android/local.properties') ?? '';
    if (!/^zharp\.authToken=/m.test(local)) {
      const lines = [`zharp.authToken=${c.uploadKey}`, `zharp.appId=${c.application.id}`];
      plan.changes.push({ path: 'android/local.properties', kind: local ? 'edit' : 'create', content: `${local.replace(/\s*$/, local ? '\n' : '')}${lines.join('\n')}\n`, note: 'the upload key (git ignores this file)' });
      if (!gitIgnores(dir, 'android/local.properties') && !gitIgnores(join(dir, 'android'), 'local.properties')) plan.notes.push('android/local.properties holds the upload key: make sure git ignores it.');
    }
  }

  // iOS: the bundle phase wired; the upload key in ios/.xcode.env.local.
  const ios = existsSync(join(dir, 'ios')) ? readdirSync(join(dir, 'ios')).find((name) => name.endsWith('.xcodeproj')) : undefined;
  if (ios) {
    const path = `ios/${ios}/project.pbxproj`;
    const text = read(dir, path);
    const wired = text ? wireXcodeProject(text) : null;
    if (wired) plan.changes.push({ path, kind: 'edit', content: wired, note: 'the bundle phase writes and uploads its source map' });
    const envLocal = read(dir, 'ios/.xcode.env.local') ?? '';
    if (!/ZHARP_AUTH_TOKEN=/.test(envLocal)) {
      const lines = [`export ZHARP_AUTH_TOKEN=${c.uploadKey}`, `export ZHARP_APP=${c.application.id}`, ...(endpointOf(api) ? [`export ZHARP_URL=${api.replace(/\/+$/, '')}`] : [])];
      plan.changes.push({ path: 'ios/.xcode.env.local', kind: envLocal ? 'edit' : 'create', content: `${envLocal.replace(/\s*$/, envLocal ? '\n' : '')}${lines.join('\n')}\n`, note: 'the upload key (git ignores this file)' });
    }
  }
  if (endpointOf(api) && gradle !== null) plan.notes.push(`Android builds upload to ${api}: set ZHARP_URL=${api.replace(/\/+$/, '')} when building.`);
  plan.notes.push('CI: set ZHARP_AUTH_TOKEN (the upload key) and ZHARP_APP for release builds.');
  return plan;
}

export function reactNativePlanFor(project: Project, c: Connected, api: string): Plan | null {
  if (project.framework === 'expo') return expo(project, c, api);
  if (project.framework === 'react-native') return reactNative(project, c, api);
  return null;
}
