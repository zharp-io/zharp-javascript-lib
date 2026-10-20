import { defineConfig } from 'tsup';

export default defineConfig({
  // Two bundles, deliberately. The recorder brings rrweb with it, so an application importing
  // only the logger must never have it linked in.
  entry: ['src/index.ts', 'src/replay.ts'],
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
});
