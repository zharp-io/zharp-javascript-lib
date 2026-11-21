/**
 * @zharp/vite-plugin: on `vite build` (production mode), emit hidden source maps, inject debug
 * IDs into the JS files and their maps, upload them to Zharp, and delete the maps from the output.
 *
 *     import { zharp } from '@zharp/vite-plugin';
 *     export default defineConfig({ plugins: [zharp({ app: 42 })] });
 */
import { dirname, join, resolve } from 'node:path';
import { pluginLogger, processBuildOutput, type ZharpPluginOptions } from '@zharp/cli';

export type { ZharpPluginOptions } from '@zharp/cli';

interface OutputOptions {
  dir?: string;
  file?: string;
}

interface UserConfig {
  build?: { sourcemap?: boolean | 'inline' | 'hidden' };
}

interface ResolvedConfig {
  command: 'build' | 'serve';
  mode: string;
  root: string;
}

const JS = /\.(?:js|mjs|cjs)$/;

export function zharp(options: ZharpPluginOptions = {}) {
  const logger = pluginLogger('zharp', options);
  let enabled = false;
  return {
    name: 'zharp',
    apply: 'build' as const,
    enforce: 'post' as const,
    config(config: UserConfig, env: { mode: string; command: string }): UserConfig | null {
      if (options.disabled || env.command !== 'build' || (env.mode !== 'production' && !options.force)) return null;
      // Maps are needed to upload; hidden ones are not referenced from the files.
      if (config.build?.sourcemap) return null;
      return { build: { sourcemap: 'hidden' } };
    },
    async configResolved(config: ResolvedConfig): Promise<void> {
      enabled = !options.disabled && config.command === 'build' && (config.mode === 'production' || options.force === true);
      if (!enabled) return;
      // Vite keeps .env files to itself (only VITE_* reach the app): ZHARP_AUTH_TOKEN and ZHARP_URL
      // written there by `zharp init` are read the way Vite reads them.
      try {
        // The app's own Vite (this package doesn't depend on it).
        const viteModule = 'vite';
        const vite: any = await import(viteModule);
        const env: Record<string, string> = vite.loadEnv?.(config.mode, config.root, 'ZHARP_') ?? {};
        for (const [key, value] of Object.entries(env)) if (process.env[key] === undefined) process.env[key] = value;
      } catch {
        // Not loadable here: the environment has to carry them.
      }
    },
    async writeBundle(output: OutputOptions, bundle: Record<string, unknown>): Promise<void> {
      if (!enabled) return;
      const dir = resolve(output.dir ?? (output.file ? dirname(output.file) : 'dist'));
      const files = Object.keys(bundle).filter((name) => JS.test(name)).map((name) => join(dir, name));
      await processBuildOutput(dir, options, { files, logger });
    },
  };
}

export const zharpVitePlugin = zharp;
export default zharp;
