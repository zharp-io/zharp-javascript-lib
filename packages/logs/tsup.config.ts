import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  minify: true,
  sourcemap: true,
  // ES2017 is supported by all modern browsers and Node 8+.
  // Keeps the bundle small without needing a polyfill layer.
  target: 'es2017',
  // neutral platform means the same bundle works in browser and Node.js.
  platform: 'neutral',
  treeshake: true,
  // The shared internals are compiled into this package, never imported from a package of
  // their own: there is no @zharp/internal on npm.
  noExternal: [/^@zharp\/internal/],
});
