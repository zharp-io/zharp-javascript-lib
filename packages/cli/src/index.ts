/**
 * @zharp/cli as a library: what the `zharp` command and the bundler plugins are made of.
 */
export { DEFAULT_URL, UploadError, artifactsUrl, resolveConnection, uploadArtifact, type Artifact, type ArtifactKind, type Connection } from './api';
export { DEBUG_ID_COMMENT, debugIdFromContent, existingDebugId, injectCode, injectMap, registrationSnippet, withoutSourceMappingUrl } from './debug-id';
export { readElf, type ElfInfo } from './elf';
export { globToRegExp, pathFilter, type Pattern } from './files';
export { consoleLogger, silentLogger, type Logger } from './log';
export { readMachO, type MachOImage } from './macho';
export { findDartSymbols, findDsymImages, findObfuscationMap, type DartSymbolsUploadOptions, uploadDartSymbols, uploadDsyms, uploadProguard, type NativeUploadOptions } from './native';
export {
  deleteSourcemaps,
  findSourceFiles,
  injectDirectory,
  mapFor,
  uploadSourcemaps,
  type InjectOptions,
  type InjectedFile,
  type SourceFile,
  type UploadOptions,
  type UploadResult,
} from './sourcemaps';
export { VERSION } from './version';
export { defaultRelease, pluginLogger, processBuildOutput, type ProcessBuildResult, type ZharpPluginOptions } from './build';
