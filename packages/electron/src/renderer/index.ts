/**
 * @zharp/electron/renderer: errors, logs and traces from a window, sent through the main process.
 *
 *     import { Zharp } from '@zharp/electron/renderer';
 *     Zharp.init();
 *
 * It is @zharp/browser — uncaught errors and rejections, page loads, fetch and XHR spans with
 * their headers, `traceparent` to your own APIs, the console when asked — with three differences:
 *
 * - Batches go to the main process over IPC and main sends them: no request from the page, so a
 *   strict Content-Security-Policy (`connect-src 'self'`) needs no exception, and batches wait in
 *   main's queue on disk while the computer is offline.
 * - Every window is in the main process's session, with its user and device ID.
 * - The key, service, release and environment come from `Zharp.init()` in main: nothing to pass
 *   here unless a window should differ (`Zharp.init({ captureBodies: 'errors' })`).
 *
 * Needs the preload bridge (added by main's `Zharp.init()`, or `import '@zharp/electron/preload'`
 * in your preload). Without it, it says so once and sends nothing.
 */
import { ZharpBrowser } from '../../../browser/src/client';
import { Session, type SessionState } from '../../../browser/src/session';
import type { BrowserOptions, ZharpUser } from '../../../browser/src/types';
import { BRIDGE_GLOBAL, type Bridge, type WindowContext } from '../shared';
import { VERSION } from '../version';

export type { ZharpUser, Attributes, CaptureBodies, CaptureBodiesOptions } from '../../../browser/src/types';
export type { ZharpSpan } from '../../../browser/src/client';

/** What a window can set for itself; the rest comes from the main process. */
export type RendererOptions = Omit<BrowserOptions, 'key' | 'endpoint' | 'replay' | 'sessionTimeoutMinutes'>;

/** The main process's session, as the browser SDK's session: read from main, changed through main. */
class SharedSession extends Session {
  private shared: SessionState;

  constructor(private readonly bridge: Bridge, context: WindowContext) {
    super(Number.MAX_SAFE_INTEGER, { get: () => null, set: () => {} });
    this.shared = { id: context.sessionId, started: context.sessionStarted, lastActive: Date.now(), user: context.user };
  }

  follow(context: WindowContext): void {
    this.shared = { ...this.shared, id: context.sessionId, started: context.sessionStarted, user: context.user };
  }

  override get current(): SessionState {
    return this.shared;
  }

  override get id(): string {
    return this.shared.id;
  }

  override touch(): void {
    this.shared.lastActive = Date.now();
    this.bridge.activity();
  }

  /** Logout in one window: main starts a new session and tells every window. */
  override renew(user?: ZharpUser | null): void {
    if (user === null) this.bridge.setUser(null);
    this.bridge.renew();
  }

  override update(patch: Partial<SessionState>): void {
    if ('user' in patch && !sameUser(patch.user ?? null, this.shared.user ?? null)) {
      this.shared.user = patch.user ?? null;
      this.bridge.setUser(patch.user ?? null);
    }
  }

  override onRenew(): void {
    // Replay is the only listener, and it isn't offered here.
  }
}

function sameUser(a: ZharpUser | null, b: ZharpUser | null): boolean {
  if (!a || !b) return a === b;
  return String(a.id) === String(b.id) && a.email === b.email && a.name === b.name;
}

function bridge(): Bridge | null {
  const value = (globalThis as any)[BRIDGE_GLOBAL];
  return value && typeof value.send === 'function' ? (value as Bridge) : null;
}

/** A fetch that hands the body to main: all the browser SDK's transport reads back is the status. */
function sendThrough(b: Bridge): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const signal = /\/v1\/(traces|logs)$/.exec(url)?.[1];
    if (!signal || typeof init?.body !== 'string') return { status: 400 } as Response;
    const status = await b.send(signal, init.body);
    return { status } as Response;
  }) as typeof fetch;
}

export class ZharpElectronRenderer extends ZharpBrowser {
  private readonly bridged: Bridge | null;
  private readonly session: SharedSession | null;
  private readonly startContext: WindowContext | null;

  constructor() {
    const b = bridge();
    const context = b ? safeContext(b) : null;
    const session = b && context ? new SharedSession(b, context) : null;
    super(
      b && session
        ? {
            fetch: sendThrough(b),
            session,
            resource: { ...context!.resource, 'zharp.sdk.platform': 'electron', 'electron.process.type': 'renderer' },
            scope: { name: '@zharp/electron', version: VERSION },
          }
        : undefined,
    );
    this.bridged = b;
    this.session = session;
    this.startContext = context;
  }

  /** Starts the SDK in this window, with the main process's key, service, release and session. */
  override init(options: RendererOptions = {}): void {
    try {
      const b = this.bridged;
      const context = this.startContext;
      if (!b || !context) {
        console.warn(
          "[Zharp] @zharp/electron/renderer can't reach the main process: start Zharp in main (Zharp.init from '@zharp/electron/main'), " +
            "and if main is bundled, add import '@zharp/electron/preload' to your preload. Nothing will be sent from this window.",
        );
        return;
      }
      const settings = { ...(context.renderer as RendererOptions), ...options };
      super.init({
        ...settings,
        key: context.key,
        endpoint: context.endpoint,
        service: settings.service ?? context.service,
        release: settings.release ?? context.release,
        environment: settings.environment ?? context.environment,
      });
      // The user from main, or set in another window: on everything this window sends.
      if (context.user) super.setUser(context.user);
      b.onChange((next) => {
        this.session?.follow(next);
        super.setUser(next.user);
      });
    } catch {
      // A broken SDK must not take the window down with it.
    }
  }

  /** The device ID main keeps for this installation. */
  get deviceId(): string | undefined {
    return this.startContext?.deviceId;
  }
}

function safeContext(b: Bridge): WindowContext | null {
  try {
    return b.context();
  } catch {
    return null;
  }
}

// One per window, kept where @zharp/browser keeps its own: @zharp/browser/react's error boundary
// finds it there.
const g = globalThis as any;
export const Zharp: ZharpElectronRenderer =
  g.__ZHARP_BROWSER__ instanceof ZharpElectronRenderer ? g.__ZHARP_BROWSER__ : (g.__ZHARP_BROWSER__ = new ZharpElectronRenderer());
export default Zharp;
export { VERSION };
