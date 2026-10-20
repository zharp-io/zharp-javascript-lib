import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  minify: true,
  sourcemap: true,
  // The recorder is reached only through a dynamic import, and splitting is what turns that
  // into a chunk of its own: rrweb is loaded when replay starts, never by a bundle without it.
  // On for the CommonJS build too, so `require('@zharp/apm')` does not load rrweb either.
  splitting: true,
  // ES2017 is supported by all modern browsers and Node 8+.
  target: 'es2017',
  // neutral platform means the same bundle works in browser and Node.js.
  platform: 'neutral',
  treeshake: true,
  // The shared internals are compiled into this package; there is no @zharp/internal on npm.
  noExternal: [/^@zharp\/internal/],
});
