/**
 * Session replay, recorded with rrweb.
 *
 * This module is only reached through a dynamic import (or, in the script-tag build, its own
 * file), so rrweb — several times the size of the rest of the SDK — is downloaded only by
 * sessions that record.
 *
 * Two modes:
 * - **session**: everything is uploaded as it happens, a batch every few seconds.
 * - **buffer**: the last minute is kept in memory and nothing is sent. When an error happens
 *   the buffer is uploaded and the session carries on in session mode, so the replay shows what
 *   led up to the error and what came after.
 *
 * Batches are numbered per session. A number is fixed when its batch is cut and a retry reuses
 * it, so the server can drop duplicates; the next number is kept in the session's storage so a
 * reload carries on rather than starting again from 0.
 */
import { record } from 'rrweb';
import type { eventWithTime } from '@rrweb/types';
import { MAX_BODY_BYTES, MAX_KEEPALIVE_BYTES, post, retryable, sendOnHide, split } from '../transport';
import type { ReplayMode } from '../session';
import type { RecorderLike, RecorderModule, ReplayHost } from './host';
import type { ReplayEvent } from '../types';

const FLUSH_MS = 5_000;
const FLUSH_EVENTS = 500;
const MAX_EVENTS_PER_BATCH = 10_000;
/** In buffer mode a full snapshot is taken this often and at most two are kept: 30–60 s of history. */
const BUFFER_CHECKOUT_MS = 30_000;
/** In session mode, a fresh full snapshot this often bounds what a lost batch can break. */
const SESSION_CHECKOUT_MS = 5 * 60_000;
const MAX_PENDING = 30;
const MAX_ATTEMPTS = 3;
const MAX_TRACE_IDS = 200;
/** rrweb's Meta event, which starts every full snapshot. */
const META = 4;

interface Batch {
  sequence: number;
  body: string;
  attempts: number;
}

class Recorder implements RecorderLike {
  private stopRecording: (() => void) | undefined;
  private mode: ReplayMode;
  private sessionId: string;
  private sequence: number;
  /** Session mode: events since the last cut. Buffer mode: segments, each starting at a full snapshot. */
  private events: eventWithTime[] = [];
  private segments: eventWithTime[][] = [[]];
  private pending: Batch[] = [];
  /** Traces started during the events not yet cut, with when they started. */
  private traces = new Map<string, number>();
  private hasError = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly host: ReplayHost, mode: ReplayMode) {
    const session = host.session();
    this.sessionId = session.id;
    this.sequence = session.seq ?? 0;
    this.mode = mode;
    this.start();
  }

  linkTrace(traceId: string): void {
    if (this.traces.size < MAX_TRACE_IDS) this.traces.set(traceId, Date.now());
  }

  /** An error happened: from here on this session is one worth watching. */
  onError(): void {
    this.hasError = true;
    if (this.mode !== 'buffer') return;
    // Upload what led up to it, then keep recording everything — with session mode's longer
    // checkout interval, which means starting rrweb again.
    this.events = this.segments.flat();
    this.segments = [[]];
    this.mode = 'session';
    this.host.saveMode(this.sessionId, 'session');
    this.restart();
    this.flush();
  }

  renew(mode: ReplayMode): void {
    // What was recorded belongs to the old session: cut it under the old ID first.
    if (this.mode === 'session') this.cut(MAX_BODY_BYTES);
    this.flush();
    const session = this.host.session();
    this.sessionId = session.id;
    this.sequence = session.seq ?? 0;
    this.events = [];
    this.segments = [[]];
    this.traces.clear();
    this.hasError = false;
    this.mode = mode;
    if (mode === 'off') this.halt();
    else this.restart();
  }

  async flush(): Promise<void> {
    while (this.inFlight) await this.inFlight;
    this.inFlight = this.deliver().finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  flushOnHide(): void {
    if (this.mode !== 'session') return;
    this.cut(MAX_KEEPALIVE_BYTES);
    const batches = this.pending;
    this.pending = [];
    for (const batch of batches) sendOnHide(this.host.endpoint, 'replays', batch.body);
  }

  async stop(): Promise<void> {
    this.halt();
    if (this.mode === 'session') await this.flush();
  }

  // ── internals ─────────────────────────────────────────────────────────

  private start(): void {
    const options = this.host.options;
    this.stopRecording =
      record({
        emit: (event, isCheckout) => this.onEvent(event as eventWithTime, !!isCheckout),
        checkoutEveryNms: this.mode === 'buffer' ? BUFFER_CHECKOUT_MS : SESSION_CHECKOUT_MS,
        maskAllInputs: options.maskAllInputs !== false,
        maskTextSelector: options.maskAllText ? '*' : options.maskTextSelector,
        blockSelector: options.blockSelector,
        // Fonts and stylesheets are fetched by the player from the page's URLs, not copied.
        inlineStylesheet: true,
        recordCanvas: false,
      }) ?? undefined;
    if (!this.timer) this.timer = setInterval(() => this.mode === 'session' && this.flush(), FLUSH_MS);
  }

  private restart(): void {
    this.stopRecording?.();
    this.start();
  }

  private halt(): void {
    this.stopRecording?.();
    this.stopRecording = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private onEvent(event: eventWithTime, isCheckout: boolean): void {
    if (this.mode === 'buffer') {
      if (isCheckout && event.type === META) {
        this.segments.push([]);
        if (this.segments.length > 2) {
          this.segments.shift();
          // Traces from before the oldest kept event are no longer in the recording.
          const since = this.segments[0][0]?.timestamp ?? event.timestamp;
          for (const [id, time] of this.traces) if (time < since) this.traces.delete(id);
        }
      }
      this.segments[this.segments.length - 1].push(event);
      return;
    }
    this.events.push(event);
    if (this.events.length >= FLUSH_EVENTS) this.flush();
  }

  /** Number what has been recorded into batches. Each number is spent here, once. */
  private cut(limit: number): void {
    if (!this.events.length) return;
    let events = this.events;
    this.events = [];
    const beforeSend = this.host.options.beforeSend;
    if (beforeSend && beforeSend(events as unknown as ReplayEvent[]) === false) return;

    const traceIds = Array.from(this.traces.keys());
    this.traces.clear();
    const meta = {
      sessionId: this.sessionId,
      service: this.host.service,
      url: location.href,
      userAgent: navigator.userAgent,
      hasError: this.hasError,
      traceIds,
    };
    while (events.length) {
      const slice = events.slice(0, MAX_EVENTS_PER_BATCH);
      events = events.slice(MAX_EVENTS_PER_BATCH);
      for (const { items } of split(slice, limit, (group) => group)) {
        const sequence = this.sequence++;
        this.pending.push({ sequence, attempts: 0, body: JSON.stringify({ ...meta, sequence, events: items }) });
      }
    }
    this.host.saveSequence(this.sessionId, this.sequence);
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
  }

  private async deliver(): Promise<void> {
    this.cut(MAX_BODY_BYTES);
    while (this.pending.length) {
      const batch = this.pending[0];
      const status = await post(this.host.endpoint, 'replays', batch.body);
      if (this.pending[0] !== batch) continue; // sent with keepalive meanwhile
      if (retryable(status) && ++batch.attempts < MAX_ATTEMPTS) return; // next flush tries again
      this.pending.shift();
    }
  }
}

export const createRecorder: RecorderModule['createRecorder'] = (host, mode) => new Recorder(host, mode);
