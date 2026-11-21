/**
 * The session: one person's continuous use of one tab.
 *
 * Kept in sessionStorage, so it survives reloads and navigations in the tab but a second tab
 * is a session of its own. That matters for replay: two tabs writing one recording would each
 * number their batches from the same counter and overwrite each other.
 *
 * A session ends after 30 minutes without activity (clicks, keys, scrolls, telemetry) and when
 * the user logs out (`clearUser`). Storage that throws — Safari private mode, a sandboxed
 * iframe, a full quota — leaves the session in memory for the life of the page.
 */
import { randomHex } from './util';
import type { ZharpUser } from './types';

const STORAGE_KEY = 'zharp.session';
/** Activity is written back at most this often; every click writing storage would be wasteful. */
const WRITE_EVERY_MS = 5_000;

export type ReplayMode = 'off' | 'session' | 'buffer';

export interface SessionState {
  id: string;
  started: number;
  lastActive: number;
  /** The replay decision, made once per session. Absent until replay has decided. */
  replay?: ReplayMode;
  /** Next replay batch number. Persisted so a reload does not reuse numbers the server already has. */
  seq?: number;
  user?: ZharpUser | null;
}

function newState(user: ZharpUser | null = null): SessionState {
  const time = Date.now();
  // A UUID's shape, from 16 random bytes.
  const hex = randomHex(16);
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20)}`;
  return { id, started: time, lastActive: time, user };
}

/** Where the session is kept: the tab's sessionStorage on the web, the device on mobile. */
export interface SessionStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const tabStorage: SessionStore = {
  get: (key) => sessionStorage.getItem(key),
  set: (key, value) => sessionStorage.setItem(key, value),
};

export class Session {
  private state: SessionState;
  private lastWrite = 0;
  private readonly listeners: Array<(state: SessionState) => void> = [];

  constructor(private readonly timeoutMs: number, private readonly store: SessionStore = tabStorage) {
    const stored = this.read();
    this.state = stored && Date.now() - stored.lastActive < timeoutMs ? stored : newState(stored?.user);
    this.write();
  }

  /** The current session, after starting a new one if this one has expired. */
  get current(): SessionState {
    if (Date.now() - this.state.lastActive >= this.timeoutMs) this.renew();
    return this.state;
  }

  get id(): string {
    return this.current.id;
  }

  /** Something happened: the session is still going. */
  touch(): void {
    const state = this.current;
    state.lastActive = Date.now();
    if (state.lastActive - this.lastWrite > WRITE_EVERY_MS) this.write();
  }

  /** Start a new session now. The user carries over unless `user` is given. */
  renew(user?: ZharpUser | null): void {
    this.state = newState(user === undefined ? this.state.user : user);
    this.write();
    for (const listener of this.listeners) listener(this.state);
  }

  update(patch: Partial<SessionState>): void {
    Object.assign(this.state, patch);
    this.write();
  }

  /** Called with the new state whenever a session ends and another begins. */
  onRenew(listener: (state: SessionState) => void): void {
    this.listeners.push(listener);
  }

  private read(): SessionState | null {
    try {
      const raw = this.store.get(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed.id === 'string' && typeof parsed.lastActive === 'number' ? parsed : null;
    } catch {
      return null;
    }
  }

  private write(): void {
    this.lastWrite = Date.now();
    try {
      this.store.set(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // In memory only.
    }
  }
}
