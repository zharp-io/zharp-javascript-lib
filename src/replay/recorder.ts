import { record } from 'rrweb';
import type { eventWithTime } from '@rrweb/types';
import { getSessionId } from '../session';

const SDK_VERSION = '1.3.0';

export interface ReplayOptions {
    /** Your Zharp API key. Defaults to the one `ZharpLogger.init()` was given. */
    apiKey?: string;
    /** Service name the recording is filed under. Defaults to the logger's. */
    service?: string;

    /**
     * Fraction of sessions to record, 0 to 1. Default: 1.
     *
     * Decided once when recording starts and never revisited: a session recorded for half its
     * length is a video that cuts out mid-sentence.
     */
    sampleRate?: number;

    /** How often to ship what has been recorded, in milliseconds. Default: 10000. */
    flushInterval?: number;

    /**
     * Mask the contents of every input, textarea and select. Default: **true**.
     *
     * Turning this off ships whatever people type — passwords, card numbers, private messages —
     * to a monitoring service. It is deliberately awkward to disable, and if you do, it should
     * be alongside `block` selectors covering everything sensitive on the page.
     */
    maskAllInputs?: boolean;

    /** Also mask all text, not just inputs. Off by default; a recording of blanks is not useful. */
    maskAllText?: boolean;

    /**
     * CSS selector for elements to leave out of the recording entirely. Their space is kept but
     * their contents are never captured — the right tool for a payment iframe or a document
     * preview.
     */
    blockSelector?: string;

    /** CSS selector for elements whose text should be masked. */
    maskTextSelector?: string;

    /** Called with each recorded batch before it is sent. Return false to drop it. */
    beforeSend?: (events: eventWithTime[]) => boolean;
}

/**
 * Records the page and ships it to Zharp.
 *
 * The recording itself is rrweb's — it handles the parts that make DOM recording hard, and
 * there are many: shadow DOM, canvas, iframes, cross-origin stylesheets, web components,
 * media elements. What lives here is everything around it: sampling, batching, retry, privacy
 * defaults, and the link between a recording and the traces and logs from the same session.
 */
export class ReplayRecorder {
    private stopRecording: (() => void) | null = null;
    private buffer: eventWithTime[] = [];
    private sequence = 0;
    private flushTimer: ReturnType<typeof setInterval> | null = null;
    private options: Required<Pick<ReplayOptions, 'sampleRate' | 'flushInterval' | 'maskAllInputs'>> & ReplayOptions = {
        sampleRate: 1,
        flushInterval: 10_000,
        maskAllInputs: true,
    };

    private endpoint = '';
    private service = 'unknown';
    /** Sticky: once a session has seen an error it stays flagged, so it can be found later. */
    private sawError = false;
    private traceIds = new Set<string>();
    private recording = false;

    /** Whether this session is being recorded. */
    get isRecording(): boolean {
        return this.recording;
    }

    /**
     * Start recording the current page.
     *
     * Safe to call more than once — a second call while already recording is ignored rather
     * than starting a second recorder, which would double every frame.
     *
     * @param options - Sampling, privacy and batching
     */
    start(options: ReplayOptions = {}): void {
        if (this.recording) return;
        if (typeof window === 'undefined' || typeof document === 'undefined') return;

        this.options = { ...this.options, ...options };

        const apiKey = options.apiKey ?? readLoggerConfig('apiKey');
        if (!apiKey) {
            console.warn('[Zharp] Replay needs an apiKey — pass one, or call ZharpLogger.init() first.');
            return;
        }

        // Sampled out. Nothing is recorded at all, rather than recorded and discarded: the
        // cost of rrweb is in the recording, not in the sending.
        if (this.options.sampleRate < 1 && Math.random() >= this.options.sampleRate) return;

        this.service = options.service ?? readLoggerConfig('service') ?? 'unknown';
        this.endpoint = `https://api.zharp.io/api/v1/agent/replay/${apiKey}`;

        this.stopRecording = record({
            emit: (event) => {
                this.buffer.push(event);
                // A full snapshot means rrweb has restarted its checkout — a good moment to
                // ship, because everything before it is now a complete, playable segment.
                if (this.buffer.length >= 500) this.flush();
            },
            maskAllInputs: this.options.maskAllInputs,
            blockSelector: this.options.blockSelector,
            // `maskAllText` is the blunt version of `maskTextSelector`, so it takes precedence
            // when both are given: someone who asked for everything to be masked has not
            // narrowed their mind by also naming a selector.
            maskTextSelector: this.options.maskAllText ? '*' : this.options.maskTextSelector,
            // A periodic full snapshot bounds how much of the recording is lost when a chunk
            // fails to arrive: the player resynchronises at the next one rather than staying
            // broken to the end.
            checkoutEveryNms: 60_000,
        }) ?? null;

        this.flushTimer = setInterval(() => this.flush(), this.options.flushInterval);

        window.addEventListener('visibilitychange', this.handleVisibilityChange);
        window.addEventListener('beforeunload', this.handleUnload);

        // Register on the shared handle so the logger can flag this recording when it sees
        // an error, and the tracer can associate the traces it starts.
        const shared = ((globalThis as any).__ZHARP__ = (globalThis as any).__ZHARP__ ?? {});
        shared.markError = () => this.markError();
        shared.linkTrace = (traceId: string) => this.linkTrace(traceId);

        this.recording = true;
    }

