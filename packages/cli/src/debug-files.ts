/**
 * Native debug files for C and C++ crashes (minidumps from Crashpad, Breakpad or Zharp's native
 * SDK): each module's debug information as a Breakpad `.sym` file, the format Zharp's stack walker
 * reads. Uploaded as `breakpad-sym` under the debug ID in the file's MODULE line — the same ID the
 * minidump records for that module, so Zharp never computes one itself.
 *
 * `.sym` files found as they are; PDBs, ELF files and Mach-O binaries / dSYMs are converted with
 * Mozilla's dump_syms (see dump-syms.ts). With `--include-sources`, the files a `.sym` names are
 * uploaded with it as a source bundle, so crashes show the code of the build that ran.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { eachLimit, uploadArtifact, type Artifact, type Connection } from './api';
import { findDumpSyms } from './dump-syms';
import { isElf } from './elf';
import { formatBytes, walk } from './files';
import { consoleLogger, type Logger } from './log';
import { isMachO, readMachO } from './macho';

/** The server's cap on one `.sym` file (gzipped, as sent). */
export const MAX_SYM_BYTES = 2_000_000_000;

/** `MODULE <os> <arch> <debug id> <debug file>`: the first line of every `.sym`. */
export interface SymModule {
  os: string;
  arch: string;
  debugId: string;
  name: string;
}

export function parseModuleLine(line: string): SymModule | null {
  const m = /^MODULE (\S+) (\S+) ([0-9A-Fa-f]{8,}) (.+?)\s*$/.exec(line);
  return m ? { os: m[1], arch: m[2], debugId: m[3], name: m[4] } : null;
}

function readHead(path: string, bytes: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0));
  } finally {
    closeSync(fd);
  }
}

export type DebugFileType = 'sym' | 'pdb' | 'pe' | 'elf' | 'macho';

export interface DebugFile {
  path: string;
  type: DebugFileType;
  /** Mach-O: the architectures of a universal file, each dumped on its own. */
  archs?: string[];
}

const SKIP_EXTENSIONS = /\.(o|obj|a|lib|ilk|exp|idb|iobj|ipdb|tlog|pch|gch|d|dep|log|txt|json|cmake|ninja|map|zip|gz|xz|tar|7z)$/i;

/** What one file is, from its first bytes; null when it is nothing dump_syms reads. */
export function classify(path: string): DebugFile | null {
  if (SKIP_EXTENSIONS.test(path)) return null;
  let head: Buffer;
  try {
    head = readHead(path, 64 * 1024);
  } catch {
    return null;
  }
  if (head.length < 8) return null;
  if (/\.sym$/i.test(path)) return parseModuleLine(head.toString('utf8').split(/\r?\n/, 1)[0].replace(/^﻿/, '')) ? { path, type: 'sym' } : null;
  if (head.subarray(0, 28).toString('latin1') === 'Microsoft C/C++ MSF 7.00\r\n\x1aDS') return { path, type: 'pdb' };
  if (isElf(head)) return { path, type: 'elf' };
  if (head[0] === 0x4d && head[1] === 0x5a && /\.(exe|dll|sys|ocx|node)$/i.test(path)) return { path, type: 'pe' };
  if (isMachO(head)) {
    let archs: string[] = [];
    try {
      // Fat headers sit at the start; a thin file's arch is in its own header.
      archs = [...new Set(readMachO(statSync(path).size <= head.length ? head : readFileSync(path)).map((image) => image.arch))];
    } catch {}
    return { path, type: 'macho', archs };
  }
  return null;
}

/** The debug files under a path (or the one file), each dSYM's DWARF file included. */
export function findDebugFiles(path: string): DebugFile[] {
  const root = resolve(path);
  const files = statSync(root).isDirectory() ? walk(root) : [root];
  return files.map(classify).filter((file): file is DebugFile => !!file);
}

/** One module's symbols, ready to send. */
export interface SymFile {
  module: SymModule;
  data: Buffer;
  /** Where it came from: the .sym, or the file dump_syms read. */
  source: string;
  /** FUNC and PUBLIC records: zero for a CFI-only file (a stripped binary). */
  functions: number;
}

export function readSym(data: Buffer, source: string): SymFile | null {
  const text = data.toString('utf8', 0, Math.min(data.length, 4096));
  const module = parseModuleLine(text.replace(/^﻿/, '').split(/\r?\n/, 1)[0]);
  if (!module) return null;
  const functions = data.includes('\nFUNC ') || data.includes('\nPUBLIC ') ? 1 : 0;
  return { module, data, source, functions };
}

