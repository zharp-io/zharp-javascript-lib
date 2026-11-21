/**
 * @zharp/react-native/metro: a debug ID in every release bundle, so errors from it read as the
 * app's own source once its source map is uploaded.
 *
 *     // metro.config.js (React Native)
 *     const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
 *     const { withZharpConfig } = require('@zharp/react-native/metro');
 *     module.exports = withZharpConfig(mergeConfig(getDefaultConfig(__dirname), {}));
 *
 *     // metro.config.js (Expo)
 *     const { getDefaultConfig } = require('expo/metro-config');
 *     const { withZharpConfig } = require('@zharp/react-native/metro');
 *     module.exports = withZharpConfig(getDefaultConfig(__dirname));
 *
 * The bundle gets one more module, run before all others, that
 * - registers the bundle's debug ID the way every Zharp bundle does (a stack captured inside the
 *   file, keyed to the ID), so an error carries `zharp.debug_ids`;
 * - holds `zharp-debug-id:<id>` as a string, which Hermes keeps in the bytecode, where the upload
 *   step (`zharp react-native upload`) reads it back to file the source map under it.
 *
 * Being a module, it goes through whatever serializer the app has (Expo's, which may compile to
 * Hermes itself, or Metro's own) and is in the source map like any other. The ID comes from the
 * module graph — the same code gets the same ID — and is written into the map(s) the serializer
 * returns.
 */
'use strict';

const crypto = require('crypto');

/** A Metro internal: `metro/private/*` from Metro 0.82, `metro/src/*` before. */
function metroInternal(name) {
  for (const path of [`metro/private/${name}`, `metro/src/${name}`]) {
    try {
      const value = require(path);
      return value && value.default ? value.default : value;
    } catch (error) {
      if (error && error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
    }
  }
  return null;
}

/** UUID-shaped, from a hash. */
function uuidOf(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The debug ID of a build: its modules (path and transformed code), in a stable order. */
function debugIdOf(preModules, graph) {
  const hash = crypto.createHash('sha256');
  const modules = [...preModules, ...graph.dependencies.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const module of modules) {
    hash.update(module.path);
    for (const output of module.output || []) hash.update(String(output && output.data && output.data.code));
  }
  return uuidOf(hash.digest('hex'));
}

const MODULE_PATH = '__zharp_debug_id__';

function debugIdCode(id) {
  return (
    `var __zharpDebugIdMarker="zharp-debug-id:${id}";` +
    `(globalThis.__zharpDebugIds=globalThis.__zharpDebugIds||{})[new Error().stack]="${id}";`
  );
}

/** A module Metro runs before all others (like its polyfills), with no source of its own. */
function debugIdModule(id) {
  const code = debugIdCode(id);
  const CountingSet = metroInternal('lib/CountingSet');
  return {
    path: MODULE_PATH,
    dependencies: new Map(),
    inverseDependencies: CountingSet ? new CountingSet() : new Set(),
    getSource: () => Buffer.from(code),
    output: [{ type: 'js/script/virtual', data: { code, lineCount: 1, map: [] } }],
  };
}

/** A source map (text) with the debug ID in it; unchanged when it isn't one. */
function withDebugId(map, id) {
  if (typeof map !== 'string') return map;
  try {
    return JSON.stringify({ ...JSON.parse(map), debugId: id });
  } catch {
    return map;
  }
}

/** The serializer's result with every source map in it carrying the ID, in the shape it came. */
function stamp(result, id) {
  if (!result || typeof result === 'string') return result;
  // Expo's export: { artifacts: [{ filename, type: 'js' | 'map', source }], assets }, or the artifacts alone.
  const artifacts = Array.isArray(result) ? result : Array.isArray(result.artifacts) ? result.artifacts : null;
  if (artifacts) {
    for (const artifact of artifacts) if (artifact && artifact.type === 'map') artifact.source = withDebugId(artifact.source, id);
    return result;
  }
  if ('map' in result) return { ...result, map: withDebugId(result.map, id) };
  return result;
}

/** The Metro config with Zharp's debug-ID module added, around the serializer it had (or Metro's own). */
function withZharpConfig(config) {
  const serializer = (config && config.serializer) || {};
  const base = serializer.customSerializer;
  const customSerializer = async (entryPoint, preModules, graph, options) => {
    // Development builds are served by Metro and read through its own source maps.
    const dev = graph && graph.transformOptions && graph.transformOptions.dev;
    if (dev) {
      if (base) return base(entryPoint, preModules, graph, options);
      return defaultSerialize(entryPoint, preModules, graph, options);
    }
    const id = debugIdOf(preModules, graph);
    const modules = [debugIdModule(id), ...preModules.filter((m) => m.path !== MODULE_PATH)];
    const result = base ? await base(entryPoint, modules, graph, options) : defaultSerialize(entryPoint, modules, graph, options);
    // An Expo export may hand back JSON text of its artifacts.
    if (typeof result === 'string' && result.startsWith('[{')) {
      try {
        const parsed = JSON.parse(result);
        if (Array.isArray(parsed) && parsed.every((a) => a && typeof a.filename === 'string')) return JSON.stringify(stamp(parsed, id));
      } catch {
        // Bundle code that happens to start with "[{": as it is.
      }
    }
    return stamp(result, id);
  };
  return { ...config, serializer: { ...serializer, customSerializer } };
}

/**
 * Metro's own serialization, as its Server does without a custom serializer — and the source map
 * of the same modules (Metro would otherwise map without the debug-ID module, a line off).
 */
function defaultSerialize(entryPoint, preModules, graph, options) {
  const baseJSBundle = metroInternal('DeltaBundler/Serializers/baseJSBundle');
  const bundleToString = metroInternal('lib/bundleToString');
  if (!baseJSBundle || !bundleToString) throw new Error("@zharp/react-native/metro: Metro's serializer was not found");
  const code = bundleToString(baseJSBundle(entryPoint, preModules, graph, options)).code;
  if (!preModules.some((m) => m.path === MODULE_PATH)) return code;
  const maps = metroInternal('DeltaBundler/Serializers/sourceMapString');
  const sourceMapString = maps && (maps.sourceMapString || maps);
  if (typeof sourceMapString !== 'function') return code;
  const sorted = [...graph.dependencies.values()].sort((a, b) => options.createModuleId(a.path) - options.createModuleId(b.path));
  const map = sourceMapString([...preModules, ...sorted], {
    excludeSource: Boolean(options.serializerOptions && options.serializerOptions.excludeSource),
    processModuleFilter: options.processModuleFilter,
    shouldAddToIgnoreList: options.shouldAddToIgnoreList,
  });
  return { code, map };
}

module.exports = { withZharpConfig, debugIdOf };