    /** Stop recording and send whatever is left. */
    async stop(): Promise<void> {
        if (!this.recording) return;

        if (this.stopRecording) {
            this.stopRecording();
            this.stopRecording = null;
        }
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        if (typeof window !== 'undefined') {
            window.removeEventListener('visibilitychange', this.handleVisibilityChange);
            window.removeEventListener('beforeunload', this.handleUnload);
        }

        const shared = (globalThis as any).__ZHARP__;
        if (shared) {
            delete shared.markError;
            delete shared.linkTrace;
        }

        this.recording = false;
        await this.flush();
    }

    /**
     * Mark this session as one where something went wrong.
     *
     * Called for you when the SDK records an exception. Worth calling by hand for a failure the
     * SDK cannot see — a validation error the user hit, a state the application knows is wrong.
     */
    markError(): void {
        this.sawError = true;
    }

    /** Associate a trace with this recording, so each can be opened from the other. */
    linkTrace(traceId: string): void {
        // Bounded: a long session produces thousands of traces, and the list only needs enough
        // to get from a recording to the requests it made.
        if (this.traceIds.size < 50) this.traceIds.add(traceId);
    }

    /** Ship what has been recorded so far. */
    async flush(): Promise<void> {
        if (!this.buffer.length || !this.endpoint) return;

        const events = this.buffer;
        this.buffer = [];

        if (this.options.beforeSend && this.options.beforeSend(events) === false) return;

        const body = this.envelope(events);

        try {
            const response = await fetch(this.endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Zharp-SDK': `js/${SDK_VERSION}` },
                body,
                // Marks this as the SDK's own call so the fetch instrumentation does not trace
                // it — a traced upload would produce spans describing the upload of spans.
                ...({ __zharp: true } as any),
            });
            if (!response.ok && response.status >= 500) {
                // Put them back for the next flush. Only for a server-side failure: a rejected
                // batch will be rejected again, and retrying it forever would block everything
                // recorded after it.
                this.buffer = events.concat(this.buffer);
                this.sequence -= 1;
            }
        } catch {
            this.buffer = events.concat(this.buffer);
            this.sequence -= 1;
        }
    }

    // ── internals ─────────────────────────────────────────────────────────

    private envelope(events: eventWithTime[]): string {
        return JSON.stringify({
            sessionId: getSessionId(),
            service: this.service,
            sequence: this.sequence++,
            url: window.location.href,
            userAgent: navigator.userAgent,
            hasError: this.sawError,
            traceIds: Array.from(this.traceIds),
            events,
        });
    }

    private handleVisibilityChange = (): void => {
        if (document.visibilityState === 'hidden') this.sendBeacon();
    };

    private handleUnload = (): void => {
        this.sendBeacon();
    };

    /**
     * The last flush of a page, which a normal request would not survive.
     *
     * This is the batch that matters most: it holds whatever happened immediately before the
     * user left, which is often the thing that made them leave.
     */
    private sendBeacon(): void {
        if (!this.buffer.length || !this.endpoint) return;
        if (typeof navigator === 'undefined' || !navigator.sendBeacon) {
            this.flush().catch(() => {});
            return;
        }

        const events = this.buffer;
        this.buffer = [];
        const body = this.envelope(events);
        navigator.sendBeacon(this.endpoint, new Blob([body], { type: 'application/json' }));
    }
}

/**
 * Read a value the logger was initialised with.
 *
 * Reaching through a global rather than importing the logger keeps this entry point from
 * pulling the whole logging SDK into a bundle that only wanted the recorder.
 */
function readLoggerConfig(key: 'apiKey' | 'service'): string | undefined {
    const shared = (globalThis as any).__ZHARP__;
    return shared?.[key];
}
