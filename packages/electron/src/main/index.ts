/**
 * @zharp/electron/main: Zharp in an Electron app's main process, and the hub for its windows.
 *
 *     import { Zharp } from '@zharp/electron/main';
 *     Zharp.init({ key: 'zpk_…' });
 *
 * Call it first in main, before `app.whenReady()`. It:
 *
 * - starts @zharp/node: main's errors (counted once, with the code that ran), its requests with
 *   their headers, failed queries, logs when asked for;
 * - starts Electron's crash reporter with Zharp's minidump endpoint, so a native crash in any
 *   process (main, a window, the GPU process) arrives with its dump, walked with Electron's own
 *   symbols on Zharp's side;
 * - reports a window's or a helper process's crash at once ("render-process-gone",
 *   "child-process-gone"), kept on disk until it's sent;
 * - keeps one session for the whole app, a device ID per installation, and the user, and hands
 *   them to every window;
 * - adds its preload to every session, so `@zharp/electron/renderer` in a window can send
 *   through main: one queue, on disk while offline, and no outside URL in the page's CSP.
 *
 * Stacks are written with the install folder as `app:///` (`app:///dist/main.js`), so every
 * install groups into the same issue.
 */
import { app, BrowserWindow, crashReporter, dialog, ipcMain, net, session as electronSession, webContents, type Session, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { release as osRelease } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Zharp as NodeZharp, type NodeOptions } from '@zharp/node';
import { CHANNEL, type User, type WindowContext } from '../shared';
import { VERSION } from '../version';
import { Outbox, type Signal } from './outbox';
import { appPathRewrite } from './paths';

export type { User as ZharpUser } from '../shared';

export const DEFAULT_ENDPOINT = 'https://api.zharp.io/api/v1/otlp';
const SEVERITY = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 } as const;
type Level = keyof typeof SEVERITY;
type Attributes = Record<string, unknown>;
type LogFn = (message: unknown, attributes?: Attributes) => void;

export interface ElectronOptions extends Omit<NodeOptions, 'rewritePaths' | 'captureUncaught'> {
  /** The app's key from the Zharp dashboard (`zpk_…`). It can only send, so it's safe to ship in the app. */
  key?: string;
  /** `service.name`. Default: the app's name (`app.getName()`). */
  service?: string;
  /** `service.version`. Default: the app's version (`app.getVersion()`), which is also what its crash reports carry. */
  release?: string;
  /** `deployment.environment.name`. Default: `production` in a packaged app, `development` otherwise. */
  environment?: string;
  /**
   * Native crashes: Electron's crash reporter (Crashpad) sends a minidump of any process that
   * crashes to Zharp. Default **true**. `false` leaves the crash reporter alone, for an app that
   * starts it itself.
   */
  crashReporter?: boolean;
  /** Where minidumps go. Default: Zharp's minidump endpoint next to `endpoint`. */
  minidumpUrl?: string;
  /**
   * Add the windows' preload to every session. Default **true**. When main is bundled and
   * node_modules isn't shipped, import '@zharp/electron/preload' in your own preload instead.
   */
  preload?: boolean;
  /**
   * Settings for every window's SDK (`@zharp/electron/renderer`): `tracingOrigins`,
   * `captureBodies`, `captureConsole`, `sampleRate`… A window's own `Zharp.init({…})` adds to them.
   */
  renderer?: Record<string, unknown>;
  /** Minutes without activity in any window before a new session starts. Default 30. */
  sessionTimeoutMinutes?: number;
  /** Report uncaught exceptions and unhandled rejections in main. Default true. */
  captureUncaught?: boolean;
}

interface Running {
  options: ElectronOptions;
  key: string;
  endpoint: string;
  service: string;
  release?: string;
  environment?: string;
  deviceId: string;
  session: { id: string; started: number; lastActive: number };
  timeoutMs: number;
  resource: Record<string, string>;
  rewrite: (text: string) => string;
  outbox: Outbox;
  teardowns: Array<() => void>;
}

function osName(): string {
  return process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : process.platform === 'linux' ? 'Linux' : process.platform;
}

function osVersion(): string {
  try {
    return (process as any).getSystemVersion?.() || osRelease();
  } catch {
    return osRelease();
  }
}

