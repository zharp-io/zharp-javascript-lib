// Automatically collected at runtime — attached to every log entry's metadata.
// Developers don't need to pass any of this manually.
export interface RuntimeContext {
  // Browser fields
  url?: string;
  route?: string;
  userAgent?: string;
  screen?: string;
  // Node.js fields
  hostname?: string;
  pid?: string;
  nodeVersion?: string;
  platform?: string;
  // Both
  appVersion?: string;
}

const isBrowser = typeof window !== 'undefined';
const isNode = !isBrowser && typeof process !== 'undefined';

// Captured once per session since most values don't change at runtime. `appVersion` is kept
// out of the cache: a second init() may change it, and the rest of the context stays true.
let _cached: RuntimeContext | null = null;

export function getRuntimeContext(appVersion?: string): RuntimeContext {
  if (!_cached) {
    if (isBrowser) {
      _cached = {
        url: window.location.href,
        route: window.location.pathname,
        userAgent: navigator.userAgent,
        screen: `${window.screen.width}x${window.screen.height}`,
      };
    } else if (isNode) {
      // process.env.HOSTNAME is set automatically on Linux/Mac and in Docker/k8s
      // pods (where it's the pod name) — more useful than os.hostname() in cloud
      // deployments because it doesn't require importing the 'os' module.
      _cached = {
        hostname: process.env.HOSTNAME || process.env.HOST,
        pid: String(process.pid),
        nodeVersion: process.version,
        platform: process.platform,
      };
    } else {
      _cached = {};
    }
  }

  // A copy per entry: an entry waiting in the queue must not change when the route does.
  return { ..._cached, appVersion };
}

// Call this after a client-side route change (React Router, Vue Router etc.)
// so that url and route fields stay accurate for SPAs.
export function refreshContext(): void {
  if (_cached && isBrowser) {
    _cached.url = window.location.href;
    _cached.route = window.location.pathname;
  }
}
