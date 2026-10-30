/**
 * @zharp/esbuild-plugin: after esbuild writes its output, inject debug IDs into the JS files and
 * their source maps, upload them to Zharp, and delete the maps from the output.
 *
 *     await esbuild.build({ entryPoints: ['src/app.ts'], bundle: true, outdir: 'dist',
 *       plugins: [zharpEsbuildPlugin({ app: 42 })] });
 */
import { dirname, resolve } from 'node:path';
import { pluginLogger, processBuildOutput, type ZharpPluginOptions } from '@zharp/cli';

export type { ZharpPluginOptions } from '@zharp/cli';

/** The parts of esbuild's plugin API this plugin uses (no dependency on esbuild's types). */
interface BuildOptions {
  sourcemap?: boolean | 'linked' | 'inline' | 'external' | 'both';
  metafile?: boolean;
  write?: boolean;
  outdir?: string;
  outfile?: string;
  absWorkingDir?: string;
}
interface BuildResult {
  errors: unknown[];
  metafile?: { outputs: Record<string, unknown> };
}
interface PluginBuild {
  initialOptions: BuildOptions;
  onEnd(callback: (result: BuildResult) => void | Promise<void>): void;
}

const JS = /\.(?:js|mjs|cjs)$/;

export function zharpEsbuildPlugin(options: ZharpPluginOptions = {}) {
  return {
    name: 'zharp',
    setup(build: PluginBuild): void {
      if (options.disabled) return;
      const initial = build.initialOptions;
      // External maps: written next to the files, not referenced from them.
      if (!initial.sourcemap) initial.sourcemap = 'external';
      // The metafile is how the plugin knows which files this build wrote.
      initial.metafile = true;
      const logger = pluginLogger('zharp', options);
      build.onEnd(async (result) => {
        if (result.errors.length || initial.write === false || !result.metafile) return;
        const cwd = initial.absWorkingDir ?? process.cwd();
        const dir = resolve(cwd, initial.outdir ?? (initial.outfile ? dirname(initial.outfile) : '.'));
        const files = Object.keys(result.metafile.outputs)
          .filter((name) => JS.test(name))
          .map((name) => resolve(cwd, name));
        await processBuildOutput(dir, options, { files, logger });
      });
    },
  };
}

export default zharpEsbuildPlugin;
