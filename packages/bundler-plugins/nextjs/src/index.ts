/**
 * @zharp/nextjs: `withZharp(nextConfig)` — readable stack traces for a Next.js app's browser and
 * server code. On `next build` it turns on source maps, injects debug IDs into the emitted
 * chunks (client and server), uploads them to Zharp and deletes the maps from `.next`.
 *
 *     // next.config.mjs
 *     import { withZharp } from '@zharp/nextjs';
 *     export default withZharp({ reactStrictMode: true }, { app: 42 });
 *
 * Next.js 15.4 and later (webpack or Turbopack): the work happens in Next's
 * `compiler.runAfterProductionCompile` hook, once the whole build is written. Older versions:
 * the webpack plugin runs in each of Next's compilers (client, server, edge).
 */
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pluginLogger, processBuildOutput, type ZharpPluginOptions } from '@zharp/cli';
import { ZharpWebpackPlugin } from '@zharp/webpack-plugin';

export type { ZharpPluginOptions } from '@zharp/cli';

export interface ZharpNextOptions extends ZharpPluginOptions {
  /**
   * Which hook to use. Default: `runAfterProductionCompile` where Next.js has it (15.4+),
   * the webpack plugin otherwise. Turbopack builds need the former.
   */
  hook?: 'runAfterProductionCompile' | 'webpack';
}

type NextConfigObject = Record<string, any>;
type NextConfigFunction = (phase: string, context: { defaultConfig: NextConfigObject }) => NextConfigObject | Promise<NextConfigObject>;
export type NextConfig = NextConfigObject | NextConfigFunction;

/** The Next.js version the app has installed, as [major, minor, patch], or undefined. */
export function installedNextVersion(cwd = process.cwd()): [number, number, number] | undefined {
  try {
    const version: string = createRequire(join(cwd, 'package.json'))('next/package.json').version;
    const [major, minor, patch] = version.split(/[.-]/).map((n) => parseInt(n, 10));
    return [major || 0, minor || 0, patch || 0];
  } catch {
    return undefined;
  }
}

function supportsRunAfterProductionCompile(version: [number, number, number] | undefined): boolean {
  if (!version) return false;
  const [major, minor, patch] = version;
  return major > 15 || (major === 15 && (minor > 4 || (minor === 4 && patch >= 1)));
}

/** The config with Zharp's build steps. Accepts and returns either form of Next.js config. */
export function withZharp<T extends NextConfig>(nextConfig: T = {} as T, options: ZharpNextOptions = {}): T {
  if (typeof nextConfig === 'function') {
    return (async (phase: string, context: { defaultConfig: NextConfigObject }) =>
      apply(await (nextConfig as NextConfigFunction)(phase, context), options)) as unknown as T;
  }
  return apply(nextConfig as NextConfigObject, options) as T;
}

function apply(config: NextConfigObject, options: ZharpNextOptions): NextConfigObject {
  if (options.disabled) return config;
  const hook = options.hook ?? (supportsRunAfterProductionCompile(installedNextVersion()) ? 'runAfterProductionCompile' : 'webpack');
  const out: NextConfigObject = {
    ...config,
    // Browser maps are needed to upload; they are deleted from the output afterwards (and the
    // comments pointing at them removed).
    productionBrowserSourceMaps: true,
    experimental: { ...config.experimental, serverSourceMaps: true },
  };

  if (hook === 'runAfterProductionCompile') {
    const previous = config.compiler?.runAfterProductionCompile;
    out.compiler = {
      ...config.compiler,
      async runAfterProductionCompile(context: { distDir: string; projectDir: string }) {
        if (previous) await previous(context);
        const distDir = resolve(context.projectDir ?? process.cwd(), context.distDir ?? '.next');
        await processBuildOutput(distDir, { ...options, include: options.include ?? ['static/**', 'server/**'] }, { logger: pluginLogger('zharp', options) });
      },
    };
    return out;
  }

  const previous = config.webpack;
  out.webpack = (webpackConfig: any, context: { dev: boolean; isServer: boolean }) => {
    const result = typeof previous === 'function' ? previous(webpackConfig, context) : webpackConfig;
    if (!context.dev) {
      result.devtool = 'hidden-source-map';
      result.plugins = [...(result.plugins ?? []), new ZharpWebpackPlugin({ ...options, keepDevtool: true })];
    }
    return result;
  };
  return out;
}

export default withZharp;
