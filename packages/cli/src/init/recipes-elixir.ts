/**
 * Elixir: the zharp Hex package. A project is its mix.exs (an umbrella's apps included): Phoenix
 * when it depends on :phoenix, Plug when it runs Plug on Bandit or Cowboy, else plain Elixir.
 *
 * With Igniter in the project, `mix igniter.install zharp` does the setup (the dependency, the
 * plug in each endpoint, config/runtime.exs, the release step). Without it the edits are made
 * here: the dependency in mix.exs, `plug Zharp.Plug` in the endpoint or router, the runtime
 * config, then `mix deps.get`. The key goes in .env either way, and the runtime.exs line that
 * reads it is printed.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Project } from './detect';
import type { Connected } from './connect';
import type { Plan } from './recipes';
import type { Command } from './recipes-more';

export type ElixirFramework = 'phoenix' | 'plug' | 'elixir';

const read = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
};

/** A dependency mix.exs lists: {:phoenix, "~> 1.8"}, {:igniter, …}. */
const dep = (mix: string, name: string) => new RegExp(`\\{\\s*:${name}\\s*,`).test(mix);

/** The mix.exs files of a project: its own, and an umbrella's apps'. */
function mixFiles(dir: string): { path: string; text: string }[] {
  const root = read(join(dir, 'mix.exs'));
  if (root === null) return [];
  const out = [{ path: 'mix.exs', text: root }];
  const appsPath = /apps_path:\s*"([^"]+)"/.exec(root)?.[1];
  if (appsPath && existsSync(join(dir, appsPath))) {
    for (const app of readdirSync(join(dir, appsPath))) {
      const text = read(join(dir, appsPath, app, 'mix.exs'));
      if (text !== null) out.push({ path: `${appsPath}/${app}/mix.exs`, text });
    }
  }
  return out;
}

