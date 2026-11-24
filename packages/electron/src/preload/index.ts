/**
 * @zharp/electron/preload: the bridge a window's SDK sends through.
 *
 * `Zharp.init()` in the main process adds this file to every session's preloads by itself; import
 * it from your own preload only when main is bundled (Electron Forge + Vite or webpack, where
 * node_modules aren't shipped and the file can't be found):
 *
 *     // preload.ts
 *     import '@zharp/electron/preload';
 *
 * Built as one CommonJS file that needs nothing but electron, so it runs in a sandboxed preload.
 * It exposes `window.__zharpElectron` (through contextBridge when the window is isolated): the
 * context main started with, a way to hand main a batch, and the user. It also puts the session
 * and user on this renderer's crash reports.
 */
import { contextBridge, crashReporter, ipcRenderer } from 'electron';
import { BRIDGE_GLOBAL, CHANNEL, type Bridge, type User, type WindowContext } from '../shared';

const g = globalThis as any;

function crashParameters(context: WindowContext | null): void {
  if (!context) return;
  try {
    crashReporter.addExtraParameter('zharp.session_id', context.sessionId);
    if (context.user) {
      crashReporter.addExtraParameter('zharp.user.id', String(context.user.id));
      if (context.user.email) crashReporter.addExtraParameter('zharp.user.email', context.user.email);
    } else {
      crashReporter.removeExtraParameter('zharp.user.id');
      crashReporter.removeExtraParameter('zharp.user.email');
    }
  } catch {
    // The crash reporter isn't running (crashReporter: false): nothing to label.
  }
}

// Once per window, whether it came from the session's preloads, the app's own preload, or both.
if (!g.__zharpPreloaded) {
  g.__zharpPreloaded = true;
  let context: WindowContext | null = null;
  const listeners: Array<(context: WindowContext) => void> = [];

  const read = (): WindowContext | null => {
    if (context) return context;
    try {
      context = ipcRenderer.sendSync(CHANNEL.context) ?? null;
    } catch {
      context = null;
    }
    crashParameters(context);
    return context;
  };

  ipcRenderer.on(CHANNEL.changed, (_event, next: WindowContext) => {
    context = next;
    crashParameters(next);
    for (const listener of listeners) {
      try {
        listener(next);
      } catch {
        // A listener's failure isn't the bridge's.
      }
    }
  });

  let lastActivity = 0;
  const bridge: Bridge = {
    context: read,
    send: (signal: string, body: string) => ipcRenderer.invoke(CHANNEL.send, signal, body).catch(() => 0),
    setUser: (user: User | null) => ipcRenderer.send(CHANNEL.user, user),
    renew: () => ipcRenderer.send(CHANNEL.renew),
    activity: () => {
      // Main only needs to hear it now and then: the session times out after minutes, not seconds.
      const now = Date.now();
      if (now - lastActivity < 10_000) return;
      lastActivity = now;
      ipcRenderer.send(CHANNEL.activity);
    },
    onChange: (listener) => void listeners.push(listener),
  };

  read();
  try {
    contextBridge.exposeInMainWorld(BRIDGE_GLOBAL, bridge);
  } catch {
    // Not isolated (contextIsolation: false): the preload shares the page's window.
    (globalThis as any)[BRIDGE_GLOBAL] = bridge;
  }
}