/** Runs dump_syms on one file (one architecture of a universal Mach-O), writing the .sym to a temp file. */
async function dumpSyms(binary: string, file: string, arch: string | undefined, work: string): Promise<Buffer> {
  const out = join(work, `${Date.now()}-${Math.random().toString(36).slice(2)}.sym`);
  const args = ['--inlines', '-o', out, ...(arch ? ['-a', arch] : []), file];
  const stderr: string[] = [];
  const code = await new Promise<number | null>((done, failed) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
    child.on('error', failed);
    child.on('close', done);
  });
  if (code !== 0 || !existsSync(out)) throw new Error(stderr.join('').trim().split('\n').slice(-3).join(' ') || `exit code ${code}`);
  try {
    return readFileSync(out);
  } finally {
    rmSync(out, { force: true });
  }
}

export interface CollectSymsOptions {
  logger?: Logger;
  /** dump_syms to use (`--dump-syms`); default found (see dump-syms.ts). */
  dumpSyms?: string;
  fetch?: typeof fetch;
}

/**
 * Every module's `.sym` from these paths, one per debug ID. Where several files give the same
 * module (a stripped binary and its separate debug file, a PDB and its DLL), the one with
 * functions wins, then the larger.
 */
export async function collectSyms(paths: string[], options: CollectSymsOptions = {}): Promise<SymFile[]> {
  const logger = options.logger ?? consoleLogger();
  const files = paths.flatMap((path) => findDebugFiles(path));
  const byId = new Map<string, SymFile>();
  const keep = (sym: SymFile) => {
    const key = sym.module.debugId.toUpperCase();
    const current = byId.get(key);
    if (!current || (sym.functions > 0 && current.functions === 0) || (!!sym.functions === !!current.functions && sym.data.length > current.data.length)) byId.set(key, sym);
  };

  for (const file of files.filter((f) => f.type === 'sym')) {
    const sym = readSym(readFileSync(file.path), file.path);
    if (sym) keep(sym);
  }

  const native = files.filter((f) => f.type !== 'sym');
  if (native.length) {
    const binary = await findDumpSyms({ path: options.dumpSyms, logger, fetch: options.fetch });
    const work = mkdtempSync(join(tmpdir(), 'zharp-syms-'));
    try {
      for (const file of native) {
        const archs = file.type === 'macho' && file.archs && file.archs.length > 1 ? file.archs : [undefined];
        for (const arch of archs) {
          try {
            const sym = readSym(await dumpSyms(binary, file.path, arch, work), file.path);
            if (sym) keep(sym);
          } catch (error) {
            // A build folder holds ELF and PE files with no debug info at all; that's expected.
            logger.info(`  skipped ${basename(file.path)}${arch ? ` (${arch})` : ''}: ${(error as Error).message}`);
          }
        }
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  return [...byId.values()].sort((a, b) => a.module.name.localeCompare(b.module.name));
}

// ── Source bundles ───────────────────────────────────────────────────────────

/** Source files of C, C++, Objective-C and Rust, as `.sym` FILE records name them. */
const SOURCE_EXTENSIONS = /\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|inl|ipp|tpp|m|mm|rs|swift|cu)$/i;

/** Toolchain and system headers: never the app's code, and often huge. */
const SYSTEM_PATHS = [
  /^\/usr\//, /^\/lib\//, /^\/opt\/(homebrew|local)\//, /^\/Applications\/Xcode/, /^\/Library\/Developer\//,
  /^\/rustc\//, /\/\.cargo\/registry\//, /\/\.rustup\//, /^\/build\/glibc/, /^\/build\/gcc/,
  /^[A-Za-z]:[\\/]Program Files( \(x86\))?[\\/]/i,
  /[\\/](vcpkg_installed|_deps|third_party|external|node_modules)[\\/]/i,
  /^d:[\\/](a01|agent)[\\/]_work[\\/]/i, // Microsoft's own CRT build paths
];

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 20_000;

export interface SymSources {
  files: Record<string, string>;
  count: number;
  bytes: number;
  /** Named in the .sym but not on this machine. */
  missing: number;
  /** Over the size caps. */
  skipped: number;
}

/** The paths of a `.sym`'s FILE records (`FILE <n> <path>`). */
export function symFilePaths(data: Buffer): string[] {
  const out: string[] = [];
  const text = data.toString('utf8');
  const re = /^FILE \d+ (.+?)\r?$/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1]);
  return out;
}

