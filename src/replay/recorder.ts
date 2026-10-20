import { record } from 'rrweb';
import type { eventWithTime } from '@rrweb/types';
import { getSessionId } from '../session';
import { MAX_BEACON_BYTES, MAX_FETCH_BYTES, normalizeEndpoint, postJson, sendOnUnload, splitBySize } from '../delivery';

/** Attempts a batch gets — across flushes — before it is given up on. */
const MAX_ATTEMPTS = 3;

/**
 * Batches cut but not yet delivered. While the network is down they pile up, one per flush; past
 * this the oldest go, because the recording has to stay bounded in memory.
 */
const MAX_PENDING = 30;

/**
 * A batch, fixed at the moment it is cut.
 *
 * The body — sequence number included — never changes afterwards, so a retry is the same
 * request again. The backend stores one chunk per (session, sequence) and treats a repeat as a
 * duplicate, so a retry that reused a sequence for different events lost those events.
 */
interface ReplayBatch {
    sequence: number;
    body: string;
    attempts: number;
}

export interface ReplayOptions {
    /** Your Zharp API key. Defaults to the one `ZharpLogger.init()` was given. */
    apiKey?: string;
    /** Service name the recording is filed under. Defaults to the logger's. */
    service?: string;
    /** Base URL of the Zharp API. Defaults to the logger's `endpoint`, then 'https://api.zharp.io/api/v1'. */
    endpoint?: string;

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
    /** Batches cut and numbered, oldest first, waiting to be delivered. */
    private pending: ReplayBatch[] = [];
    /** The next sequence number. Only ever goes up: a number is spent when a batch is cut. */
    private sequence = 0;
    /** The flush currently running. There is never more than one. */
    private inFlight: Promise<void> | null = null;
    private flushTimer: ReturnType<typeof setInterval> | null = null;
    private options: Required<Pick<ReplayOptions, 'sampleRate' | 'flushInterval' | 'maskAllInputs'>> & ReplayOptions = {
        sampleRate: 1,
        flushInterval: 10_000,
        maskAllInputs: true,
    };

    private endpoint = '';
    private apiKey = '';
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
        this.apiKey = apiKey;
        this.endpoint = normalizeEndpoint(options.endpoint ?? readLoggerConfig('endpoint'));

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

    /**
     * Ship what has been recorded so far.
     *
     * One flush at a time. A flush called while another is running — the timer firing during a
     * slow upload, the 500-event threshold tripping mid-retry — waits for it and then runs, so
     * two flushes never send the same batch at once or deliver batches out of order.
     */
    async flush(): Promise<void> {
        while (this.inFlight) await this.inFlight;

        this.inFlight = this.deliver();
        try {
            await this.inFlight;
        } finally {
            this.inFlight = null;
        }
    }

    // ── internals ─────────────────────────────────────────────────────────

    /** Send pending batches in order, stopping at the first that has to wait for a retry. */
    private async deliver(): Promise<void> {
        this.cut(MAX_FETCH_BYTES);
        if (!this.endpoint) return;

        while (this.pending.length) {
            const batch = this.pending[0];
            const outcome = await this.post(batch);

            // An unload may have beaconed and cleared the queue while this request was out.
            if (this.pending[0] !== batch) continue;

            if (outcome === 'retry') {
                batch.attempts += 1;
                // Still worth another try: leave it at the head, unchanged, for the next flush.
                // Retrying now would mostly fail for the same reason a moment later.
                if (batch.attempts < MAX_ATTEMPTS) return;
            }
            // Delivered, rejected, or out of attempts. A dropped batch takes its sequence number
            // with it — the next batch keeps its own, so nothing is ever filed under a number
            // that was already used for different events.
            this.pending.shift();
        }
    }

    private async post(batch: ReplayBatch): Promise<'done' | 'retry'> {
        try {
            const response = await postJson(this.endpoint, 'replay', this.apiKey, batch.body);
            // Only a server-side failure is retried: a rejected batch will be rejected again, and
            // retrying it forever would block everything recorded after it.
            return !response.ok && response.status >= 500 ? 'retry' : 'done';
        } catch {
            return 'retry';
        }
    }

    /**
     * Turn the buffer into numbered batches of at most `limit` bytes.
     *
     * The sequence is assigned here, once. `beforeSend` sees the events before any number is
     * spent, so a batch it drops leaves no gap.
     */
    private cut(limit: number): void {
        if (!this.buffer.length) return;

        const events = this.buffer;
        this.buffer = [];

        if (this.options.beforeSend && this.options.beforeSend(events) === false) return;

        const first = this.sequence;
        const chunks = splitBySize(events, limit, (group, index) => this.envelope(group, first + index));
        this.sequence += chunks.length;

        chunks.forEach(({ body }, index) => this.pending.push({ sequence: first + index, body, attempts: 0 }));

        if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
    }

    private envelope(events: eventWithTime[], sequence: number): Record<string, unknown> {
        return {
            sessionId: getSessionId(),
            service: this.service,
            sequence,
            url: window.location.href,
            userAgent: navigator.userAgent,
            hasError: this.sawError,
            traceIds: Array.from(this.traceIds),
            events,
        };
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
        if (!this.endpoint) return;
        if (typeof navigator === 'undefined' || !navigator.sendBeacon) {
            this.flush().catch(() => {});
            return;
        }

        // New events are cut to beacon size. Batches already numbered go as they are — larger
        // than a beacon allows, they fall back to an ordinary request rather than being renumbered.
        // One that is also in flight right now may arrive twice; the backend keeps the first.
        this.cut(MAX_BEACON_BYTES);
        if (!this.pending.length) return;

        const bodies = this.pending.map((batch) => batch.body);
        this.pending = [];
        sendOnUnload(this.endpoint, 'replay', this.apiKey, bodies);
    }
}

/**
 * Read a value the logger was initialised with.
 *
 * Reaching through a global rather than importing the logger keeps this entry point from
 * pulling the whole logging SDK into a bundle that only wanted the recorder.
 */
function readLoggerConfig(key: 'apiKey' | 'service' | 'endpoint'): string | undefined {
    const shared = (globalThis as any).__ZHARP__;
    return shared?.[key];
}
