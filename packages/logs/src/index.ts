export { ZharpLoggerClass } from './logger';
export { getSessionId, resetSessionId } from '@zharp/internal/session';
export type { ZharpConfig, LogEntry, LogLevel, AutoCaptureOptions, ConsoleMethod } from './types';
export { VERSION } from './version';

import { ZharpLoggerClass } from './logger';
import { shared } from '@zharp/internal/shared';

// Singleton — import ZharpLogger anywhere in your app and call it directly.
// Call ZharpLogger.init() once at startup before any other calls; importing starts nothing.
//
// Kept on the shared handle so the CommonJS and ES builds hand out the same instance: an
// application started with `node --import @zharp/logs/init` that later `require`s the package
// gets the logger that was started, not a second one that never was.
const handle = shared();
export const ZharpLogger: ZharpLoggerClass =
  (handle.logger as ZharpLoggerClass | undefined) ?? (handle.logger = new ZharpLoggerClass());
export default ZharpLogger;
