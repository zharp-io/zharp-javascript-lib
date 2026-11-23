/**
 * What the main process sends for the windows, and its own crash events: each batch is sent with
 * Electron's network stack (the system's proxy settings, no Node instrumentation to trace it),
 * and kept on disk under `userData/zharp/outbox` when it can't go — offline, the server busy, the
 * app not ready yet. What's kept is sent at the next start, and every minute or so meanwhile.
 *
 * A crash event is written to disk before it is sent, so one that doesn't get out before the app
 * goes down is sent on the next launch.
 *
 * Capped at 200 batches and 20 MB; past that the oldest go.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export type Signal = 'traces' | 'logs';
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array }) => Promise<{ status: number }>;

const MAX_FILES = 200;
const MAX_BYTES = 20 * 1024 * 1024;
const RETRY_MS = 30_000;
const MAX_RETRY_MS = 10 * 60_000;

const retryable = (status: number) => status === 0 || status === 429 || status >= 500;

export class Outbox {
  private fetch: Fetch | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private draining: Promise<void> | null = null;
  private again = false;
  private rejected = false;

  constructor(
    private readonly dir: string,
    private readonly endpoint: string,
    private readonly key: string,
    private readonly debug: (message: string) => void = () => {},
  ) {}

  /** The network is usable (the app is ready): send what waited, then send as batches come. */
  start(fetch: Fetch): void {
    this.fetch = fetch;
    // Held by a run that ended before deciding: sent as they were written.
    try {
      for (const name of readdirSync(this.dir).filter((n) => n.endsWith('.held'))) renameSync(join(this.dir, name), join(this.dir, name.slice(0, -'.held'.length)));
    } catch {
      // No folder yet.
    }
    void this.drain();
  }

  /**
   * Send one batch now; kept on disk when it can't go. Resolves to the HTTP status, or 202 when
   * it was kept: the window must not queue it again.
   */
  async send(signal: Signal, json: string): Promise<number> {
    const body = gzipSync(json);
    if (!this.fetch) return this.store(signal, body) ? 202 : 0;
    const status = await this.post(signal, body);
    if (!retryable(status)) return status;
    this.schedule();
    return this.store(signal, body) ? 202 : status;
  }

  /**
   * Kept on disk but not sent yet, while main waits to know what to send (a crash event, until
   * its minidump's upload is seen). One left by a run that ended meanwhile is sent at the next
   * start, as it was written.
   */
  hold(signal: Signal, json: string): string | null {
    return this.store(signal, gzipSync(json), '.held');
  }

  /** Send a held batch now, as `json` (the held one replaced). */
  release(name: string | null, json: string): void {
    if (name) rmSync(join(this.dir, name), { force: true });
    const signal: Signal = name?.includes('.traces.') ? 'traces' : 'logs';
    void this.sendDurably(signal, json);
  }

  /** Written first, then sent: for what must survive the app going down. */
  async sendDurably(signal: Signal, json: string): Promise<void> {
    const file = this.store(signal, gzipSync(json));
    if (!this.fetch || !file) return;
    await this.drain();
  }

  /** Send everything kept on disk, oldest first, until one can't go. */
  drain(): Promise<void> {
    // One at a time; asked again meanwhile, it runs once more after, for what was written since.
    if (this.draining) {
      this.again = true;
      return this.draining;
    }
    this.draining = this.drainNow().finally(() => {
      this.draining = null;
      if (this.again) {
        this.again = false;
        void this.drain();
      }
    });
    return this.draining;
  }

  private async drainNow(): Promise<void> {
    if (!this.fetch) return;
    // Until the folder is empty: a batch written while this runs (a crash event) is sent too.
    const tried = new Set<string>();
    for (;;) {
      const names = this.files().filter((name) => !tried.has(name));
      if (!names.length) return;
      for (const name of names) {
        tried.add(name);
        const path = join(this.dir, name);
        let body: Buffer;
        try {
          body = readFileSync(path);
        } catch {
          continue;
        }
        const signal: Signal = name.includes('.traces.') ? 'traces' : 'logs';
        const status = await this.post(signal, body);
        if (retryable(status)) {
          this.failures++;
          this.schedule();
          return;
        }
        this.failures = 0;
        // Delivered, or refused for good: either way it's done.
        rmSync(path, { force: true });
      }
    }
  }

  private async post(signal: Signal, body: Uint8Array): Promise<number> {
    if (this.rejected) return 401;
    try {
      const response = await this.fetch!(`${this.endpoint}/v1/${signal}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Authorization: `Bearer ${this.key}` },
        body,
      });
      if ((response.status === 401 || response.status === 403) && !this.rejected) {
        this.rejected = true;
        console.warn(`[Zharp] The key was rejected (HTTP ${response.status}); nothing more will be sent from the windows. Check Zharp.init({ key }).`);
      }
      return response.status;
    } catch (error) {
      this.debug(`Couldn't send (${(error as Error)?.message ?? error}); kept for later`);
      return 0;
    }
  }

  private schedule(): void {
    if (this.timer) return;
    const delay = Math.min(RETRY_MS * 2 ** Math.max(0, this.failures - 1), MAX_RETRY_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, delay);
    this.timer.unref?.();
  }

  /** The files waiting, oldest first. */
  private files(): string[] {
    try {
      return readdirSync(this.dir).filter((name) => name.endsWith('.json.gz')).sort();
    } catch {
      return [];
    }
  }

  private store(signal: Signal, body: Buffer, suffix = ''): string | null {
    try {
      mkdirSync(this.dir, { recursive: true });
      // Time first, so names sort oldest first; the random part keeps two in one millisecond apart.
      const name = `${String(Date.now()).padStart(14, '0')}-${randomBytes(4).toString('hex')}.${signal}.json.gz${suffix}`;
      writeFileSync(join(this.dir, name), body);
      this.trim();
      return name;
    } catch (error) {
      this.debug(`Couldn't keep a batch on disk: ${(error as Error)?.message ?? error}`);
      return null;
    }
  }

  private trim(): void {
    const files = this.files();
    let total = 0;
    const sizes = files.map((name) => {
      try {
        return statSync(join(this.dir, name)).size;
      } catch {
        return 0;
      }
    });
    for (const size of sizes) total += size;
    let i = 0;
    while (i < files.length && (files.length - i > MAX_FILES || total > MAX_BYTES)) {
      rmSync(join(this.dir, files[i]), { force: true });
      total -= sizes[i];
      i++;
    }
  }
}
