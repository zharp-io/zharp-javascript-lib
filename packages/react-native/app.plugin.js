/**
 * The Expo config plugin for @zharp/react-native: on `npx expo prebuild` (and EAS Build), the
 * native projects get what makes release errors readable — the build's source map uploaded to
 * Zharp, under the bundle's debug ID.
 *
 *     // app.json
 *     { "expo": { "plugins": ["@zharp/react-native"] } }
 *
 * - Android: app/build.gradle applies @zharp/react-native's zharp.gradle (uploads after each
 *   release bundle).
 * - iOS: the "Bundle React Native code and images" phase writes a source map (SOURCEMAP_FILE)
 *   and, after the bundle, runs ios/zharp-upload.sh.
 *
 * The upload needs ZHARP_AUTH_TOKEN and ZHARP_APP at build time (EAS: as secrets); without a token
 * the build says so and carries on. metro.config.js needs withZharpConfig from
 * @zharp/react-native/metro, which `npm init zharp@latest` adds.
 */
'use strict';

const pkg = require('./package.json');

function configPlugins() {
  for (const name of ['expo/config-plugins', '@expo/config-plugins']) {
    try {
      return require(name);
    } catch {
      // The next one.
    }
  }
  throw new Error('@zharp/react-native: the Expo config plugin needs expo (expo/config-plugins).');
}

const GRADLE_LINE =
  `apply from: new File(["node", "--print", "require.resolve('@zharp/react-native/package.json')"].execute(null, rootDir).text.trim(), "../zharp.gradle")`;

/** app/build.gradle with zharp.gradle applied after React Native's plugin (once). */
function addGradleLine(text) {
  if (text.includes('zharp.gradle')) return text;
  const anchor = /^apply plugin: ["']com\.facebook\.react["'][^\n]*$/m;
  if (anchor.test(text)) return text.replace(anchor, (line) => `${line}\n${GRADLE_LINE}`);
  return `${text.replace(/\s*$/, '')}\n\n${GRADLE_LINE}\n`;
}

/**
 * The bundle phase's script with a source map written (SOURCEMAP_FILE, unless the project sets
 * one already) and uploaded after the bundle. Works on React Native's and Expo's scripts alike.
 */
function wireBundlePhase(script) {
  if (script.includes('zharp-upload.sh')) return script;
  const sourceMap = 'export SOURCEMAP_FILE="${SOURCEMAP_FILE:-$DERIVED_FILE_DIR/main.jsbundle.map}"';
  const lines = script.split('\n');
  const at = lines[0].trim() === 'set -e' ? 1 : 0;
  lines.splice(at, 0, sourceMap);
  const upload = '/bin/bash "$PODS_ROOT/../../node_modules/@zharp/react-native/ios/zharp-upload.sh"';
  return `${lines.join('\n').replace(/\s*$/, '')}\n${upload}\n`;
}

function withZharpAndroid(config) {
  const { withAppBuildGradle, WarningAggregator } = configPlugins();
  return withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language === 'groovy') mod.modResults.contents = addGradleLine(mod.modResults.contents);
    else WarningAggregator.addWarningAndroid('@zharp/react-native', 'app/build.gradle is not Groovy: add zharp.gradle by hand (see the docs).');
    return mod;
  });
}

function withZharpIos(config) {
  const { withXcodeProject, WarningAggregator } = configPlugins();
  return withXcodeProject(config, (mod) => {
    const phases = mod.modResults.hash.project.objects.PBXShellScriptBuildPhase || {};
    let wired = false;
    for (const key of Object.keys(phases)) {
      const phase = phases[key];
      if (!phase || typeof phase !== 'object' || typeof phase.shellScript !== 'string') continue;
      const name = String(phase.name || '').replace(/^"|"$/g, '');
      if (name !== 'Bundle React Native code and images') continue;
      phase.shellScript = JSON.stringify(wireBundlePhase(JSON.parse(phase.shellScript)));
      wired = true;
    }
    if (!wired) WarningAggregator.addWarningIOS('@zharp/react-native', 'No "Bundle React Native code and images" phase found: the source map is not uploaded.');
    return mod;
  });
}

function withZharp(config) {
  return withZharpIos(withZharpAndroid(config));
}

let plugin = withZharp;
try {
  plugin = configPlugins().createRunOncePlugin(withZharp, pkg.name, pkg.version);
} catch {
  // Outside an Expo project (the helpers below are still usable).
}
module.exports = plugin;
module.exports.addGradleLine = addGradleLine;
module.exports.wireBundlePhase = wireBundlePhase;