/** The Elixir project in `dir`, or null when there's no mix.exs. */
export function detectElixir(dir: string): Pick<Project, 'name' | 'framework' | 'label' | 'catalog' | 'platform'> | null {
  const files = mixFiles(dir);
  if (!files.length) return null;
  const all = files.map((f) => f.text).join('\n');
  const name = /app:\s*:(\w+)/.exec(files[0].text)?.[1] ?? /app:\s*:(\w+)/.exec(all)?.[1] ?? dir.split(/[\\/]/).pop()!;
  if (dep(all, 'phoenix')) {
    const version = /\{\s*:phoenix\s*,\s*"[~>= ]*(\d+\.\d+)/.exec(all)?.[1];
    return { name, framework: 'phoenix', label: `Phoenix${version ? ` ${version}` : ''}`, catalog: 'Phoenix', platform: 'elixir' };
  }
  if (dep(all, 'plug_cowboy') || dep(all, 'bandit') || dep(all, 'plug')) return { name, framework: 'plug', label: 'Plug', catalog: 'Plug', platform: 'elixir' };
  return { name, framework: 'elixir', label: 'Elixir', catalog: 'Elixir', platform: 'elixir' };
}

const DEFAULT_API = 'https://api.zharp.io';
const otlpOf = (api: string) => {
  const clean = api.replace(/\/+$/, '');
  return clean === DEFAULT_API ? null : `${clean}/api/v1/otlp`;
};

export const ZHARP_DEP = '{:zharp, "~> 0.1"}';

/** mix.exs with the zharp dependency first in deps; null when it's there or deps isn't the usual list. */
export function addDependency(mix: string): string | null {
  if (dep(mix, 'zharp')) return null;
  const m = /defp?\s+deps\s*(?:\(\s*\))?\s*do\s*\n([ \t]*)\[/.exec(mix);
  if (!m) return null;
  const at = m.index + m[0].length;
  // The indentation of the first dependency, else the list's plus two.
  const indent = /^[ \t]*\n([ \t]*)\{/.exec(mix.slice(at))?.[1] ?? `${m[1]}  `;
  return `${mix.slice(0, at)}\n${indent}${ZHARP_DEP},${mix.slice(at)}`;
}

/** A Phoenix endpoint with `plug Zharp.Plug` before Plug.RequestId (or Plug.Telemetry, or after `use`). */
export function addEndpointPlug(text: string): string | null {
  if (/plug\s*\(?\s*Zharp\.Plug/.test(text)) return null;
  const anchor = /^([ \t]*)plug\s*\(?\s*Plug\.(RequestId|Telemetry)\b/m.exec(text);
  if (anchor) return `${text.slice(0, anchor.index)}${anchor[1]}plug Zharp.Plug\n${text.slice(anchor.index)}`;
  const use = /^([ \t]*)use Phoenix\.Endpoint\b.*$/m.exec(text);
  if (use) return `${text.slice(0, use.index + use[0].length)}\n\n${use[1]}plug Zharp.Plug${text.slice(use.index + use[0].length)}`;
  return null;
}

/** A Plug.Router with `plug Zharp.Plug` first, right after `use Plug.Router`. */
export function addRouterPlug(text: string): string | null {
  if (/plug\s*\(?\s*Zharp\.Plug/.test(text)) return null;
  const use = /^([ \t]*)use Plug\.Router\b.*$/m.exec(text);
  if (!use) return null;
  return `${text.slice(0, use.index + use[0].length)}\n${use[1]}plug Zharp.Plug${text.slice(use.index + use[0].length)}`;
}

export const RUNTIME_CONFIG = `config :zharp,
  key: System.get_env("ZHARP_KEY"),
  environment: to_string(config_env())`;

/** config/runtime.exs with Zharp's config at its end; null when it has one already. */
export function addRuntimeConfig(text: string | null): string | null {
  if (text === null) return `import Config\n\n${RUNTIME_CONFIG}\n`;
  if (/config\s+:zharp\b/.test(text)) return null;
  return `${text.replace(/\s*$/, '')}\n\n${RUNTIME_CONFIG}\n`;
}

/** .ex files under lib/ (an umbrella's apps' too) whose text matches. */
function findSources(dir: string, test: (text: string) => boolean, depth = 5): string[] {
  const out: string[] = [];
  const walk = (path: string, level: number) => {
    if (level > depth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (['deps', '_build', 'node_modules', '.git', 'assets', 'priv', 'test'].includes(entry.name)) continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full, level + 1);
      else if (entry.name.endsWith('.ex')) {
        const text = read(full);
        if (text !== null && test(text)) out.push(relative(dir, full).split('\\').join('/'));
      }
    }
  };
  walk(dir, 0);
  return out.sort();
}

export function elixirPlanFor(project: Project, c: Connected, api: string): Plan | null {
  if (!['phoenix', 'plug', 'elixir'].includes(project.framework)) return null;
  const dir = project.dir;
  const files = mixFiles(dir);
  if (!files.length) return null;
  const endpoint = otlpOf(api);
  const plan: Plan = { install: [], devInstall: [], changes: [], manual: [], notes: [], env: { file: '.env', vars: {} }, commands: [] };
  plan.env.vars = { ZHARP_KEY: c.application.ingestKey, ZHARP_SERVICE: c.application.serviceName, ...(endpoint ? { ZHARP_ENDPOINT: endpoint } : {}) };
  const igniter = files.some((f) => dep(f.text, 'igniter'));

  if (project.framework === 'phoenix' && igniter) {
    const command: Command = { label: 'mix igniter.install zharp (dependency, plug in the endpoint, runtime config, release step)', argv: ['mix', 'igniter.install', 'zharp', '--yes'] };
    plan.commands = [command];
  } else {
    // The dependency goes where the web app is: in an umbrella, the app with Phoenix or Plug in it.
    const target = files.find((f) => f.path !== 'mix.exs' && (dep(f.text, 'phoenix') || dep(f.text, 'plug_cowboy') || dep(f.text, 'bandit')))
      ?? files.find((f) => f.path === 'mix.exs' && /\bdeps\s*(\(\s*\))?\s*do/.test(f.text))
      ?? files[0];
    const mix = addDependency(target.text);
    if (mix) plan.changes.push({ path: target.path, kind: 'edit', content: mix, note: `adds ${ZHARP_DEP}` });
    else if (!dep(target.text, 'zharp')) plan.manual.push({ path: target.path, why: 'add the dependency', snippet: ZHARP_DEP });

    if (project.framework === 'phoenix') {
      const endpoints = findSources(dir, (t) => /use Phoenix\.Endpoint\b/.test(t));
      for (const path of endpoints) {
        const edited = addEndpointPlug(read(join(dir, path))!);
        if (edited) plan.changes.push({ path, kind: 'edit', content: edited, note: 'request and response headers, user and session on each request (plug Zharp.Plug)' });
      }
      if (!endpoints.length) plan.manual.push({ path: 'your endpoint', why: 'headers, user and session on each request', snippet: 'plug Zharp.Plug' });
      plan.notes.push('For a mix release, add &Zharp.Release.package_source/1 after :assemble in its steps, so errors show the code that ran.');
    } else if (project.framework === 'plug') {
      const routers = findSources(dir, (t) => /use Plug\.Router\b/.test(t));
      for (const path of routers) {
        const edited = addRouterPlug(read(join(dir, path))!);
        if (edited) plan.changes.push({ path, kind: 'edit', content: edited, note: 'names each request by its route, with its headers (plug Zharp.Plug)' });
      }
      if (!routers.length) plan.manual.push({ path: 'your router', why: 'name each request by its route, with its headers', snippet: 'plug Zharp.Plug' });
    }

    if (existsSync(join(dir, 'config'))) {
      const runtime = addRuntimeConfig(read(join(dir, 'config', 'runtime.exs')));
      if (runtime) plan.changes.push({ path: 'config/runtime.exs', kind: existsSync(join(dir, 'config', 'runtime.exs')) ? 'edit' : 'create', content: runtime, note: 'reads ZHARP_KEY when the app starts' });
    }
    plan.commands = [{ label: 'mix deps.get', argv: ['mix', 'deps.get'] }];
  }

  plan.notes.push(`Mix doesn't load .env by itself: export ZHARP_KEY where the app runs (config/runtime.exs reads it): ${RUNTIME_CONFIG.split('\n')[1].trim()}`);
  return plan;
}
