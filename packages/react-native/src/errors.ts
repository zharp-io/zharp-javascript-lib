/**
 * Uncaught JavaScript errors and unhandled promise rejections in React Native.
 *
 * - Errors: `ErrorUtils.setGlobalHandler`, chained — the handler that was there before (React
 *   Native's red box in development, its crash in release, another reporter) still runs after.
 * - Rejections: Hermes' own tracker (`HermesInternal.enablePromiseRejectionTracker`). React
 *   Native installs one in development to warn about them; ours replaces it and keeps the warning.
 */
import { safely } from '../../browser/src/util';

type Report = (error: unknown, mechanism: string, fatal: boolean) => void;

interface ErrorUtilsShape {
  getGlobalHandler(): ((error: unknown, isFatal?: boolean) => void) | undefined;
  setGlobalHandler(handler: (error: unknown, isFatal?: boolean) => void): void;
}

export function watchGlobalErrors(report: Report): () => void {
  const g = globalThis as any;
  const undo: Array<() => void> = [];

  const errorUtils: ErrorUtilsShape | undefined = g.ErrorUtils;
  if (errorUtils && typeof errorUtils.setGlobalHandler === 'function') {
    const previous = errorUtils.getGlobalHandler?.();
    const handler = (error: unknown, isFatal?: boolean) => {
      safely(() => report(error, 'onerror', !!isFatal));
      previous?.(error, isFatal);
    };
    errorUtils.setGlobalHandler(handler);
    undo.push(() => {
      if (errorUtils.getGlobalHandler?.() === handler && previous) errorUtils.setGlobalHandler(previous);
    });
  }

  const hermes = g.HermesInternal;
  if (hermes && typeof hermes.enablePromiseRejectionTracker === 'function') {
    safely(() =>
      hermes.enablePromiseRejectionTracker({
        allRejections: true,
        onUnhandled: (_id: number, rejection: unknown) => {
          safely(() => report(rejection, 'onunhandledrejection', false));
          if (g.__DEV__) console.warn('Possible unhandled promise rejection:', rejection);
        },
        onHandled: () => {},
      }),
    );
  }

  return () => undo.forEach((u) => u());
}