/** The app's own source files a `.sym` names, read from disk, under the paths the `.sym` gives. */
export function collectSymSources(sym: SymFile, options: { root?: string } = {}): SymSources {
  const out: SymSources = { files: {}, count: 0, bytes: 0, missing: 0, skipped: 0 };
  for (const path of new Set(symFilePaths(sym.data))) {
    if (!SOURCE_EXTENSIONS.test(path) || SYSTEM_PATHS.some((re) => re.test(path))) continue;
    // Built elsewhere (in CI, in a container): the same relative path under --sources.
    const local = existsSync(path) ? path : options.root ? join(options.root, path.replace(/^([A-Za-z]:)?[\\/]+/, '')) : null;
    let size: number;
    try {
      if (!local) throw new Error('missing');
      size = statSync(local).size;
    } catch {
      out.missing += 1;
      continue;
    }
    if (size > MAX_FILE_BYTES || out.bytes + size > MAX_TOTAL_BYTES || out.count >= MAX_FILES) {
      out.skipped += 1;
      continue;
    }
    out.files[path] = readFileSync(local!, 'utf8');
    out.count += 1;
    out.bytes += size;
  }
  return out;
}

// ── Upload ───────────────────────────────────────────────────────────────────

export interface DebugFilesUploadOptions extends CollectSymsOptions {
  release?: string;
  dryRun?: boolean;
  retries?: number;
  /** Also send the source files each `.sym` names (default off). */
  includeSources?: boolean;
  /** Where those sources are when they were built under another path (default: as named). */
  sourcesRoot?: string;
}

export interface DebugFilesUploadResult {
  modules: SymFile[];
  artifacts: Artifact[];
}

export async function uploadDebugFiles(paths: string[], connection: Connection | null, options: DebugFilesUploadOptions = {}): Promise<DebugFilesUploadResult> {
  const logger = options.logger ?? consoleLogger();
  const modules = await collectSyms(paths, options);
  if (!modules.length) {
    throw new Error(`No debug files in ${paths.join(', ')} — pass the build output with its PDBs, unstripped ELF files (or their .debug files), dSYMs, or .sym files.`);
  }
  const artifacts: Artifact[] = [];
  for (const sym of modules) {
    if (!sym.functions) logger.warn(`${sym.module.name} has no function names (a stripped build?): its crashes will walk, but show addresses. Upload its unstripped file or .debug file too.`);
    artifacts.push({ kind: 'breakpad-sym', debugId: sym.module.debugId, name: sym.module.name, arch: sym.module.arch, release: options.release, data: sym.data, gzip: true });
    if (options.includeSources) {
      const sources = collectSymSources(sym, { root: options.sourcesRoot });
      if (sources.count) {
        logger.info(`With ${sources.count} source file(s) of ${sym.module.name}, ${formatBytes(sources.bytes)}${sources.missing ? ` (${sources.missing} not on this machine)` : ''}${sources.skipped ? ` (${sources.skipped} over the size caps)` : ''}`);
        artifacts.push({ kind: 'source-bundle', debugId: sym.module.debugId, name: 'sources.json', release: options.release, data: Buffer.from(JSON.stringify({ files: sources.files }), 'utf8'), gzip: true });
      } else if (sources.missing) {
        logger.info(`No sources of ${sym.module.name} found on this machine (${sources.missing} named in its symbols): pass --sources <folder it was built from>.`);
      }
    }
  }

  logger.info(`${options.dryRun ? 'Would upload' : 'Uploading'} symbols of ${modules.length} module(s)`);
  let done = 0;
  await eachLimit(artifacts, 2, async (artifact) => {
    if (!options.dryRun) {
      if (!connection) throw new Error('No connection to upload to.');
      await uploadArtifact(connection, artifact, { fetch: options.fetch, retries: options.retries });
    }
    done += 1;
    logger.info(`  [${done}/${artifacts.length}] ${options.dryRun ? 'would upload' : 'uploaded'} ${artifact.kind === 'breakpad-sym' ? 'symbols' : 'sources'} ${artifact.name}${artifact.arch ? ` ${artifact.arch}` : ''} (${formatBytes(artifact.data.length)})  ${artifact.debugId}`);
  });
  return { modules, artifacts };
}
