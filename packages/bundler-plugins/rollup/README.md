# @zharp/rollup-plugin

Readable stack traces for a Rollup build in [Zharp](https://zharp.io): it emits hidden source maps (unless `output.sourcemap` is set), injects debug IDs into the written JS files and their maps, uploads them, and deletes the maps from the output.

```bash
npm install --save-dev @zharp/rollup-plugin
```

```js
// rollup.config.mjs
import { zharpRollupPlugin } from '@zharp/rollup-plugin';

export default {
  input: 'src/main.js',
  output: { dir: 'dist', format: 'es' },
  plugins: [zharpRollupPlugin({ app: 42 })],
};
```

Rollup has no production mode: the plugin runs on every `rollup` build that writes files. Use `disabled: process.env.NODE_ENV !== 'production'` to limit it.

Options: see the [bundler plugins overview](../README.md#options).

MIT © [Zharp](https://zharp.io)
