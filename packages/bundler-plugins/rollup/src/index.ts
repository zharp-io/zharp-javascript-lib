/**
 * @zharp/rollup-plugin: after Rollup writes a bundle, inject debug IDs into its JS files and
 * their source maps, upload them to Zharp, and delete the maps from the output.
 *
 *     import { zharpRollupPlugin } from '@zharp/rollup-plugin';
 *     export default { output: { dir: 'dist' }, plugins: [zharpRollupPlugin({ app: 42 })] };
 */
import { dirname, join, resolve } from 'node:path';
import { pluginLogger, processBuildOutput, type ZharpPluginOptions } from '@zharp/cli';

export type { ZharpPluginOptions } from '@zharp/cli';

/** The parts of Rollup's output options and bundle this plugin reads (no dependency on rollup's types). */
interface OutputOptions {
  dir?: string;
  file?: string;
  sourcemap?: boolean | 'inline' | 'hidden';
}

const JS = /\.(?:js|mjs|cjs)$/;

/** The JS files a `writeBundle` call wrote, as absolute paths, and the directory they are in. */
export function writtenFiles(output: OutputOptions, bundle: Record<string, unknown>): { dir: string; files: string[] } {
  const dir = resolve(output.dir ?? (output.file ? dirname(output.file) : 'dist'));
  return { dir, files: Object.keys(bundle).filter((name) => JS.test(name)).map((name) => join(dir, name)) };
}

export function zharpRollupPlugin(options: ZharpPluginOptions = {}) {
  const logger = pluginLogger('zharp', options);
  return {
    name: 'zharp',
    /** Hidden source maps unless the config asks for maps itself: emitted, but not referenced from the files. */
    outputOptions(output: OutputOptions): OutputOptions | null {
      if (options.disabled || output.sourcemap) return null;
      return { ...output, sourcemap: 'hidden' };
    },
    async writeBundle(output: OutputOptions, bundle: Record<string, unknown>): Promise<void> {
      if (options.disabled) return;
      const { dir, files } = writtenFiles(output, bundle);
      await processBuildOutput(dir, options, { files, logger });
    },
  };
}

export default zharpRollupPlugin;
