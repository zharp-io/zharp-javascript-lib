import { defineConfig } from 'tsup';

// A Worker is capped at 3 MB (free plan) and pays for every byte at cold start, so this is
// minified and has one dependency, @opentelemetry/api, left to the app's bundle so every
// library in it shares one copy. The browser SDK's transport and helpers are bundled in from
// ../browser/src. node:async_hooks comes from the Worker's nodejs_compat flag.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: true,
  target: 'es2022',
  platform: 'neutral',
  treeshake: true,
  external: ['@opentelemetry/api', 'node:async_hooks'],
  // Workers resolve node:async_hooks; keep the prefix tsup would strip.
  removeNodeProtocol: false,
});
