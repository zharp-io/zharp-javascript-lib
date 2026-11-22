/**
 * What @zharp/cloudflare adds to a Worker: the built package and @opentelemetry/api, bundled
 * and minified the way Wrangler does it. The budget is 40 KB; over it, this exits non-zero.
 *
 *     pnpm --filter @zharp/cloudflare build && pnpm --filter @zharp/cloudflare size
 *     node scripts/size.mjs --why     # the largest inputs
 */
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BUDGET = 40 * 1024;
const result = await build({
  stdin: {
    contents: "import { withZharp, instrumentDurableObject, zharpPagesPlugin, Zharp } from '@zharp/cloudflare'; globalThis.x = [withZharp, instrumentDurableObject, zharpPagesPlugin, Zharp];",
    resolveDir: join(here, '..'),
  },
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'import'],
  external: ['node:*'],
  write: false,
  metafile: true,
  alias: { '@zharp/cloudflare': join(here, '..', 'dist', 'index.mjs') },
});
const code = result.outputFiles[0].contents;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`@zharp/cloudflare in a Worker: ${kb(code.length)} minified, ${kb(gzipSync(code).length)} gzipped (budget ${kb(BUDGET)} minified)`);
if (process.argv.includes('--why')) {
  const inputs = Object.entries(Object.values(result.metafile.outputs)[0].inputs).sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput);
  for (const [file, { bytesInOutput }] of inputs.slice(0, 25)) console.log(`  ${kb(bytesInOutput).padStart(9)}  ${file}`);
}
if (code.length > BUDGET) {
  console.error('Over budget.');
  process.exitCode = 1;
}
