/** Walking a directory, and include/exclude patterns. */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** A glob (`**`, `*`, `?`), a regular expression, or a list of them. */
export type Pattern = string | RegExp | Array<string | RegExp>;

/** Every file under `dir`, recursively, as absolute paths. `node_modules` is skipped. */
export function walk(dir: string): string[] {
  const out: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') visit(full);
      } else if (entry.isFile()) out.push(full);
      else if (entry.isSymbolicLink()) {
        try {
          if (statSync(full).isFile()) out.push(full);
        } catch {}
      }
    }
  };
  visit(dir);
  return out.sort();
}

/** `path` relative to `dir`, with forward slashes. */
export function relativePath(dir: string, path: string): string {
  return relative(dir, path).split(sep).join('/');
}

/** A glob as a regular expression over a relative path with forward slashes. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches any number of directories, including none.
        const slash = glob[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  // A pattern without a slash matches a file name at any depth, as .gitignore does.
  return new RegExp(glob.includes('/') ? `^${out}$` : `(?:^|/)${out}$`);
}

function toList(pattern: Pattern | undefined): RegExp[] {
  if (pattern === undefined) return [];
  return (Array.isArray(pattern) ? pattern : [pattern]).map((p) => (typeof p === 'string' ? globToRegExp(p) : p));
}

/** A filter over relative paths: in `include` (when given) and not in `exclude`. */
export function pathFilter(include?: Pattern, exclude?: Pattern): (relativePath: string) => boolean {
  const inc = toList(include);
  const exc = toList(exclude);
  return (path) => (inc.length === 0 || inc.some((r) => r.test(path))) && !exc.some((r) => r.test(path));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
