import { defineConfig } from 'tsup';

// React Native's Metro bundles the app; this is a library it consumes. React and React Native
// are the app's own; the browser SDK's internals (transport, tracer, XHR instrumentation, body
// and header capture) are bundled in from ../browser/src, so there is no @zharp/browser to install.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2020',
  platform: 'neutral',
  treeshake: true,
  external: ['react', 'react-native'],
});
