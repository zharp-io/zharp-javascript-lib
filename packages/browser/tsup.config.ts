import { defineConfig } from 'tsup';

const shared = {
  minify: true,
  sourcemap: true,
  // Every browser of the last several years; no polyfills.
  target: 'es2018',
  platform: 'browser' as const,
  treeshake: true,
};

export default defineConfig([
  // The npm package. The recorder is reached only through a dynamic import, and splitting turns
  // that into a chunk of its own: rrweb is fetched when a session records, never otherwise.
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    splitting: true,
    define: { __ZHARP_CDN__: 'false' },
  },
  // The script tag: one file exposing a global `Zharp`.
  {
    ...shared,
    entry: { zharp: 'src/cdn.ts' },
    format: ['iife'],
    outExtension: () => ({ js: '.min.js' }),
    define: { __ZHARP_CDN__: 'true' },
    // rrweb is parsed for this build and then dropped as dead code, but its license banner
    // would stay behind. Nothing of it ships here; zharp-replay.min.js keeps the notice.
    esbuildOptions(options) {
      options.legalComments = 'none';
    },
  },
  // …and the recorder it loads next to itself when a session records.
  {
    ...shared,
    entry: { 'zharp-replay': 'src/replay/cdn.ts' },
    format: ['iife'],
    outExtension: () => ({ js: '.min.js' }),
    define: { __ZHARP_CDN__: 'true' },
  },
]);
