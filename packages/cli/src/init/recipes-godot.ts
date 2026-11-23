/**
 * `zharp init` for Godot: a folder with project.godot.
 *
 * - The Zharp addon is copied into addons/zharp (vendored in the CLI: godot-addon.ts), unless
 *   the project has it already.
 * - project.godot gets what enabling the plugin in the editor does: the `Zharp` autoload, the
 *   plugin in [editor_plugins], call stacks in release exports and file logging (crash reports
 *   read the previous run's log); and the key, service and endpoint under [zharp]. The key is the
 *   one a game ships: it can only send data to this one app.
 * - A Godot .NET project (a .csproj on Godot.NET.Sdk) also gets the Zharp.Godot package, and the
 *   line that starts it is shown to paste.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connected } from './connect';
import type { Project } from './detect';
import type { Plan } from './recipes';
import { findFiles } from './recipes-more';
import { GODOT_ADDON, GODOT_ADDON_VERSION } from './godot-addon';

/** The Zharp.Godot package's version the setup adds (with the Zharp .NET SDK it runs on). */
export const ZHARP_GODOT_VERSION = '0.2.0';

const PLUGIN = 'res://addons/zharp/plugin.cfg';
const AUTOLOAD = '"*res://addons/zharp/zharp.gd"';

const read = (dir: string, path: string): string | null => {
  try {
    return readFileSync(join(dir, path), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
};

const otlpOf = (api: string) => {
  const clean = api.replace(/\/+$/, '');
  return clean === 'https://api.zharp.io' ? null : `${clean}/api/v1/otlp`;
};

/** A Godot project: its name (application/config/name) and, for a .NET one, its .csproj. */
export function detectGodot(dir: string): { name: string; csproj: string | null; version: string | null } | null {
  const text = read(dir, 'project.godot');
  if (text === null) return null;
  const name = /^config\/name="((?:[^"\\]|\\.)*)"/m.exec(sectionOf(text, 'application') ?? '')?.[1] ?? null;
  const csproj = findFiles(dir, '.csproj', 2).find((path) => /Sdk="Godot\.NET\.Sdk/.test(read(dir, path) ?? '')) ?? null;
  const version = /config\/features=PackedStringArray\("(\d+\.\d+)"/.exec(text)?.[1] ?? null;
  return { name: name || 'godot-game', csproj, version };
}

/** A section's lines, without its header; null when there is none. */
function sectionOf(text: string, section: string): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `[${section}]`);
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && /^\[.+\]\s*$/.test(line.trim()));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

/**
 * `key=value` in a project.godot section, as Godot writes it: the value replaced where the key
 * is set, else added at the end of the section, else a new section at the end of the file.
 */
export function setSetting(text: string, section: string, key: string, value: string): string {
  const lines = text.replace(/\s*$/, '').split('\n');
  const start = lines.findIndex((line) => line.trim() === `[${section}]`);
  if (start < 0) return `${lines.join('\n')}\n\n[${section}]\n\n${key}=${value}\n`;
  let end = lines.findIndex((line, i) => i > start && /^\[.+\]\s*$/.test(line.trim()));
  if (end < 0) end = lines.length;
  const at = lines.findIndex((line, i) => i > start && i < end && line.startsWith(`${key}=`));
  if (at >= 0) {
    lines[at] = `${key}=${value}`;
  } else {
    let last = end - 1;
    while (last > start && lines[last].trim() === '') last--;
    // Right after the header, Godot leaves a blank line.
    lines.splice(last + 1, 0, ...(last === start ? ['', `${key}=${value}`] : [`${key}=${value}`]));
  }
  return `${lines.join('\n')}\n`;
}

/** The plugin added to [editor_plugins] enabled=PackedStringArray(…), keeping the others there. */
export function enablePlugin(text: string): string {
  const current = /^enabled=PackedStringArray\((.*)\)\s*$/m.exec(sectionOf(text, 'editor_plugins') ?? '')?.[1];
  if (current?.includes(PLUGIN)) return text;
  const list = current && current.trim() ? `${current}, "${PLUGIN}"` : `"${PLUGIN}"`;
  return setSetting(text, 'editor_plugins', 'enabled', `PackedStringArray(${list})`);
}

/** project.godot with Zharp set up, or null when it already is (the same key). */
export function editProjectGodot(text: string, key: string, service: string, endpoint: string | null): string | null {
  let next = setSetting(text, 'autoload', 'Zharp', AUTOLOAD);
  next = enablePlugin(next);
  // What the plugin turns on when it's enabled in the editor.
  if (!/^settings\/gdscript\/always_track_call_stacks=/m.test(sectionOf(next, 'debug') ?? '')) next = setSetting(next, 'debug', 'settings/gdscript/always_track_call_stacks', 'true');
  if (!/^file_logging\/enable_file_logging=/m.test(sectionOf(next, 'debug') ?? '')) next = setSetting(next, 'debug', 'file_logging/enable_file_logging', 'true');
  next = setSetting(next, 'zharp', 'key', JSON.stringify(key));
  next = setSetting(next, 'zharp', 'service', JSON.stringify(service));
  if (endpoint) next = setSetting(next, 'zharp', 'endpoint', JSON.stringify(endpoint));
  return next === text ? null : next;
}

export function godot(project: Project, c: Connected, api: string): Plan | null {
  const found = detectGodot(project.dir);
  if (!found) return null;
  const plan: Plan = { install: [], devInstall: [], changes: [], manual: [], notes: [], env: { file: '', vars: {} }, commands: [] };
  const key = c.application.ingestKey;
  const endpoint = otlpOf(api);

  if (existsSync(join(project.dir, 'addons', 'zharp', 'plugin.cfg'))) {
    plan.notes.push('addons/zharp was already there and was left as it is: update it from the AssetLib tab, or delete it and run this again.');
  } else {
    for (const [path, content] of Object.entries(GODOT_ADDON)) {
      plan.changes.push({ path, kind: 'create', content, note: path.endsWith('/zharp.gd') ? `the Zharp addon ${GODOT_ADDON_VERSION}` : 'the Zharp addon' });
    }
  }
  const text = read(project.dir, 'project.godot')!;
  const next = editProjectGodot(text, key, c.application.serviceName, endpoint);
  if (next) plan.changes.push({ path: 'project.godot', kind: 'edit', content: next, note: 'the addon enabled, the app\'s key under [zharp]; call stacks in release exports and file logging (for crash reports) on' });

  if (found.csproj) {
    plan.commands!.push({ label: `dotnet add ${found.csproj} package Zharp.Godot`, argv: ['dotnet', 'add', found.csproj, 'package', 'Zharp.Godot', '--version', ZHARP_GODOT_VERSION] });
    plan.manual.push({
      path: 'a C# autoload or your first scene',
      why: 'join your C# code to the addon (exceptions that end the game, caught ones, HttpClient with ZharpGodot.HttpHandler())',
      snippet: 'public override void _Ready() => Zharp.Godot.ZharpGodot.Start(this);',
    });
  }
  if (found.version && /^4\.[0-4]$|^3\./.test(found.version)) {
    plan.notes.push(`This project is on Godot ${found.version}: the addon needs Godot 4.5 or later (the Logger class it uses arrived in 4.5).`);
  }
  plan.notes.push('Open the project in Godot once so it registers the addon\'s settings (Project Settings → Zharp). Errors, crashes and hangs are reported from the next run.');
  return plan;
}
