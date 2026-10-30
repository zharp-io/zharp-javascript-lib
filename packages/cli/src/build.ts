/**
 * What every bundler plugin does once the build has written its files: inject debug IDs, upload
 * the files and their maps, and delete the maps so they are not deployed.
 */
import { resolveConnection, UploadError } from './api';
import type { Pattern } from './files';
import { consoleLogger, silentLogger, type Logger } from './log';
import { deleteSourcemaps, injectDirectory, uploadSourcemaps, type InjectedFile } from './sourcemaps';

export interface ZharpPluginOptions {
  /** The application's ID (the number in its dashboard URL). Default `ZHARP_APP`. */
  app?: string | number;
  /** File the upload under this release. Default `ZHARP_RELEASE`, or the commit SHA CI provides. */
  release?: string;
  /** A workspace API key with the `artifacts:write` scope. Default `ZHARP_AUTH_TOKEN`. */
  authToken?: string;
  /** The Zharp API. Default `ZHARP_URL`, or https://api.zharp.io. */
  url?: string;
  /** Only these output files (globs relative to the output directory, or regular expressions). */
  include?: Pattern;
  /** Not these output files. */
  exclude?: Pattern;
  /** Delete the .map files from the output once uploaded, so they are not deployed. Default true. */
  deleteSourcemapsAfterUpload?: boolean;
  /** Inject debug IDs and report what would be uploaded; upload and delete nothing. */
  dryRun?: boolean;
  /** Run on every build, not only production ones. */
  force?: boolean;
  /** Do nothing at all. */
  disabled?: boolean;
  /** Fail the build when the upload fails. Default false: a warning, and the build goes on. */
  failOnError?: boolean;
  /** No progress output (warnings still print). */
  silent?: boolean;
}

/** A release name from the options, the environment, or the commit SHA a CI system provides. */
export function defaultRelease(options: ZharpPluginOptions): string | undefined {
  const env = process.env;
  return (
    options.release ||
    env.ZHARP_RELEASE ||
    env.VERCEL_GIT_COMMIT_SHA ||
    env.GITHUB_SHA ||
    env.CI_COMMIT_SHA ||
    env.CF_PAGES_COMMIT_SHA ||
    env.COMMIT_REF ||
    env.RENDER_GIT_COMMIT ||
    undefined
  );
}

export function pluginLogger(name: string, options: ZharpPluginOptions): Logger {
  const base = consoleLogger(`[${name}]`);
  return options.silent ? { info: silentLogger.info, warn: base.warn } : base;
}

export interface ProcessBuildResult {
  injected: InjectedFile[];
  uploaded: boolean;
  deleted: string[];
}

/**
 * Inject, upload, delete — for the files a build just wrote to `dir` (or every file there when
 * `files` is not given).
 */
export async function processBuildOutput(
  dir: string,
  options: ZharpPluginOptions,
  context: { files?: string[]; logger?: Logger } = {},
): Promise<ProcessBuildResult> {
  const logger = context.logger ?? pluginLogger('zharp', options);
  const result: ProcessBuildResult = { injected: [], uploaded: false, deleted: [] };
  if (options.disabled) return result;

  result.injected = injectDirectory(dir, { files: context.files, include: options.include, exclude: options.exclude, dryRun: false, logger: quiet(logger) });
  if (result.injected.length === 0) return result;
  logger.info(`Injected debug IDs into ${result.injected.length} file(s) in ${dir}`);
  const release = defaultRelease(options);

  if (options.dryRun) {
    await uploadSourcemaps(dir, null, { files: result.injected.map((f) => f.file), release, dryRun: true, logger });
    return result;
  }

  try {
    const connection = resolveConnection(options);
    await uploadSourcemaps(dir, connection, { files: result.injected.map((f) => f.file), release, logger });
    result.uploaded = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.failOnError) throw error;
    logger.warn(`Source maps were not uploaded: ${message}${error instanceof UploadError && error.permanent ? '' : ' Errors from this build will show minified stacks.'}`);
  }

  // The maps go whether or not the upload worked: a deployed map is the source code, public.
  if (options.deleteSourcemapsAfterUpload !== false) {
    result.deleted = deleteSourcemaps(result.injected, { stripSourceMappingUrl: true });
    logger.info(`Deleted ${result.deleted.length} source map(s) from the output.`);
  }
  return result;
}

/** Per-file lines are noise inside a bundler's output: keep warnings only. */
function quiet(logger: Logger): Logger {
  return { info() {}, warn: (m) => logger.warn(m) };
}
