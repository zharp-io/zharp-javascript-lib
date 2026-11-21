/**
 * @zharp/react-native/metro: a debug ID in every release bundle, so errors from it read as the
 * app's own source once its source map is uploaded.
 *
 *     // metro.config.js
 *     const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
 *     const { withZharpConfig } = require('@zharp/react-native/metro');
 *     module.exports = withZharpConfig(mergeConfig(getDefaultConfig(__dirname), {}));
 *
 * The serializer the app already has (Expo's, another tool's) or Metro's own makes the bundle;
 * this puts two statements at the start of its first line, which holds only Metro's prelude, so
 * no mapped position moves:
 *
 * - the bundle registers its debug ID the way every Zharp bundle does (a stack captured inside the
 *   file, keyed to the ID), so an error carries `zharp.debug_ids`;
 * - `zharp-debug-id:<id>` as a string: Hermes keeps it in the bytecode, where the upload step
 *   (`zharp react-native upload`) reads it back to file the build's source map under it.
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
  throw new Error(`@zharp/react-native/metro: Metro's ${name} was not found`);
}

/** A UUID-shaped ID from the bundle's code: the same build gets the same ID. */
function debugIdOf(code) {
  const hex = crypto.createHash('sha256').update(code).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function prelude(id) {
  return (
    `var __zharpDebugIdMarker="zharp-debug-id:${id}";` +
    `(globalThis.__zharpDebugIds=globalThis.__zharpDebugIds||{})[new Error().stack]="${id}";`
  );
}

/** The Metro config with Zharp's serializer around the one it had (or Metro's own). */
function withZharpConfig(config) {
  const serializer = (config && config.serializer) || {};
  const base = serializer.customSerializer;
  const customSerializer = async (entryPoint, preModules, graph, options) => {
    let result;
    if (base) {
      result = await base(entryPoint, preModules, graph, options);
    } else {
      const baseJSBundle = metroInternal('DeltaBundler/Serializers/baseJSBundle');
      const bundleToString = metroInternal('lib/bundleToString');
      result = bundleToString(baseJSBundle(entryPoint, preModules, graph, options)).code;
    }
    const code = typeof result === 'string' ? result : result.code;
    const id = debugIdOf(code);
    if (typeof result === 'string') return prelude(id) + code;
    let map = result.map;
    if (map) {
      try {
        map = JSON.stringify({ ...(typeof map === 'string' ? JSON.parse(map) : map), debugId: id });
      } catch {
        // A map we can't read stays as it was; the upload step finds the ID in the bundle.
      }
    }
    return { ...result, code: prelude(id) + code, map };
  };
  return { ...config, serializer: { ...serializer, customSerializer } };
}

module.exports = { withZharpConfig, debugIdOf };