/** The installation's ID: made once, kept in userData. */
function deviceIdIn(dir: string): string {
  const path = join(dir, 'device-id');
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (/^[\w-]{8,64}$/.test(existing)) return existing;
  } catch {
    // First run.
  }
  const id = randomUUID();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, id);
  } catch {
    // Not writable: this run's ID only.
  }
  return id;
}

/** This file's folder, in the CommonJS and the ES build: the preload sits next to it. */
function here(): string {
  try {
    return typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
  } catch {
    return '';
  }
}

/** `https://api.zharp.io/api/v1/otlp` → `https://api.zharp.io/api/v1/minidump`. */
export function minidumpUrlFor(endpoint: string, key: string): string {
  const base = endpoint.replace(/\/+$/, '').replace(/\/otlp$/, '');
  return `${base}/minidump?key=${encodeURIComponent(key)}`;
}

const str = (value: unknown) => ({ stringValue: String(value) });
const keyValues = (attributes: Record<string, unknown>) =>
  Object.entries(attributes)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([key, value]) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : str(value) }));

export class ZharpElectron {
  private running: Running | null = null;
  private user: User | null = null;
  private readonly tags: Record<string, string | number | boolean> = {};
  /** Crash reports already uploaded (earlier runs) or matched to a crash: never matched again. */
  private readonly knownReports = new Set<string>();

  /** `Zharp.log.info("Order placed", { orderId })` — and debug, warn, error, fatal, trace. */
  readonly log: Record<Level, LogFn> = NodeZharp.log;

  get isActive(): boolean {
    return this.running !== null;
  }

  /** The app's current session (shared by main and every window). */
  get sessionId(): string | undefined {
    return this.running ? this.currentSession(this.running).id : undefined;
  }

  /** This installation's ID (`device.id`). */
  get deviceId(): string | undefined {
    return this.running?.deviceId;
  }

  init(options: ElectronOptions = {}): void {
    try {
      if (this.running) {
        console.warn("[Zharp] Zharp.init() was called again — the first call's settings stay in effect.");
        return;
      }
      if (process.type && process.type !== 'browser') {
        console.warn("[Zharp] @zharp/electron/main runs in the main process. In a window, use '@zharp/electron/renderer'.");
        return;
      }
      const key = options.key || process.env.ZHARP_KEY || process.env.ZHARP_API_KEY;
      if (!key) {
        console.warn('[Zharp] Zharp.init({ key }) needs the app key from the Zharp dashboard. Nothing will be sent.');
        return;
      }
      this.start(options, key);
    } catch (error) {
      console.warn(`[Zharp] Could not start: ${(error as Error)?.message ?? error}`);
    }
  }

  private start(options: ElectronOptions, key: string): void {
    const endpoint = (options.endpoint || process.env.ZHARP_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, '');
    const service = options.service || app.getName();
    const release = options.release || app.getVersion() || undefined;
    const environment = options.environment || (app.isPackaged ? 'production' : 'development');
    const dataDir = join(app.getPath('userData'), 'zharp');
    const deviceId = deviceIdIn(dataDir);
    const now = Date.now();
    const debug = options.debug ? (message: string) => console.debug(`[Zharp] ${message}`) : () => {};
    const resource = {
      'device.id': deviceId,
      'os.name': osName(),
      'os.version': osVersion(),
      'host.arch': process.arch,
      'electron.version': process.versions.electron ?? '',
      'zharp.sdk.platform': 'electron',
    };
    const running: Running = {
      options,
      key,
      endpoint,
      service,
      release,
      environment,
      deviceId,
      session: { id: randomUUID(), started: now, lastActive: now },
      timeoutMs: (options.sessionTimeoutMinutes ?? 30) * 60_000,
      resource,
      rewrite: appPathRewrite(app.getAppPath()),
      outbox: new Outbox(join(dataDir, 'outbox'), endpoint, key, debug),
      teardowns: [],
    };
    this.running = running;

    // Native crashes first: the earlier the crash reporter runs, the fewer crashes it misses.
    if (options.crashReporter !== false) this.startCrashReporter(running);

    // The main process is Node: everything @zharp/node does, with the install folder out of stacks.
    const { crashReporter: _c, minidumpUrl: _m, preload: _p, renderer: _r, sessionTimeoutMinutes: _s, captureUncaught, ...nodeOptions } = options;
    const before = new Set(process.listeners('uncaughtException'));
    const beforeRejection = new Set(process.listeners('unhandledRejection'));
    NodeZharp.init({ ...nodeOptions, key, endpoint, service, release, environment, captureUncaught, rewritePaths: running.rewrite });
    for (const [k, v] of Object.entries({ ...resource, 'electron.process.type': 'browser' })) NodeZharp.setTag(k, v);
    NodeZharp.setTag('session.id', running.session.id);
    for (const [k, v] of Object.entries(this.tags)) NodeZharp.setTag(k, v);
    if (this.user) NodeZharp.setUser(this.user);
    if (captureUncaught !== false) this.keepElectronsDialog(running, before, beforeRejection);

    this.listen(running);
    app.whenReady().then(() => {
      if (this.running !== running) return;
      running.outbox.start((url, init) => net.fetch(url, init as any));
      if (options.preload !== false) this.addPreload(running);
    }, () => {});
  }

