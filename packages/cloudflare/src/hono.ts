/**
 * Hono, through the Worker wrapper: the matched route names the span (`GET /users/:id`), and
 * errors Hono catches itself — it turns them into a 500 before the wrapper could see them — are
 * reported from its error handler. HTTPExceptions under 500 are answers, not errors.
 */
import { safely } from '../../browser/src/util';
import type { Runtime } from './state';
import { activeSpan } from './tracing';

/** Whether `app` is a Hono app (or one built the same way). */
export function isHono(app: any): boolean {
  return !!app && typeof app === 'object' && typeof app.fetch === 'function' && typeof app.router?.match === 'function' && Array.isArray(app.routes);
}

/** The route Hono matched for a request: the last handler's path that isn't a `use` middleware. */
export function honoRoute(app: any, request: Request): string | undefined {
  return safely(() => {
    const path = typeof app.getPath === 'function' ? app.getPath(request) : new URL(request.url).pathname;
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const [matched] = app.router.match(method, path) ?? [];
    if (!Array.isArray(matched) || !matched.length) return undefined;
    const routes = matched.map((entry: any) => entry?.[0]?.[1]).filter((route: any) => route && typeof route.path === 'string');
    const handler = [...routes].reverse().find((route: any) => route.method !== 'ALL') ?? routes[routes.length - 1];
    const route = handler?.path;
    return route && route !== '/*' && route !== '*' ? route : undefined;
  });
}

const WRAPPED = Symbol.for('zharp.cloudflare.honoErrorHandler');

/** Report what reaches the app's error handler (its own or Hono's default), then let it answer. */
export function hookHonoErrors(app: any, runtime: Runtime): void {
  safely(() => {
    const current = app.errorHandler;
    if (typeof current !== 'function' || current[WRAPPED]) return;
    const wrapped = function (this: unknown, error: unknown, c: unknown) {
      const status = (error as any)?.status;
      const answer = typeof (error as any)?.getResponse === 'function' && typeof status === 'number' && status < 500;
      if (!answer) runtime.report(error, false, { 'zharp.mechanism': 'hono' }, activeSpan());
      return current.call(this, error, c);
    };
    (wrapped as any)[WRAPPED] = true;
    app.errorHandler = wrapped;
  });
}
