/**
 * What kind of project this is, from its own files: package.json's dependencies, and the files
 * other ecosystems keep (requirements.txt, composer.json, go.mod). Only what the setup can act on
 * or point the person to.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { detectDotnet } from './recipes-dotnet';
import { detectScripts } from './recipes-scripts';
import { detectRust } from './recipes-rust';
import { detectElixir, type ElixirFramework } from './recipes-elixir';
import { detectGodot } from './recipes-godot';

export type Framework =
  | 'expo' | 'react-native' | 'nextjs' | 'vite-react' | 'nestjs'
  | 'express' | 'koa' | 'hapi' | 'fastify' | 'connect' | 'node'
  | 'django' | 'fastapi' | 'flask' | PythonFramework
  | 'laravel' | 'go' | 'dotnet' | 'rust' | 'godot' | RubyFramework | ElixirFramework | 'powershell' | 'shell' | 'unknown';

/** Ruby projects, from the Gemfile: Rails, the Rack frameworks (one use line in config.ru), plain Ruby. */
export type RubyFramework = 'rails' | 'sinatra' | 'hanami' | 'roda' | 'grape' | 'rack' | 'ruby';

/** Python frameworks set up like FastAPI and Flask: Zharp started in the module that creates the app. */
export type PythonFramework = 'chalice' | 'sanic' | 'quart' | 'starlette' | 'falcon' | 'tornado' | 'pyramid' | 'aiohttp' | 'bottle' | 'celery' | 'rq';