  // ── public API ────────────────────────────────────────────────────────

  /**
   * Who is using the app: `enduser.id` (and `enduser.email`, `enduser.name`) on everything main
   * and every window send from now on, and on crash reports. Call it after login.
   */
  setUser(user: User | null): void {
    try {
      this.user = user && user.id !== undefined && user.id !== null && user.id !== '' ? { id: user.id, email: user.email, name: user.name } : null;
      const running = this.running;
      if (!running) return;
      NodeZharp.setUser(this.user);
      this.crashParameters();
      this.broadcast(running);
    } catch {
      // Never throw into the app.
    }
  }

  /** Forget the user and start a new session — call it on logout. */
  clearUser(): void {
    this.setUser(null);
    if (this.running) this.renew(this.running);
  }

  /** An attribute on everything main sends from now on. `null` removes it. */
  setTag(key: string, value: string | number | boolean | null | undefined): void {
    if (value === null || value === undefined) delete this.tags[key];
    else this.tags[key] = value;
    if (this.running) NodeZharp.setTag(key, value);
  }

  /** Report an error you caught in main. Sent as handled, grouped with its other occurrences. */
  captureError(error: unknown, attributes?: Attributes): void {
    NodeZharp.captureError(error, attributes);
  }

  /** Run `fn` in a span named `name` (see @zharp/node). */
  startSpan<T>(name: string, fn: (span: any) => T, options?: Parameters<typeof NodeZharp.startSpan>[2]): T {
    return NodeZharp.startSpan(name, fn, options);
  }

