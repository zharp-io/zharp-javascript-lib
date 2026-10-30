/**
 * Debug IDs: which build of a file a stack frame came from, so Zharp can find its source map.
 *
 * `zharp sourcemaps inject` (and the bundler plugins) add a line to every emitted JS file that
 * registers it at load time:
 *
 *     (globalThis.__zharpDebugIds ||= {})[new Error().stack] = "<uuid>"
 *
 * The key is a stack captured inside the file, so its top frame names the file exactly as this
 * runtime sees it — whatever the CDN, URL or path. Parsing those stacks gives file → debug ID;
 * an error then carries the IDs of the files in its own stack as `zharp.debug_ids`, a JSON
 * object `{ "<file as it appears in the stack>": "<uuid>" }`.
 */

/** The attribute an error carries its files' debug IDs in. */
export const DEBUG_IDS_ATTRIBUTE = 'zharp.debug_ids';

/** File → debug ID, from the registry entries parsed so far. */
const files = new Map<string, string>();
/** Registry keys already parsed. The registry only grows, so each stack is parsed once. */
const parsed = new Set<string>();

function registry(): Record<string, unknown> | undefined {
  const g = typeof globalThis !== 'undefined' ? (globalThis as any) : undefined;
  const value = g && g.__zharpDebugIds;
  return value && typeof value === 'object' ? value : undefined;
}

/**
 * The file a stack frame line points at, as written in the line: V8 (`at fn (file:1:2)`,
 * `at file:1:2`), and Gecko/WebKit (`fn@file:1:2`, `@file:1:2`). Undefined for anything else.
 */
export function frameFile(line: string): string | undefined {
  const text = line.trim();
  if (!text) return undefined;
  let match = /^at (?:async )?(?:.*? \()?(.+?):\d+:\d+\)?$/.exec(text);
  if (match) return clean(match[1]);
  if (text.startsWith('at ')) return undefined;
  match = /^(?:[^@]*@)?(.+?):\d+:\d+$/.exec(text);
  return match ? clean(match[1]) : undefined;
}

function clean(file: string): string | undefined {
  // `eval at fn (file:1:2), <anonymous>` and friends name no file of their own.
  if (!file || file.includes('eval at ') || file === '<anonymous>' || file === 'native') return undefined;
  return file;
}

/** Every file in a stack, in order, each once. */
export function stackFiles(stack: string): string[] {
  const out: string[] = [];
  for (const line of stack.split('\n')) {
    const file = frameFile(line);
    if (file && !out.includes(file)) out.push(file);
  }
  return out;
}

/** Parse the registry entries not seen yet: each one's top frame is the file that registered it. */
function refresh(): void {
  const entries = registry();
  if (!entries) return;
  for (const stack in entries) {
    if (parsed.has(stack)) continue;
    parsed.add(stack);
    const id = entries[stack];
    if (typeof id !== 'string') continue;
    for (const line of stack.split('\n')) {
      const file = frameFile(line);
      if (file) {
        files.set(file, id);
        break;
      }
    }
  }
}

/**
 * The debug IDs of the files in `stack` that registered one, or undefined when none did (no
 * injected build, or only third-party frames).
 */
export function debugIdsFor(stack: string | undefined): Record<string, string> | undefined {
  if (!stack) return undefined;
  try {
    refresh();
    if (files.size === 0) return undefined;
    let out: Record<string, string> | undefined;
    for (const file of stackFiles(stack)) {
      const id = files.get(file);
      if (id) (out ??= {})[file] = id;
    }
    return out;
  } catch {
    return undefined;
  }
}

/** `{ 'zharp.debug_ids': '<json>' }` for `stack`, or an empty object. Spread it into an error's attributes. */
export function debugIdAttributes(stack: string | undefined): Record<string, string> {
  const ids = debugIdsFor(stack);
  return ids ? { [DEBUG_IDS_ATTRIBUTE]: JSON.stringify(ids) } : {};
}

/** For tests: forget everything parsed. */
export function resetDebugIdCache(): void {
  files.clear();
  parsed.clear();
}
