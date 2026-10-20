export { ZharpAPMClass } from './apm';
export { Span } from './trace/span';
export { toTraceparent, fromTraceparent } from './trace/context';
export { getSessionId, resetSessionId } from '@zharp/internal/session';
export { VERSION } from './version';
export type { ZharpAPMConfig, ReplayOptions, ReplayEvent } from './types';
export type { Breadcrumb, BreadcrumbKind } from './trace/breadcrumbs';
export type { CodeContext } from './trace/code-context';
export type {
  SpanContext,
  SpanKind,
  SpanStatus,
  SpanOptions,
  SpanRecord,
  Attributes,
  AttributeValue,
} from './trace/types';

import { ZharpAPMClass } from './apm';
import { shared } from '@zharp/internal/shared';

// Singleton — call ZharpAPM.init() once at startup; importing starts nothing.
//
// Kept on the shared handle so the CommonJS and ES builds hand out the same instance: an
// application started with `node --import @zharp/apm/init` that later `require`s the package
// gets the tracer that patched `http`, not a second one that never started.
const handle = shared();
export const ZharpAPM: ZharpAPMClass =
  (handle.apmInstance as ZharpAPMClass | undefined) ?? (handle.apmInstance = new ZharpAPMClass());
export default ZharpAPM;
