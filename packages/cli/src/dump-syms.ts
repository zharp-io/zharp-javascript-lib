/**
 * Mozilla's `dump_syms`: turns a native build's debug files (PDB, DWARF in ELF, Mach-O / dSYM)
 * into Breakpad `.sym` files, the format Zharp's minidump processor reads.
 *
 * Found in this order: `--dump-syms <path>` / `ZHARP_DUMP_SYMS`, `dump_syms` on PATH, then
 * Mozilla's prebuilt release, downloaded once into the user's cache and checked against the
 * SHA-256 pinned below. Nothing is installed globally.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Logger } from './log';

export const DUMP_SYMS_VERSION = '2.3.9';

/**
 * The release's archives and their SHA-256, from
 * https://github.com/mozilla/dump_syms/releases/download/v2.3.9/sha256.sum.
 * Windows on Arm runs the x64 build (there is no arm64 one); so does no other platform.
 */
export const DUMP_SYMS_RELEASES: Record<string, { file: string; sha256: string }> = {
  'linux-x64': { file: 'dump_syms-x86_64-unknown-linux-gnu.tar.xz', sha256: '0fc852a86b00337407d9d423cc388a24c3b489ccaaedcf92623cad57af5ca8ad' },
  'linux-arm64': { file: 'dump_syms-aarch64-unknown-linux-gnu.tar.xz', sha256: '1b8d6ab436fbfeb9820d4a21413cc77c50c6a4221cff25a830f5d53ba0aaa732' },
  'darwin-x64': { file: 'dump_syms-x86_64-apple-darwin.tar.xz', sha256: 'e255caf99e403b31613c756babcead8463f6e600c1a9e1e5531fbe27a7e29cf2' },
  'darwin-arm64': { file: 'dump_syms-aarch64-apple-darwin.tar.xz', sha256: '4945b7e5de0d7ad403822635f0fb912b69990fc412741ff2b7b512e168c40a32' },
  'win32-x64': { file: 'dump_syms-x86_64-pc-windows-msvc.zip', sha256: 'bdf48486220708808a3e00aec78856ee1cce096189d47a1e2cb1c635f93bacc7' },
  'win32-arm64': { file: 'dump_syms-x86_64-pc-windows-msvc.zip', sha256: 'bdf48486220708808a3e00aec78856ee1cce096189d47a1e2cb1c635f93bacc7' },
};

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

/** Where downloaded tools are kept: $XDG_CACHE_HOME, ~/Library/Caches, %LOCALAPPDATA%. */
export function cacheDir(): string {
  const base = process.env.ZHARP_CACHE_DIR
    || (process.platform === 'win32' ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
      : process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches')
        : process.env.XDG_CACHE_HOME || join(homedir(), '.cache'));
  return join(base, 'zharp');
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, exe(name));
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

export interface FindDumpSymsOptions {
  /** An explicit binary (`--dump-syms`); default ZHARP_DUMP_SYMS. */
  path?: string;
  logger?: Logger;
  fetch?: typeof fetch;
  /** Skip PATH (tests). */
  ignorePath?: boolean;
}

/** The dump_syms to run, downloading Mozilla's release the first time. */
export async function findDumpSyms(options: FindDumpSymsOptions = {}): Promise<string> {
  const explicit = options.path || process.env.ZHARP_DUMP_SYMS;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`dump_syms not found at ${explicit} (--dump-syms / ZHARP_DUMP_SYMS).`);
    return explicit;
  }
  const found = options.ignorePath ? null : onPath('dump_syms');
  if (found) return found;

  const release = DUMP_SYMS_RELEASES[`${process.platform}-${process.arch}`];
  if (!release) throw new Error(`No dump_syms build for ${process.platform}-${process.arch}: install Mozilla's dump_syms (cargo install dump_syms) and pass --dump-syms <path>.`);
  const dir = join(cacheDir(), `dump_syms-${DUMP_SYMS_VERSION}`);
  const binary = join(dir, exe('dump_syms'));
  if (existsSync(binary)) return binary;
  await downloadDumpSyms(release, dir, options);
  return binary;
}

async function downloadDumpSyms(release: { file: string; sha256: string }, dir: string, options: FindDumpSymsOptions): Promise<void> {
  const url = `https://github.com/mozilla/dump_syms/releases/download/v${DUMP_SYMS_VERSION}/${release.file}`;
  options.logger?.info(`Downloading dump_syms ${DUMP_SYMS_VERSION} (once, into ${dir})`);
  const response = await (options.fetch ?? fetch)(url, { headers: { 'User-Agent': 'zharp-cli' } });
  if (!response.ok) throw new Error(`Could not download dump_syms from ${url}: HTTP ${response.status}. Pass --dump-syms <path> to use one you have.`);
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== release.sha256) throw new Error(`dump_syms download failed its checksum (got ${digest}, expected ${release.sha256}); nothing was run.`);

  // Unpacked next to the final folder, then moved into place: a half-finished download is never used.
  const work = join(tmpdir(), `zharp-dump-syms-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  try {
    const file = join(work, release.file);
    writeFileSync(file, archive);
    const out = join(work, 'out');
    mkdirSync(out);
    extract(file, out);
    const binary = findFile(out, exe('dump_syms'));
    if (!binary) throw new Error(`dump_syms is not in ${release.file}.`);
    if (process.platform !== 'win32') chmodSync(binary, 0o755);
    mkdirSync(join(dir, '..'), { recursive: true });
    const staged = `${dir}.part-${process.pid}`;
    rmSync(staged, { recursive: true, force: true });
    mkdirSync(staged);
    renameSync(binary, join(staged, exe('dump_syms')));
    try {
      renameSync(staged, dir);
    } catch (error) {
      // Another upload got there first.
      rmSync(staged, { recursive: true, force: true });
      if (!existsSync(join(dir, exe('dump_syms')))) throw error;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Unpacks with the system's tar: Linux and macOS tar read .tar.xz (with xz installed), and
 * Windows 10+ ships bsdtar as System32\tar.exe, which reads .zip. Git Bash's GNU tar may come first
 * on a Windows PATH and can't, so System32's is used there.
 */
function extract(file: string, into: string): void {
  const windowsTar = process.platform === 'win32' && process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'tar.exe') : null;
  const tar = windowsTar && existsSync(windowsTar) ? windowsTar : 'tar';
  const args = file.endsWith('.zip') ? ['-xf', file, '-C', into] : ['-xJf', file, '-C', into];
  const result = spawnSync(tar, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.error || result.status !== 0) {
    const why = result.error?.message ?? result.stderr?.toString().trim();
    throw new Error(`Could not unpack dump_syms with tar (${why}). ${file.endsWith('.xz') ? 'It needs xz (apt install xz-utils). ' : ''}Or install Mozilla's dump_syms yourself and pass --dump-syms <path>.`);
  }
}

function findFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name === name) return full;
  }
  return null;
}
