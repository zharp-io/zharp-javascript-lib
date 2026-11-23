import { defineConfig } from 'tsup';

const noReplayRecorder = {
  name: 'no-replay-recorder',
  setup(build: any) {
    build.onResolve({ filter: /^\.\/recorder$/ }, () => ({ path: 'recorder', namespace: 'zharp-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'zharp-stub' }, () => ({ contents: 'export {};', loader: 'js' }));
  },
};

export default defineConfig([
  // The main process: Node. @zharp/node stays a dependency (its instrumentations must patch the
  // app's own copies of http and the drivers); Electron is the app's.
  {
    entry: { main: 'src/main/index.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    target: 'node22',
    platform: 'node',
    // __dirname and import.meta.url in both builds: the preload is found next to this file.
    shims: true,
    external: ['electron', '@zharp/node'],
    noExternal: [/^@zharp\/internal/],
  },
  // The preload: one CommonJS file that needs nothing but electron, so it runs in a sandboxed
  // preload (the default since Electron 20), which can't load other modules.
  {
    entry: { preload: 'src/preload/index.ts' },
    format: ['cjs'],
    dts: true,
    sourcemap: true,
    target: 'chrome120',
    platform: 'browser',
    external: ['electron'],
  },
  // Each window: @zharp/browser's internals bundled in (as @zharp/react-native does), sending
  // through the preload's bridge. No @zharp/browser to install, no rrweb.
  {
    entry: { renderer: 'src/renderer/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    target: 'chrome120',
    platform: 'browser',
    treeshake: true,
    define: { __ZHARP_CDN__: 'false' },
    // Session replay isn't offered in Electron yet (windows share one session, and replay numbers
    // its batches per session): the recorder, and rrweb with it, is left out.
    esbuildPlugins: [noReplayRecorder],
  },
  // The same for a page without a bundler: one script that starts itself (src/renderer/script.ts).
  {
    entry: { 'renderer.min': 'src/renderer/script.ts' },
    format: ['iife'],
    outExtension: () => ({ js: '.js' }),
    minify: true,
    sourcemap: true,
    target: 'chrome120',
    platform: 'browser',
    define: { __ZHARP_CDN__: 'false' },
    esbuildPlugins: [noReplayRecorder],
  },
]);
