/**
 * What the recorder needs from the rest of the SDK. The recorder is loaded on demand (it
 * carries rrweb), so it receives these rather than importing the client.
 */
import type { Endpoint } from '../transport';
import type { ReplayMode, SessionState } from '../session';
import type { ReplayOptions } from '../types';

export interface ReplayHost {
  endpoint: Endpoint;
  service: string;
  options: ReplayOptions;
  session(): SessionState;
  /** Remember the next batch number for a session, so a reload carries on from it. */
  saveSequence(sessionId: string, next: number): void;
  /** Remember that this session has switched mode (buffer → session after an error). */
  saveMode(sessionId: string, mode: ReplayMode): void;
}

export interface RecorderLike {
  linkTrace(traceId: string): void;
  onError(): void;
  /** A new session began; record it in `mode`, or stop. */
  renew(mode: ReplayMode): void;
  flush(): Promise<void>;
  flushOnHide(): void;
  stop(): Promise<void>;
}

export interface RecorderModule {
  createRecorder(host: ReplayHost, mode: ReplayMode): RecorderLike;
}
