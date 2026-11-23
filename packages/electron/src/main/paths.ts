/**
 * The app's install folder taken out of stacks and URLs: everything up to `app.asar` (or the app
 * folder when it isn't packed) becomes `app://`, so
 *
 *     file:///C:/Users/ana/AppData/Local/Programs/shop/resources/app.asar/dist/renderer.js:1:2
 *     /Applications/Shop.app/Contents/Resources/app.asar/dist/renderer.js:1:2
 *
 * both read `app:///dist/renderer.js:1:2`. Errors from every install group into one issue, and
 * no one's user folder leaves their computer. The rest of the path keeps forward slashes.
 */

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A rewrite for the app at `appPath` (`app.getAppPath()`). It matches the path as Node writes it
 * (`C:\…\app.asar`), as a file URL (`file:///C:/…/app.asar`, spaces as `%20`), and either one
 * inside JSON (backslashes doubled), with `.unpacked` after it too.
 */
export function appPathRewrite(appPath: string, windows = /^[a-z]:[\\/]/i.test(appPath)): (text: string) => string {
  const trimmed = appPath.replace(/[\\/]+$/, '');
  if (!trimmed || trimmed === '/' || trimmed.length < 4) return (text) => text;
  const forward = trimmed.replace(/\\/g, '/');
  const forms = new Set<string>([
    trimmed,
    trimmed.replace(/\\/g, '\\\\'),
    forward,
    encodeURI(forward),
  ]);
  // Longest first, so the escaped form wins over the plain one inside JSON.
  const alternatives = [...forms].sort((a, b) => b.length - a.length).map(escape).join('|');
  const pattern = new RegExp(String.raw`(?:file:\/\/\/?)?(?:${alternatives})(?:\.unpacked)?((?:(?:\\\\|\\|\/)[^\s()'":<>\\/]+)*)`, windows ? 'gi' : 'g');
  return (text) => {
    if (typeof text !== 'string' || !text) return text;
    return text.replace(pattern, (_whole, rest: string | undefined) => `app://${rest ? rest.replace(/(?:\\\\|\\)/g, '/') : '/'}`);
  };
}
