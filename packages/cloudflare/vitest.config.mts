import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

// The tests run inside workerd, the Workers runtime, with local D1, KV, R2, Queues and Durable
// Objects (Miniflare): the same runtime as `wrangler dev` and production.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './test/worker/wrangler.jsonc' } })],
  test: { include: ['test/**/*.test.ts'] },
});
