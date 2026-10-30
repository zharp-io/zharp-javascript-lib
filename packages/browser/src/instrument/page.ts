/**
 * The page's own events: navigations in a single-page app, clicks, and the signs of a person
 * still being there that keep their session alive.
 */
import { safely } from '../util';

/** The route as the app sees it: the path, plus a hash route (`#/orders`) when there is one. */
export function currentRoute(): string {
  const hash = location.hash.startsWith('#/') ? location.hash : '';
  return location.pathname + hash;
}

/**
 * Call `onNavigate(route)` when the route changes through `history.pushState`,
 * `history.replaceState`, back/forward, or a hash change. A replaceState that only swaps
 * query parameters is not a navigation.
 */
export function watchNavigation(onNavigate: (route: string) => void): () => void {
  let last = currentRoute();
  const check = () =>
    safely(() => {
      const route = currentRoute();
      if (route === last) return;
      last = route;
      onNavigate(route);
    });

  const history = window.history as any;
  const originals: Record<string, any> = {};
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    if (typeof original !== 'function' || original.__zharp) continue;
    originals[method] = original;
    const patched = function (this: unknown, ...args: unknown[]) {
      const result = original.apply(this, args);
      check();
      return result;
    };
    (patched as any).__zharp = true;
    history[method] = patched;
  }
  window.addEventListener('popstate', check);
  window.addEventListener('hashchange', check);
  return () => {
    Object.assign(history, originals);
    window.removeEventListener('popstate', check);
    window.removeEventListener('hashchange', check);
  };
}

const CLICKABLE =
  'button,a,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=checkbox],[role=switch],input[type=button],input[type=submit],input[type=checkbox],input[type=radio],summary,label,select,[data-zharp-name]';

/** What a person would call the thing they clicked: its name for screen readers, near enough. */
export function describeTarget(target: EventTarget | null): { label: string; selector: string } | null {
  const start = target instanceof Element ? target : null;
  if (!start) return null;
  const element = start.closest(CLICKABLE) ?? start;
  const attr = (name: string) => element.getAttribute(name)?.trim();
  const tag = element.tagName.toLowerCase();
  let label =
    attr('data-zharp-name') ||
    attr('aria-label') ||
    (tag === 'input' ? (element as HTMLInputElement).value || attr('name') : '') ||
    (element.textContent || '').replace(/\s+/g, ' ').trim() ||
    attr('title') ||
    attr('alt') ||
    tag;
  if (label.length > 40) label = `${label.slice(0, 39)}…`;
  const id = element.id ? `#${element.id}` : '';
  const classes = typeof element.className === 'string' && element.className.trim()
    ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}`
    : '';
  return { label, selector: `${tag}${id}${classes}` };
}

export function watchClicks(onClick: (label: string, selector: string) => void): () => void {
  const listener = (event: Event) =>
    safely(() => {
      const described = describeTarget(event.target);
      if (described) onClick(described.label, described.selector);
    });
  // Capture phase: a handler that stops propagation must not hide the click from the SDK.
  document.addEventListener('click', listener, true);
  return () => document.removeEventListener('click', listener, true);
}

/** Things a person does. Each keeps the session alive; none is recorded. */
export function watchActivity(onActivity: () => void): () => void {
  const events = ['click', 'keydown', 'scroll', 'touchstart', 'pointerdown'];
  let last = 0;
  const listener = () => {
    const time = Date.now();
    if (time - last < 1_000) return;
    last = time;
    safely(onActivity);
  };
  for (const name of events) document.addEventListener(name, listener, { capture: true, passive: true });
  return () => {
    for (const name of events) document.removeEventListener(name, listener, { capture: true });
  };
}

/** The page is being hidden or closed — the last chance to send anything. */
export function watchHide(onHide: () => void): () => void {
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') safely(onHide);
  };
  const onPageHide = () => safely(onHide);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
  };
}

/** Load timings of the current document, for the page load span. */
export function navigationTimings(): Record<string, number> {
  const entry = safely(() => performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined);
  if (!entry) return {};
  const out: Record<string, number> = {};
  const put = (key: string, value: number) => {
    if (value > 0) out[key] = Math.round(value);
  };
  put('browser.timing.ttfb_ms', entry.responseStart);
  put('browser.timing.dom_content_loaded_ms', entry.domContentLoadedEventEnd);
  put('browser.timing.load_ms', entry.loadEventEnd);
  return out;
}
