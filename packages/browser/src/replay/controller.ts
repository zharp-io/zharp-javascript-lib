/**
 * The part of replay that is always in the bundle: deciding whether this session records, and
 * loading the recorder when it does. Everything heavy is in recorder.ts.
 */
import type { ReplayMode, Session } from '../session';
import type { ReplayOptions } from '../types';
import type { Endpoint } from '../transport';
import type { RecorderLike, RecorderModule, ReplayHost } from './host';


/** Where the script-tag build was loaded from, so the recorder can be found next to it. */
let scriptSrc: string | undefined;
export function rememberScriptSrc(src: string | undefined): void {
  scriptSrc = src;
}

function loadRecorder(options: ReplayOptions): Promise<RecorderModule> {
  if (__ZHARP_CDN__) {
    const g = globalThis as any;
    if (g.__ZHARP_REPLAY__) return Promise.resolve(g.__ZHARP_REPLAY__);
    const src = options.recorderUrl || (scriptSrc ? scriptSrc.replace(/zharp(\.min)?\.js(\?.*)?$/, 'zharp-replay.min.js') : '');
    if (!src) return Promise.reject(new Error('No recorder URL'));
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.onload = () => (g.__ZHARP_REPLAY__ ? resolve(g.__ZHARP_REPLAY__) : reject(new Error('Recorder did not register')));
      script.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(script);
    });
  }
  return import('./recorder');
}

export class ReplayController {
  private recorder: RecorderLike | null = null;
  private loading = false;
  /** Traces and errors that happened while the recorder was downloading. */
  private early: { traces: string[]; error: boolean } = { traces: [], error: false };

  constructor(
    private readonly session: Session,
    private readonly options: ReplayOptions,
    private readonly endpoint: Endpoint,
    private readonly service: string,
  ) {
    session.onRenew(() => {
      const mode = this.decide();
      if (this.recorder) this.recorder.renew(mode);
      else if (mode !== 'off') this.load(mode);
    });
  }

  start(): void {
    const mode = this.decide();
    if (mode !== 'off') this.load(mode);
  }

  linkTrace(traceId: string): void {
    if (this.recorder) this.recorder.linkTrace(traceId);
    else if (this.loading && this.early.traces.length < 50) this.early.traces.push(traceId);
  }

  onError(): void {
    if (this.recorder) this.recorder.onError();
    else if (this.loading) this.early.error = true;
  }

  flush(): Promise<void> {
    return this.recorder ? this.recorder.flush() : Promise.resolve();
  }

  flushOnHide(): void {
    this.recorder?.flushOnHide();
  }

  stop(): Promise<void> {
    const recorder = this.recorder;
    this.recorder = null;
    return recorder ? recorder.stop() : Promise.resolve();
  }

  /** This session's mode, decided once and kept with the session. */
  private decide(): ReplayMode {
    const state = this.session.current;
    if (state.replay) return state.replay;
    const rate = (value: number | undefined) => (typeof value === 'number' ? Math.min(1, Math.max(0, value)) : 0);
    const mode: ReplayMode =
      Math.random() < rate(this.options.sampleRate) ? 'session' : Math.random() < rate(this.options.onErrorSampleRate) ? 'buffer' : 'off';
    this.session.update({ replay: mode });
    return mode;
  }

  private load(mode: ReplayMode): void {
    if (this.loading) return;
    this.loading = true;
    const host: ReplayHost = {
      endpoint: this.endpoint,
      service: this.service,
      options: this.options,
      session: () => this.session.current,
      saveSequence: (id, next) => {
        if (this.session.current.id === id) this.session.update({ seq: next });
      },
      saveMode: (id, replay) => {
        if (this.session.current.id === id) this.session.update({ replay });
      },
    };
    loadRecorder(this.options)
      .then((module) => {
        this.recorder = module.createRecorder(host, mode);
        for (const id of this.early.traces) this.recorder.linkTrace(id);
        if (this.early.error) this.recorder.onError();
      })
      .catch(() => {
        // No recorder (blocked by a content policy, offline): the rest of the SDK carries on.
      })
      .finally(() => {
        this.loading = false;
        this.early = { traces: [], error: false };
      });
  }
}
