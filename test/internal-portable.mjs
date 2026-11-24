/**
 * internal/ is bundled into the browser, React Native and Cloudflare packages as well as the
 * Node one, so it must not import Node built-ins: a `node:` import there would break a Worker
 * or a page. (Node-only code reaches built-ins through loadBuiltin, at run time.)
 *
 *     node test/internal-portable.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'internal', 'src');
const NODE_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:[\w/]+|fs|path|os|crypto|http|https|zlib|url|util|stream|child_process|async_hooks)['"]/;
const offenders = readdirSync(dir)
  .filter((file) => file.endsWith('.ts'))
  // Comments may quote an import; only code counts.
  .filter((file) => NODE_IMPORT.test(readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '')));
if (offenders.length) {
  console.error(`internal/ must stay free of Node imports: ${offenders.join(', ')}`);
  process.exit(1);
}
console.log('internal/ has no Node imports');
