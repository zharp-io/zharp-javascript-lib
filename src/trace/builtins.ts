/**
 * Load a Node built-in module, or nothing at all outside Node.
 *
 * `process.getBuiltinModule` (Node 20.16+, 22.3+) is tried first because it is the only way in
 * that works from the ESM build: an ES module has no `require`, and the shim the bundler leaves
 * in its place throws. Without it, native-ESM applications silently lost HTTP tracing and kept
 * the active span in a single variable that every concurrent request overwrote.
 *
 * `require` remains the fallback for the CommonJS build on older Node. It is reached
 * indirectly so a bundler building for the browser does not try to resolve a Node built-in and
 * either fail or pull in a shim.
 *
 * @param name - Built-in name without the `node:` prefix, e.g. `http`
 */
export function loadBuiltin(name: string): any | null {
  try {
    const proc: any = typeof process !== 'undefined' ? process : undefined;
    if (proc && typeof proc.getBuiltinModule === 'function') {
      return proc.getBuiltinModule(`node:${name}`) ?? null;
    }
    const req = typeof module !== 'undefined' && typeof require === 'function' ? require : null;
    return req ? req(name) : null;
  } catch {
    return null;
  }
}

/**
 * Make a patch to a built-in visible to ES-module named imports.
 *
 * `import { request } from 'node:http'` is a snapshot of the module's exports, so replacing
 * `http.request` is not seen there until Node is told to resynchronise. A no-op where the
 * function does not exist.
 */
export function syncBuiltinExports(): void {
  try {
    loadBuiltin('module')?.syncBuiltinESMExports?.();
  } catch {
    // Older Node; named imports keep the unpatched function, default imports still see it.
  }
}
