import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'node18',
    platform: 'node',
  },
  {
    // The `zharp` command: one CommonJS file, so it runs under any package type.
    entry: { cli: 'src/cli.ts' },
    format: ['cjs'],
    sourcemap: true,
    target: 'node18',
    platform: 'node',
  },
]);
