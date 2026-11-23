/**
 * `zharp init` for Unity: a folder with ProjectSettings/ProjectVersion.txt.
 *
 * - The io.zharp.unity package is added to Packages/manifest.json: from its Git URL, or from
 *   OpenUPM when the manifest already has the OpenUPM registry (io.zharp added to its scopes).
 *   A manifest that has the package already is left as it is.
 * - The key, service and app ID go in Assets/Zharp/Resources/ZharpSettings.json, what Project
 *   Settings › Zharp edits (other settings there are kept). Unity makes its .meta on import. The
 *   key is the one a game ships: it can only send data to this one app.
 * - The upload token (source bundles, dSYMs) is a secret for the build machine, never the project.
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Connected } from './connect';
import type { Project } from './detect';
import type { Plan } from './recipes';

/** The io.zharp.unity version the setup adds. */
export const ZHARP_UNITY_VERSION = '0.1.0';
export const ZHARP_UNITY_PACKAGE = 'io.zharp.unity';
export const ZHARP_UNITY_GIT_URL = `https://github.com/zharp-io/zharp-unity-lib.git#${ZHARP_UNITY_VERSION}`;
const OPENUPM = 'https://package.openupm.com';
const SCOPE = 'io.zharp';

export const MANIFEST = 'Packages/manifest.json';
export const SETTINGS = 'Assets/Zharp/Resources/ZharpSettings.json';

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

