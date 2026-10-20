/**
 * Session replay — a separate entry point on purpose.
 *
 * The recorder brings rrweb with it, which is an order of magnitude larger than the rest of
 * this SDK. Keeping it behind its own import means an application that only wants logging or
 * tracing never pays for a recorder it does not use.
 *
 *     import { ZharpReplay } from '@zharp/logs/replay';
 *     ZharpReplay.start({ sampleRate: 0.1 });
 */
export { ReplayRecorder } from './replay/recorder';
export type { ReplayOptions } from './replay/recorder';

import { ReplayRecorder } from './replay/recorder';

/** Singleton, matching how `ZharpLogger` is used. */
export const ZharpReplay = new ReplayRecorder();
export default ZharpReplay;
