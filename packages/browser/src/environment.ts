/**
 * Browser and OS from the user agent, as `browser.name`/`browser.version` and
 * `os.name`/`os.version`.
 *
 * A handful of patterns rather than a UA library: the dashboard needs "Chrome 130 on macOS",
 * not device databases, and the order of the checks is what matters — Edge and Opera say
 * "Chrome" too, and every iOS browser says "Safari".
 */

const BROWSERS: Array<[name: string, pattern: RegExp]> = [
  ['Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/],
  ['Opera', /(?:OPR|Opera)\/([\d.]+)/],
  ['Samsung Internet', /SamsungBrowser\/([\d.]+)/],
  ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/],
  ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/],
  ['Safari', /Version\/([\d.]+).*Safari\//],
];

export interface Platform {
  browserName?: string;
  browserVersion?: string;
  osName?: string;
  osVersion?: string;
}

export function parseUserAgent(ua: string): Platform {
  const out: Platform = {};
  for (const [name, pattern] of BROWSERS) {
    const match = pattern.exec(ua);
    if (match) {
      out.browserName = name;
      // The major version is what anyone filters on; the rest is build noise.
      out.browserVersion = match[1].split('.')[0];
      break;
    }
  }

  let match: RegExpExecArray | null;
  if ((match = /Windows NT ([\d.]+)/.exec(ua))) {
    out.osName = 'Windows';
    out.osVersion = ({ '10.0': '10', '6.3': '8.1', '6.2': '8', '6.1': '7' } as Record<string, string>)[match[1]] ?? match[1];
  } else if ((match = /(?:iPhone|iPad|iPod).*? OS ([\d_]+)/.exec(ua))) {
    out.osName = 'iOS';
    out.osVersion = match[1].replace(/_/g, '.');
  } else if ((match = /Android ([\d.]+)/.exec(ua))) {
    out.osName = 'Android';
    out.osVersion = match[1];
  } else if ((match = /Mac OS X ([\d_.]+)/.exec(ua))) {
    out.osName = 'macOS';
    out.osVersion = match[1].replace(/_/g, '.');
  } else if (/CrOS/.test(ua)) {
    out.osName = 'ChromeOS';
  } else if (/Linux/.test(ua)) {
    out.osName = 'Linux';
  }
  return out;
}
