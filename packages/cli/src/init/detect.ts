/**
 * What kind of project this is, from its own files: package.json's dependencies, and the files
 * other ecosystems keep (requirements.txt, composer.json, go.mod). Only what the setup can act on
 * or point the person to.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export type Framework = 'nextjs' | 'vite-react' | 'nestjs' | 'express' | 'node' | 'django' | 'fastapi' | 'flask' | 'laravel' | 'go' | 'unknown';

export interface Project {
  dir: string;
  name: string;
  framework: Framework;
  /** "Next.js 16", "React (Vite)", "NestJS 11"… for the terminal and the page. */
  label: string;
  /** The Zharp platform the app is created with. */
  platform: 'browser' | 'node' | 'python' | 'php' | 'go' | 'otel';
  packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm';
  typescript: boolean;
  /** Next.js: the app directory ("app" or "src/app"), when it uses the app router. */
  appDir?: string;
  packageJson?: Record<string, any>;
}

const read = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

function majorOf(range: string | undefined): string {
  const m = /(\d+)/.exec(range ?? '');
  return m ? ` ${m[1]}` : '';
}

export function packageManagerOf(dir: string): Project['packageManager'] {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun';
  return 'npm';
}

export function detect(dir: string): Project {
  const pkgText = read(join(dir, 'package.json'));
  const pkg = pkgText ? (() => { try { return JSON.parse(pkgText); } catch { return null; } })() : null;
  const deps: Record<string, string> = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const name = (typeof pkg?.name === 'string' && pkg.name.replace(/^@[^/]+\//, '')) || basename(dir);
  const base = { dir, name, packageManager: packageManagerOf(dir), typescript: !!deps.typescript || existsSync(join(dir, 'tsconfig.json')), packageJson: pkg ?? undefined };

  if (deps.next) {
    const appDir = existsSync(join(dir, 'src', 'app')) ? 'src/app' : existsSync(join(dir, 'app')) ? 'app' : undefined;
    return { ...base, framework: 'nextjs', label: `Next.js${majorOf(deps.next)}`, platform: 'browser', appDir };
  }
  if (deps['@nestjs/core']) return { ...base, framework: 'nestjs', label: `NestJS${majorOf(deps['@nestjs/core'])}`, platform: 'node' };
  if (deps.vite && deps.react) return { ...base, framework: 'vite-react', label: 'React (Vite)', platform: 'browser' };
  if (deps.express) return { ...base, framework: 'express', label: `Express${majorOf(deps.express)}`, platform: 'node' };

  const py = [read(join(dir, 'requirements.txt')), read(join(dir, 'pyproject.toml')), read(join(dir, 'Pipfile'))].filter(Boolean).join('\n').toLowerCase();
  if (py) {
    const pyName = basename(dir);
    if (/\bdjango\b/.test(py)) return { ...base, name: pyName, framework: 'django', label: 'Django', platform: 'python' };
    if (/\bfastapi\b/.test(py)) return { ...base, name: pyName, framework: 'fastapi', label: 'FastAPI', platform: 'python' };
    if (/\bflask\b/.test(py)) return { ...base, name: pyName, framework: 'flask', label: 'Flask', platform: 'python' };
  }
  const composer = read(join(dir, 'composer.json'));
  if (composer && /laravel\/framework/.test(composer)) return { ...base, name: basename(dir), framework: 'laravel', label: 'Laravel', platform: 'php' };
  if (existsSync(join(dir, 'go.mod'))) return { ...base, name: basename(dir), framework: 'go', label: 'Go', platform: 'go' };
  if (pkg) return { ...base, framework: 'node', label: 'Node.js', platform: 'node' };
  return { ...base, framework: 'unknown', label: 'an unknown project', platform: 'otel' };
}