/** A Unity project: its Product Name (ProjectSettings.asset) and editor version (ProjectVersion.txt). */
export function detectUnity(dir: string): { name: string; version: string | null } | null {
  const text = read(dir, 'ProjectSettings/ProjectVersion.txt');
  if (text === null) return null;
  const version = /^m_EditorVersion:\s*(\S+)/m.exec(text)?.[1] ?? null;
  const product = /^\s*productName:\s*(.+?)\s*$/m.exec(read(dir, 'ProjectSettings/ProjectSettings.asset') ?? '')?.[1]?.replace(/^(['"])(.*)\1$/, '$2');
  return { name: product || basename(dir), version };
}

/** Unity 6 (6000.x) and later; an unreadable version is given the benefit of the doubt. */
export const supportedUnity = (version: string | null) => !version || (Number(/^(\d+)\./.exec(version)?.[1]) || 6000) >= 6000;

/** JSON as Unity writes it: the file's own indent (2 spaces when it can't tell) and final newline. */
function stringifyLike(original: string, value: unknown): string {
  const indent = /^[{[]\n([ \t]+)\S/.exec(original.trimStart())?.[1] ?? '  ';
  return JSON.stringify(value, null, indent) + (original.endsWith('\n') ? '\n' : '');
}

/** An object field from a parsed JSON object, when it is one. */
const objectOf = (value: unknown): Record<string, any> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null);

/**
 * Packages/manifest.json with io.zharp.unity added at the end of dependencies: the OpenUPM version
 * when the manifest has the OpenUPM registry (io.zharp added to its scopes unless they cover it),
 * else the Git URL. Null when the package is there already, or the manifest can't be read as JSON.
 */
export function editManifest(text: string): { content: string; source: 'git' | 'openupm' } | null {
  let manifest: Record<string, any> | null;
  try {
    manifest = objectOf(JSON.parse(text));
  } catch {
    return null;
  }
  if (!manifest) return null;
  const dependencies = objectOf(manifest.dependencies) ?? {};
  if (ZHARP_UNITY_PACKAGE in dependencies) return null;

  const registries: any[] = Array.isArray(manifest.scopedRegistries) ? manifest.scopedRegistries : [];
  const openupm = registries.find((r) => typeof r?.url === 'string' && r.url.replace(/\/+$/, '') === OPENUPM);
  if (openupm) {
    const scopes: unknown[] = Array.isArray(openupm.scopes) ? openupm.scopes : (openupm.scopes = []);
    // A scope covers a package named as it, or below it (io.zharp covers io.zharp.unity).
    if (!scopes.some((s) => typeof s === 'string' && (ZHARP_UNITY_PACKAGE === s || ZHARP_UNITY_PACKAGE.startsWith(`${s}.`)))) scopes.push(SCOPE);
  }
  manifest.dependencies = { ...dependencies, [ZHARP_UNITY_PACKAGE]: openupm ? ZHARP_UNITY_VERSION : ZHARP_UNITY_GIT_URL };
  return { content: stringifyLike(text, manifest), source: openupm ? 'openupm' : 'git' };
}

/**
 * ZharpSettings.json with the app's key, service and ID (and endpoint, for a Zharp other than
 * zharp.io), other settings kept. Null when nothing changes; 'invalid' when the file isn't a JSON object.
 */
export function editSettings(text: string | null, values: Record<string, string>): string | null | 'invalid' {
  let settings: Record<string, any> = {};
  if (text !== null && text.trim()) {
    try {
      const parsed = objectOf(JSON.parse(text));
      if (!parsed) return 'invalid';
      settings = parsed;
    } catch {
      return 'invalid';
    }
  }
  const next = { ...settings, ...values };
  const content = text?.trim() ? stringifyLike(text, next) : `${JSON.stringify(next, null, 2)}\n`;
  return content === text ? null : content;
}

export function unity(project: Project, c: Connected, api: string): Plan | null {
  const found = detectUnity(project.dir);
  if (!found) return null;
  const plan: Plan = { install: [], devInstall: [], changes: [], manual: [], notes: [], env: { file: '', vars: {} }, commands: [] };

  const manifest = read(project.dir, MANIFEST);
  const edited = manifest === null ? null : editManifest(manifest);
  if (edited) {
    plan.changes.push({
      path: MANIFEST,
      kind: 'edit',
      content: edited.content,
      note: edited.source === 'openupm' ? `${ZHARP_UNITY_PACKAGE} ${ZHARP_UNITY_VERSION} from OpenUPM` : `${ZHARP_UNITY_PACKAGE} ${ZHARP_UNITY_VERSION} from its Git URL`,
    });
  } else if (manifest !== null && /"io\.zharp\.unity"\s*:/.test(manifest)) {
    plan.notes.push(`${ZHARP_UNITY_PACKAGE} was already in ${MANIFEST} and was left as it is.`);
  } else {
    plan.manual.push({
      path: MANIFEST,
      why: manifest === null ? 'there is no package manifest: add the package from Window › Package Manager › + › Install package from git URL…' : 'it isn\'t JSON this setup can read: add the package to its dependencies',
      snippet: `"${ZHARP_UNITY_PACKAGE}": "${ZHARP_UNITY_GIT_URL}"`,
    });
  }

  const endpoint = otlpOf(api);
  const values: Record<string, string> = { key: c.application.ingestKey, service: c.application.serviceName, applicationId: String(c.application.id), ...(endpoint ? { endpoint } : {}) };
  const current = read(project.dir, SETTINGS);
  const settings = editSettings(current, values);
  if (settings === 'invalid') {
    plan.manual.push({ path: SETTINGS, why: 'it isn\'t a JSON object: set these in it (or in Project Settings › Zharp)', snippet: JSON.stringify(values, null, 2) });
  } else if (settings !== null) {
    plan.changes.push({ path: SETTINGS, kind: current === null ? 'create' : 'edit', content: settings, note: 'the app\'s key, service and ID (Project Settings › Zharp)' });
  }

  if (!supportedUnity(found.version)) {
    plan.notes.push(`This project is on Unity ${found.version}: ${ZHARP_UNITY_PACKAGE} needs Unity 6.0 LTS or 6.3 LTS (6000.0 or later).`);
  }
  plan.notes.push('Open the project in Unity: it resolves the package, and Project Settings › Zharp shows the key. Errors, crashes and hangs are reported from the next run.');
  plan.notes.push(`Uploads at build time (the game's sources, iOS dSYMs): set ZHARP_AUTH_TOKEN (the upload key above) and ZHARP_APP_ID=${c.application.id} on the build machine or in CI. It's a secret: never put it in the project.`);
  return plan;
}
