/**
 * @zharp/webpack-plugin: on production builds, emit hidden source maps, inject debug IDs into the
 * emitted JS files and their maps, upload them to Zharp, and delete the maps from the output.
 *
 *     const { ZharpWebpackPlugin } = require('@zharp/webpack-plugin');
 *     module.exports = { mode: 'production', plugins: [new ZharpWebpackPlugin({ app: 42 })] };
 */
import { join } from 'node:path';
import { pluginLogger, processBuildOutput, type ZharpPluginOptions } from '@zharp/cli';

export type { ZharpPluginOptions } from '@zharp/cli';

/** The parts of webpack's Compiler and Compilation this plugin uses (no dependency on webpack's types). */
interface Compilation {
  outputOptions: { path?: string };
  getAssets(): ReadonlyArray<{ name: string }>;
  errors: unknown[];
}
interface Compiler {
  options: { mode?: string; devtool?: string | false };
  hooks: { afterEmit: { tapPromise(name: string, fn: (compilation: Compilation) => Promise<void>): void } };
}

const JS = /\.(?:js|mjs|cjs)$/;
const NAME = 'ZharpWebpackPlugin';

export interface ZharpWebpackPluginOptions extends ZharpPluginOptions {
  /** Leave `devtool` as configured. By default an unset or `false` devtool becomes `hidden-source-map`. */
  keepDevtool?: boolean;
}

export class ZharpWebpackPlugin {
  constructor(private readonly options: ZharpWebpackPluginOptions = {}) {}

  apply(compiler: Compiler): void {
    const options = this.options;
    // webpack's own default when no mode is set is production.
    const production = (compiler.options.mode ?? 'production') === 'production';
    if (options.disabled || (!production && !options.force)) return;
    // Plugins are applied before webpack fills in its defaults and sets up source maps, so an
    // unset devtool can still be chosen here.
    if (!options.keepDevtool && !compiler.options.devtool) compiler.options.devtool = 'hidden-source-map';
    const logger = pluginLogger('zharp', options);
    compiler.hooks.afterEmit.tapPromise(NAME, async (compilation) => {
      if (compilation.errors.length) return;
      const dir = compilation.outputOptions.path;
      if (!dir) return;
      const files = compilation
        .getAssets()
        .map((asset) => asset.name.split('?')[0])
        .filter((name) => JS.test(name))
        .map((name) => join(dir, name));
      await processBuildOutput(dir, options, { files, logger });
    });
  }
}

export const zharpWebpackPlugin = (options?: ZharpWebpackPluginOptions) => new ZharpWebpackPlugin(options);
export default ZharpWebpackPlugin;
