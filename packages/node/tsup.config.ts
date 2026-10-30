import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // Node 22.15 is what the OpenTelemetry SDK itself requires.
  target: 'node22',
  platform: 'node',
  // `import.meta.url` (for the ES module loader hook) in the CommonJS build too.
  shims: true,
  // OpenTelemetry stays a dependency, not bundled: the instrumentations patch the modules the
  // application loads, and they must be the same copies the application's other OTel code sees.
  // The shared internals are compiled in; there is no @zharp/internal on npm.
  noExternal: [/^@zharp\/internal/],
});
