# @zharp/vite-plugin

Readable stack traces for a Vite app in [Zharp](https://zharp.io): on `vite build` (production mode) it emits hidden source maps, injects debug IDs into the JS files and their maps, uploads them, and deletes the maps from `dist`.

```bash
npm install --save-dev @zharp/vite-plugin
```

```js
// vite.config.js
import { defineConfig } from 'vite';
import { zharp } from '@zharp/vite-plugin';

export default defineConfig({
  plugins: [zharp({ app: 42 })],
});
```

Set `ZHARP_AUTH_TOKEN` (a workspace API key with the `artifacts:write` scope) in CI. If your config already sets `build.sourcemap`, it is kept; otherwise the plugin sets `'hidden'`. SSR builds are handled the same way.

Options (`release`, `include`, `exclude`, `deleteSourcemapsAfterUpload`, `dryRun`, …): see the [bundler plugins overview](../README.md#options).

MIT © [Zharp](https://zharp.io)
