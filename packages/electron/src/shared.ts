/**
 * What the three entries agree on: the IPC channels between the main process and each window's
 * preload, and what main tells a window when it starts.
 */

export const CHANNEL = {
  /** Sync: a window asks for the context as its SDK starts. */
  context: 'zharp:context',
  /** Main → windows: the user or the session changed. */
  changed: 'zharp:context-changed',
  /** A batch from a window, for main to send (invoke; resolves to the HTTP status). */
  send: 'zharp:send',
  /** A window set or cleared the user. */
  user: 'zharp:user',
  /** A window's user logged out: a new session for everyone. */
  renew: 'zharp:renew',
  /** Something happened in a window: the session is still going. */
  activity: 'zharp:activity',
} as const;

export interface User {
  id: string | number;
  email?: string;
  name?: string;
}

/** What a window's SDK starts from: the app's settings, and the one session all windows share. */
export interface WindowContext {
  key: string;
  endpoint: string;
  service: string;
  release?: string;
  environment?: string;
  sessionId: string;
  sessionStarted: number;
  deviceId: string;
  user: User | null;
  /** Resource attributes every window sends: the Electron version, the OS, the device. */
  resource: Record<string, string>;
  /** Defaults for the windows, from the main process's `renderer` option. */
  renderer: Record<string, unknown>;
}

/** The bridge the preload puts on the page, as `window.__zharpElectron`. */
export interface Bridge {
  context(): WindowContext | null;
  send(signal: string, body: string): Promise<number>;
  setUser(user: User | null): void;
  renew(): void;
  activity(): void;
  onChange(listener: (context: WindowContext) => void): void;
}

export const BRIDGE_GLOBAL = '__zharpElectron';
