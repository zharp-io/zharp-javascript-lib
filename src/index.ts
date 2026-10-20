export { ZharpLoggerClass } from './logger';
export { getSessionId, resetSessionId } from './session';
export type { ZharpConfig, LogEntry, LogLevel, AutoCaptureOptions } from './types';

export { Span } from './trace/span';
export { toTraceparent, fromTraceparent } from './trace/context';
export type { Breadcrumb, BreadcrumbKind } from './trace/breadcrumbs';
export type { CodeContext } from './trace/code-context';
export type {
  TracingOptions,
  SpanContext,
  SpanKind,
  SpanStatus,
  SpanOptions,
  SpanRecord,
  Attributes,
  AttributeValue,
} from './trace/types';

import { ZharpLoggerClass } from './logger';

// Singleton — import ZharpLogger anywhere in your app and call it directly.
// Call ZharpLogger.init() once at startup before any other calls.
export const ZharpLogger = new ZharpLoggerClass();
export default ZharpLogger;