  /** Send everything waiting now: main's own, and the windows' batches kept on disk. */
  async flush(timeoutMs = 5_000): Promise<void> {
    const running = this.running;
    if (!running) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([NodeZharp.flush(timeoutMs), running.outbox.drain()]).catch(() => {}),
      // Kept referenced: while quitting, an unreferenced timer may never fire.
      new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs))),
    ]).finally(() => clearTimeout(timer));
  }

  /** Flush and stop. */
  async close(): Promise<void> {
    const running = this.running;
    if (!running) return;
    await this.flush();
    for (const undo of running.teardowns.splice(0)) {
      try {
        undo();
      } catch {
        // Keep going.
      }
    }
    await NodeZharp.shutdown().catch(() => {});
    this.running = null;
  }

  // ── internals ─────────────────────────────────────────────────────────

  private startCrashReporter(running: Running): void {
    try {
      const extra: Record<string, string> = {
        'zharp.release': running.release ?? '',
        'zharp.environment': running.environment ?? '',
        'zharp.service': running.service,
        'zharp.device_id': running.deviceId,
      };
      for (const k of Object.keys(extra)) if (!extra[k]) delete extra[k];
      crashReporter.start({
        submitURL: running.options.minidumpUrl || minidumpUrlFor(running.endpoint, running.key),
        productName: running.service,
        uploadToServer: true,
        compress: true,
        // Every process's reports: the GPU process and utility processes too.
        globalExtra: extra,
      });
      for (const report of crashReporter.getUploadedReports()) this.knownReports.add(report.id);
      this.crashParameters();
    } catch (error) {
      console.warn(`[Zharp] Couldn't start the crash reporter: ${(error as Error)?.message ?? error}`);
    }
  }

  /** The session and user on main's own crash reports (each window's preload labels its own). */
  private crashParameters(): void {
    const running = this.running;
    if (!running || running.options.crashReporter === false) return;
    try {
      crashReporter.addExtraParameter('zharp.session_id', running.session.id);
      if (this.user) {
        crashReporter.addExtraParameter('zharp.user.id', String(this.user.id));
        if (this.user.email) crashReporter.addExtraParameter('zharp.user.email', this.user.email);
      } else {
        crashReporter.removeExtraParameter('zharp.user.id');
        crashReporter.removeExtraParameter('zharp.user.email');
      }
    } catch {
      // Not started.
    }
  }

  private currentSession(running: Running): Running['session'] {
    if (Date.now() - running.session.lastActive >= running.timeoutMs) this.renew(running);
    return running.session;
  }

  private touch(running: Running): void {
    this.currentSession(running).lastActive = Date.now();
  }

  private renew(running: Running): void {
    const now = Date.now();
    running.session = { id: randomUUID(), started: now, lastActive: now };
    NodeZharp.setTag('session.id', running.session.id);
    this.crashParameters();
    this.broadcast(running);
  }

  private context(running: Running): WindowContext {
    const session = this.currentSession(running);
    return {
      key: running.key,
      endpoint: running.endpoint,
      service: running.service,
      release: running.release,
      environment: running.environment,
      sessionId: session.id,
      sessionStarted: session.started,
      deviceId: running.deviceId,
      user: this.user,
      resource: running.resource,
      renderer: running.options.renderer ?? {},
    };
  }

  /** Every window hears that the session or the user changed. */
  private broadcast(running: Running): void {
    const context = this.context(running);
    for (const contents of webContents.getAllWebContents()) {
      try {
        if (!contents.isDestroyed()) contents.send(CHANNEL.changed, context);
      } catch {
        // A window going away.
      }
    }
  }

  private listen(running: Running): void {
    const t = running.teardowns;
    const on = (channel: string, listener: (...args: any[]) => void) => {
      ipcMain.on(channel, listener);
      t.push(() => ipcMain.removeListener(channel, listener));
    };
    on(CHANNEL.context, (event) => {
      event.returnValue = this.context(running);
    });
    on(CHANNEL.user, (_event, user: User | null) => this.setUser(user && typeof user === 'object' ? user : null));
    on(CHANNEL.renew, () => this.renew(running));
    on(CHANNEL.activity, () => this.touch(running));
    ipcMain.handle(CHANNEL.send, async (_event, signal: unknown, body: unknown) => {
      if ((signal !== 'logs' && signal !== 'traces') || typeof body !== 'string' || body.length > 4_000_000) return 400;
      this.touch(running);
      return running.outbox.send(signal as Signal, running.rewrite(body));
    });
    t.push(() => ipcMain.removeHandler(CHANNEL.send));

    // A window or a helper process went away abnormally: reported now, from main, which is still
    // running. Its minidump (when it crashed) arrives separately, with the native stack.
    const onRenderGone = (_event: unknown, contents: WebContents, details: { reason: string; exitCode: number }) => {
      if (details.reason === 'clean-exit') return;
      let url = '';
      let title = '';
      try {
        url = contents.getURL();
        title = contents.getTitle();
      } catch {
        // Already destroyed.
      }
      this.processGone(running, 'renderer', details.reason, details.exitCode, {
        'url.full': running.rewrite(url),
        'electron.window.title': title,
      });
    };
    const onChildGone = (_event: unknown, details: { type: string; reason: string; exitCode: number; serviceName?: string; name?: string }) => {
      if (details.reason === 'clean-exit') return;
      this.processGone(running, details.type, details.reason, details.exitCode, {
        'electron.process.service_name': details.serviceName,
        'electron.process.name': details.name,
      });
    };
    app.on('render-process-gone', onRenderGone as any);
    app.on('child-process-gone', onChildGone as any);
    t.push(() => app.removeListener('render-process-gone', onRenderGone as any), () => app.removeListener('child-process-gone', onChildGone as any));

    // Windows as screens: the focused window's title on what main sends.
    const onFocus = (_event: unknown, window: BrowserWindow) => {
      this.touch(running);
      try {
        NodeZharp.setTag('app.screen.name', window.getTitle() || `window ${window.id}`);
      } catch {
        // Destroyed.
      }
    };
    app.on('browser-window-focus', onFocus as any);
    t.push(() => app.removeListener('browser-window-focus', onFocus as any));

    // Quitting: what's waiting goes out first (two seconds at most).
    let flushed = false;
    const onWillQuit = (event: { preventDefault(): void }) => {
      if (flushed) return;
      flushed = true;
      event.preventDefault();
      const debug = running.options.debug ? (m: string) => console.debug(`[Zharp] ${m}`) : () => {};
      debug('Quitting: sending what is waiting first');
      this.flush(2_000).finally(() => {
        debug('Sent; quitting');
        // The quit was already under way (every will-quit listener has run): finish it. A second
        // app.quit() here is sometimes ignored, leaving the app running with no windows.
        app.exit();
      });
    };
    app.on('will-quit', onWillQuit as any);
    t.push(() => app.removeListener('will-quit', onWillQuit as any));

    const timer = setInterval(() => this.currentSession(running), 60_000);
    timer.unref?.();
    t.push(() => clearInterval(timer));
  }

  /**
   * A process that went away, reported from main, which is still running.
   *
   * When it crashed and the crash reporter is on, Electron's crash reporter uploads its minidump
   * too — the crash with its native stack, as its own issue. The two would be one crash counted
   * twice, so main waits for that upload (Zharp answers it with the crash's ID, which Electron
   * lists in getUploadedReports): once it's there, this is sent as a log line naming the crash
   * (`zharp.minidump_id`) instead of a second error. Without a dump (killed, out of memory, the
   * crash reporter off, the upload failing), it's sent as the error. Either way it's on disk
   * first, so an app that goes down meanwhile sends the error on its next start.
   */
  private processGone(running: Running, type: string, reason: string, exitCode: number, attributes: Attributes): void {
    try {
      const goneAt = Date.now();
      const kind = type === 'renderer' ? 'Renderer' : type === 'GPU' ? 'GPU' : type;
      const exceptionType = `${kind.replace(/s+/g, '')}ProcessGone`;
      const what = type === 'renderer' ? 'A window' : `The ${type} process`;
      const how =
        reason === 'crashed' ? 'crashed' : reason === 'oom' ? 'ran out of memory' : reason === 'killed' ? 'was killed' : reason === 'launch-failed' ? "couldn't start" : reason === 'integrity-failure' ? 'failed its code integrity check' : `exited abnormally`;
      const message = `${what} ${how} (${reason}, exit code ${exitCode})`;
      const time = `${goneAt}000000`;
      const user = this.user;
      const context = {
        ...this.tags,
        ...attributes,
        'zharp.mechanism': type === 'renderer' ? 'render-process-gone' : 'child-process-gone',
        'electron.process.type': type,
        'electron.process.reason': reason,
        'electron.process.exit_code': exitCode,
        'session.id': running.session.id,
        'enduser.id': user ? String(user.id) : undefined,
        'enduser.email': user?.email,
        'enduser.name': user?.name,
      };
      const envelope = (record: unknown) =>
        JSON.stringify({
          resourceLogs: [
            {
              resource: {
                attributes: keyValues({
                  'service.name': running.service,
                  'service.version': running.release,
                  'deployment.environment.name': running.environment,
                  'telemetry.sdk.name': 'zharp',
                  'telemetry.sdk.language': 'nodejs',
                  'telemetry.sdk.version': VERSION,
                  ...running.resource,
                }),
              },
              scopeLogs: [{ scope: { name: '@zharp/electron', version: VERSION }, logRecords: [record] }],
            },
          ],
        });
      const asError = envelope({
        timeUnixNano: time,
        observedTimeUnixNano: time,
        severityNumber: SEVERITY.fatal,
        severityText: 'FATAL',
        body: str(`${exceptionType}: ${message}`),
        attributes: keyValues({ ...context, 'exception.type': exceptionType, 'exception.message': message, 'zharp.handled': 'false' }),
      });
      const asLine = (minidumpId: string) =>
        envelope({
          timeUnixNano: time,
          observedTimeUnixNano: time,
          severityNumber: SEVERITY.warn,
          severityText: 'WARN',
          body: str(`${message}; its crash report is ${minidumpId}`),
          attributes: keyValues({ ...context, 'zharp.minidump_id': minidumpId }),
        });

      const dumpExpected = reason === 'crashed' && running.options.crashReporter !== false;
      if (!dumpExpected) {
        void running.outbox.sendDurably('logs', asError);
        return;
      }
      const held = running.outbox.hold('logs', asError);
      void this.minidumpUploaded().then((id) => {
        running.outbox.release(held, id ? asLine(id) : asError);
      });
    } catch {
      // Never throw into the app.
    }
  }

  /**
   * The ID Zharp gave the next crash report Electron uploads, waiting up to 15 seconds for it. A
   * report is new when it wasn't in the list when Zharp started or claimed by an earlier crash.
   */
  private async minidumpUploaded(): Promise<string | null> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        for (const report of crashReporter.getUploadedReports()) {
          if (this.knownReports.has(report.id)) continue;
          this.knownReports.add(report.id);
          return report.id;
        }
      } catch {
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  }

  /**
   * Electron shows a dialog for an uncaught exception in main — but only while no one else
   * listens, and @zharp/node does. So once Zharp has reported it, the dialog is shown as Electron
   * would have, unless the app has a listener of its own. An unhandled rejection is reported and
   * left as Electron leaves it (printed), never turned into an exit.
   */
  private keepElectronsDialog(running: Running, before: Set<Function>, beforeRejection: Set<Function>): void {
    const nodeOnes = new Set(process.listeners('uncaughtException').filter((l) => !before.has(l)));
    const nodeRejection = new Set(process.listeners('unhandledRejection').filter((l) => !beforeRejection.has(l)));
    const onException = (error: unknown) => {
      const others = process.listeners('uncaughtException').filter((l) => l !== onException && !nodeOnes.has(l));
      // Electron's own default listener is one of the others; an app's would be a second.
      if (others.length > 1) return;
      const stack = error instanceof Error ? error.stack || `${error.name}: ${error.message}` : String(error);
      this.flush(2_000).finally(() => {
        try {
          dialog.showErrorBox('A JavaScript error occurred in the main process', `Uncaught Exception:\n${stack}`);
        } catch {
          process.stderr.write(`Uncaught Exception:\n${stack}\n`);
        }
      });
    };
    const onRejection = (reason: unknown) => {
      const others = process.listeners('unhandledRejection').filter((l) => l !== onRejection && !nodeRejection.has(l));
      if (others.length) return;
      const text = reason instanceof Error ? reason.stack || String(reason) : String(reason);
      process.stderr.write(`(electron) Unhandled promise rejection in the main process:\n${text}\n`);
    };
    process.on('uncaughtException', onException);
    process.on('unhandledRejection', onRejection);
    running.teardowns.push(() => process.off('uncaughtException', onException), () => process.off('unhandledRejection', onRejection));
  }

  /** The windows' preload, added to every session (the default one and any partition). */
  private addPreload(running: Running): void {
    const file = join(here(), 'preload.js');
    if (!existsSync(file)) {
      if (running.options.debug) console.debug(`[Zharp] No preload at ${file} (main is bundled?): import '@zharp/electron/preload' in your own preload.`);
      return;
    }
    const done = new WeakSet<Session>();
    const add = (s: Session) => {
      if (done.has(s)) return;
      done.add(s);
      try {
        if (typeof (s as any).registerPreloadScript === 'function') (s as any).registerPreloadScript({ type: 'frame', id: 'zharp-electron', filePath: file });
        else s.setPreloads([...s.getPreloads(), file]);
      } catch (error) {
        if (running.options.debug) console.debug(`[Zharp] Couldn't add the preload: ${(error as Error)?.message ?? error}`);
      }
    };
    add(electronSession.defaultSession);
    const onSession = (s: Session) => add(s);
    app.on('session-created', onSession);
    running.teardowns.push(() => app.removeListener('session-created', onSession));
  }
}

// One per process, kept on globalThis: the CommonJS and ES builds must reach the same one.
const g = globalThis as any;
export const Zharp: ZharpElectron = g.__ZHARP_ELECTRON__ ?? (g.__ZHARP_ELECTRON__ = new ZharpElectron());
export default Zharp;
export { VERSION };
