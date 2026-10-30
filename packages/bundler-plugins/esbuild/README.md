# @zharp/esbuild-plugin

Readable stack traces for an esbuild build in [Zharp](https://zharp.io): it emits external source maps (unless `sourcemap` is set), injects debug IDs into the written JS files and their maps, uploads them, and deletes the maps from the output.

```bash
npm install --save-dev @zharp/esbuild-plugin
```

```js
import * as esbuild from 'esbuild';
import { zharpEsbuildPlugin } from '@zharp/esbuild-plugin';

await esbuild.build({
  entryPoints: ['src/app.ts'],
  bundle: true,
  minify: true,
  outdir: 'dist',
  plugins: [zharpEsbuildPlugin({ app: 42 })],
});
```

The plugin turns on `metafile` to know which files the build wrote, and does nothing with `write: false`. It runs on every build; use `disabled` to limit it.

Options: see the [bundler plugins overview](../README.md#options).

MIT © [Zharp](https://zharp.io)