/** Each Python framework: how its requirement is named, and the tile it is in Add app. */
export const PYTHON_FRAMEWORKS: { id: PythonFramework; requirement: RegExp; catalog: string }[] = [
  { id: 'chalice', requirement: /\bchalice\b/, catalog: 'Chalice' },
  { id: 'sanic', requirement: /\bsanic\b/, catalog: 'Sanic' },
  { id: 'quart', requirement: /\bquart\b/, catalog: 'Quart' },
  { id: 'starlette', requirement: /\bstarlette\b/, catalog: 'Starlette' },
  { id: 'falcon', requirement: /\bfalcon\b/, catalog: 'Falcon' },
  { id: 'tornado', requirement: /\btornado\b/, catalog: 'Tornado' },
  { id: 'pyramid', requirement: /\bpyramid\b/, catalog: 'Pyramid' },
  { id: 'aiohttp', requirement: /\baiohttp\b/, catalog: 'AIOHTTP' },
  { id: 'bottle', requirement: /\bbottle\b/, catalog: 'Bottle' },
  { id: 'celery', requirement: /\bcelery\b/, catalog: 'Celery' },
  { id: 'rq', requirement: /^\s*rq\b|["']rq\b/m, catalog: 'RQ (Redis Queue)' },
];

/** Go routers with their own Zharp module or setup, by the module path go.mod requires. */
export const GO_ROUTERS: { id: 'gin' | 'echo' | 'fiber' | 'iris' | 'fasthttp' | 'gorilla' | 'negroni'; module: RegExp; catalog: string }[] = [
  { id: 'gin', module: /github\.com\/gin-gonic\/gin\b/, catalog: 'Gin' },
  { id: 'echo', module: /github\.com\/labstack\/echo\b/, catalog: 'Echo' },
  { id: 'fiber', module: /github\.com\/gofiber\/fiber\/v2\b/, catalog: 'Fiber' },
  { id: 'iris', module: /github\.com\/kataras\/iris\/v12\b/, catalog: 'Iris' },
  { id: 'fasthttp', module: /github\.com\/valyala\/fasthttp\b/, catalog: 'FastHTTP' },
  // Negroni first: a Negroni app often routes with gorilla/mux (both are set up).
  { id: 'negroni', module: /github\.com\/urfave\/negroni\b/, catalog: 'Negroni' },
  { id: 'gorilla', module: /github\.com\/gorilla\/mux\b/, catalog: 'Go' },
];
export type GoRouter = (typeof GO_ROUTERS)[number]['id'];

export interface Project {
  dir: string;
  name: string;
  framework: Framework;
  /** "Next.js 16", "React (Vite)", "NestJS 11"… for the terminal and the page. */
  label: string;
  /** The framework as Add app names it ("Express", "Gin", "Chalice"): the app is created with it, so its setup page opens there. */
  catalog?: string;
  /** Go: the router go.mod requires, when it has its own setup. */
  goRouter?: GoRouter;
  /** The Zharp platform the app is created with. */
  platform: 'browser' | 'node' | 'python' | 'php' | 'go' | 'ruby' | 'elixir' | 'react-native' | 'dotnet' | 'rust' | 'godot' | 'powershell' | 'shell' | 'otel';
  /** PowerShell and shell: the script the setup lines go in. */
  entry?: string;
  /** Ruby: the Gemfile has dotenv (dotenv-rails), so the key can go in .env. */
  dotenv?: boolean;
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

  // Godot: project.godot says so, whatever else is in the folder (a C# game has a .csproj too).
  const game = detectGodot(dir);
  if (game) {
    return { ...base, name: game.name, framework: 'godot', label: `Godot${game.version ? ` ${game.version}` : ''}${game.csproj ? ' (C#)' : ''}`, catalog: 'Godot', platform: 'godot' };
  }

  // A Rails app's package.json (esbuild, Vite, React) is its front end: the app is Rails. Other
  // Gemfiles (React Native's CocoaPods one, Sinatra next to a Node tool) are looked at last.
  const gemfile = read(join(dir, 'Gemfile'));
  if (gemfile !== null && isRails(dir, gemfile)) return { ...base, ...ruby(dir, gemfile) };
  // Elixir: mix.exs (a Phoenix app's assets keep their own package.json).
  const elixir = existsSync(join(dir, 'mix.exs')) ? detectElixir(dir) : null;
  if (elixir) return { ...base, ...elixir };

  // Before React and Node: an app with react-native depends on react too.
  if (deps.expo) return { ...base, framework: 'expo', label: `Expo${majorOf(deps.expo).replace(/^ (\d+)$/, ' SDK $1')}`, catalog: 'React Native', platform: 'react-native' };
  if (deps['react-native']) return { ...base, framework: 'react-native', label: `React Native${/(\d+\.\d+)/.exec(deps['react-native'])?.[1] ? ` ${/(\d+\.\d+)/.exec(deps['react-native'])![1]}` : ''}`, catalog: 'React Native', platform: 'react-native' };
  if (deps.next) {
    const appDir = existsSync(join(dir, 'src', 'app')) ? 'src/app' : existsSync(join(dir, 'app')) ? 'app' : undefined;
    return { ...base, framework: 'nextjs', label: `Next.js${majorOf(deps.next)}`, catalog: 'Next.js', platform: 'browser', appDir };
  }
  if (deps['@nestjs/core']) return { ...base, framework: 'nestjs', label: `NestJS${majorOf(deps['@nestjs/core'])}`, catalog: 'NestJS', platform: 'node' };
  if (deps.vite && deps.react) return { ...base, framework: 'vite-react', label: 'React (Vite)', catalog: 'React', platform: 'browser' };
  if (deps.express) return { ...base, framework: 'express', label: `Express${majorOf(deps.express)}`, catalog: 'Express', platform: 'node' };
  // Node servers set up like Express: Zharp preloaded before the framework loads.
  if (deps.fastify) return { ...base, framework: 'fastify', label: `Fastify${majorOf(deps.fastify)}`, catalog: 'Fastify', platform: 'node' };
  if (deps.koa) return { ...base, framework: 'koa', label: `Koa${majorOf(deps.koa)}`, catalog: 'Koa', platform: 'node' };
  if (deps['@hapi/hapi']) return { ...base, framework: 'hapi', label: `Hapi${majorOf(deps['@hapi/hapi'])}`, catalog: 'Hapi', platform: 'node' };
  if (deps.connect) return { ...base, framework: 'connect', label: 'Connect', catalog: 'Connect', platform: 'node' };

  const py = [read(join(dir, 'requirements.txt')), read(join(dir, 'pyproject.toml')), read(join(dir, 'Pipfile'))].filter(Boolean).join('\n').toLowerCase();
  if (py) {
    const pyName = basename(dir);
    if (/\bdjango\b/.test(py)) return { ...base, name: pyName, framework: 'django', label: 'Django', catalog: 'Django', platform: 'python' };
    if (/\bfastapi\b/.test(py)) return { ...base, name: pyName, framework: 'fastapi', label: 'FastAPI', catalog: 'FastAPI', platform: 'python' };
    if (/\bflask\b/.test(py)) return { ...base, name: pyName, framework: 'flask', label: 'Flask', catalog: 'Flask', platform: 'python' };
    const more = PYTHON_FRAMEWORKS.find((f) => f.requirement.test(py));
    if (more) return { ...base, name: pyName, framework: more.id, label: more.catalog, catalog: more.catalog, platform: 'python' };
  }
  const composer = read(join(dir, 'composer.json'));
  if (composer && /laravel\/framework/.test(composer)) return { ...base, name: basename(dir), framework: 'laravel', label: 'Laravel', catalog: 'Laravel', platform: 'php' };
  const goMod = read(join(dir, 'go.mod'));
  if (goMod !== null) {
    const router = GO_ROUTERS.find((r) => r.module.test(goMod));
    const moduleName = /^module\s+(\S+)/m.exec(goMod)?.[1]?.split('/').pop();
    const label = router ? `Go (${router.id === 'gorilla' ? 'gorilla/mux' : router.catalog})` : 'Go';
    return { ...base, name: moduleName || basename(dir), framework: 'go', label, catalog: router?.catalog ?? 'Go', goRouter: router?.id, platform: 'go' };
  }
  if (gemfile !== null && !deps['react-native'] && !deps.expo) return { ...base, ...ruby(dir, gemfile) };
  // .NET: a project file (alone or in a solution), and the host it targets.
  const net = detectDotnet(dir);
  if (net) return { ...base, name: basename(net.csproj).replace(/\.csproj$/, ''), framework: 'dotnet', label: net.label, catalog: net.catalog, platform: 'dotnet' };
  // Rust: Cargo.toml (a crate, or a workspace's binary member) and the framework it depends on.
  const crate = detectRust(dir);
  if (crate) return { ...base, name: crate.name, framework: 'rust', label: crate.label, catalog: crate.catalog, platform: 'rust' };
  if (pkg) return { ...base, framework: 'node', label: 'Node.js', catalog: 'Node.js', platform: 'node' };
  // A folder of scripts: PowerShell (*.ps1) or shell (*.sh), whichever there are more of.
  const scripts = detectScripts(dir);
  if (scripts?.kind === 'powershell') return { ...base, framework: 'powershell', label: `PowerShell scripts (${scripts.entry})`, catalog: 'PowerShell', platform: 'powershell', entry: scripts.entry };
  if (scripts?.kind === 'shell') return { ...base, framework: 'shell', label: `shell scripts (${scripts.entry})`, catalog: 'CLI (Shell)', platform: 'shell', entry: scripts.entry };
  return { ...base, framework: 'unknown', label: 'an unknown project', platform: 'otel' };
}

/** A gem the Gemfile asks for: gem "rails", gem 'sinatra', "~> 4.1". */
const gem = (gemfile: string, name: string) => new RegExp(String.raw`^\s*gem\s+["']${name}["']`, 'm').test(gemfile);

const isRails = (dir: string, gemfile: string) => gem(gemfile, 'rails') || existsSync(join(dir, 'config', 'application.rb'));

/** Rails ("Rails" in Add app); Sinatra, Hanami, Roda, Grape and plain Rack ("Rack Middleware"); else plain Ruby ("Ruby"). */
function ruby(dir: string, gemfile: string): Pick<Project, 'name' | 'framework' | 'label' | 'catalog' | 'platform' | 'dotenv'> {
  const name = basename(dir);
  const dotenv = gem(gemfile, 'dotenv(?:-rails)?');
  const major = (gemName: string) => new RegExp(String.raw`^\s*gem\s+["']${gemName}["']\s*,\s*["'][^"'\d]*(\d+)`, 'm').exec(gemfile)?.[1];
  if (isRails(dir, gemfile)) {
    const v = major('rails');
    return { name, framework: 'rails', label: `Rails${v ? ` ${v}` : ''}`, catalog: 'Rails', platform: 'ruby', dotenv };
  }
  const rack: [RubyFramework, string][] = [['sinatra', 'Sinatra'], ['hanami', 'Hanami'], ['roda', 'Roda'], ['grape', 'Grape']];
  for (const [id, label] of rack) {
    if (gem(gemfile, id)) return { name, framework: id, label, catalog: 'Rack Middleware', platform: 'ruby', dotenv };
  }
  if (gem(gemfile, 'rack') || existsSync(join(dir, 'config.ru'))) return { name, framework: 'rack', label: 'Rack', catalog: 'Rack Middleware', platform: 'ruby', dotenv };
  return { name, framework: 'ruby', label: 'Ruby', catalog: 'Ruby', platform: 'ruby', dotenv };
}
