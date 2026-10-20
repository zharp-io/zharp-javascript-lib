/**
 * A short trail of what happened before a failure.
 *
 * The question asked of every error is "what were they doing?", and a stack trace answers a
 * different one — it says where the code was, not how it got there. Breadcrumbs are the cheap
 * two-thirds of session replay: the sequence of clicks, navigations, requests and logs leading
 * up to the moment, without recording the page itself.
 *
 * The buffer is deliberately small and circular. Only the recent past explains a failure, and
 * an unbounded trail on a long-lived page is a memory leak that ships itself to a server.
 */

export type BreadcrumbKind = 'navigation' | 'click' | 'input' | 'request' | 'log' | 'custom';

export interface Breadcrumb {
    kind: BreadcrumbKind;
    /** What happened, already readable — this is shown verbatim. */
    message: string;
    time: string;
    /** Severity, where one applies. */
    level?: 'info' | 'warn' | 'error';
    data?: Record<string, unknown>;
}

/** How many to keep. Twenty covers the last minute or so of an active session. */
const MAX_BREADCRUMBS = 20;

const trail: Breadcrumb[] = [];

/**
 * Record something worth remembering.
 *
 * @param crumb - The event; `time` is stamped here so callers cannot disagree about ordering
 */
export function addBreadcrumb(crumb: Omit<Breadcrumb, 'time'>): void {
    trail.push({ ...crumb, time: new Date().toISOString() });
    if (trail.length > MAX_BREADCRUMBS) trail.shift();
}

/** The trail as it stands, oldest first. */
export function breadcrumbs(): Breadcrumb[] {
    return trail.slice();
}

/** Forget everything — used on teardown, and when a new session starts. */
export function clearBreadcrumbs(): void {
    trail.length = 0;
}

/**
 * A short, readable description of an element.
 *
 * `id` first, then a class, then the tag: enough to recognise which button was pressed without
 * being a selector anyone would try to run. Text content is deliberately excluded — a button's
 * label often contains a name, an amount, or an address.
 */
export function describeElement(element: any): string {
    if (!element || !element.tagName) return 'unknown';

    const tag = String(element.tagName).toLowerCase();
    if (element.id) return `${tag}#${element.id}`;

    const className = typeof element.className === 'string' ? element.className.trim() : '';
    if (className) return `${tag}.${className.split(/\s+/)[0]}`;

    // A form control is best identified by what it is for.
    if (element.name) return `${tag}[name=${element.name}]`;
    return tag;
}

/**
 * Watch the browser for the things worth remembering.
 *
 * Nothing typed is captured — only that typing happened, and into which field. Recording input
 * values would mean shipping passwords, card numbers and messages to a monitoring service, and
 * no amount of masking makes that a safe default.
 *
 * @param enabled - Whether to attach at all
 * @returns A teardown that removes every listener
 */
export function watchBrowserActivity(enabled: boolean): () => void {
    if (!enabled || typeof window === 'undefined' || typeof document === 'undefined') {
        return () => {};
    }

    const onClick = (event: any) => {
        addBreadcrumb({
            kind: 'click',
            message: `Clicked ${describeElement(event.target)}`,
        });
    };

    const onInput = (event: any) => {
        const target = event.target;
        const type = String(target?.type ?? '').toLowerCase();
        // A password field is not even named: the field's own id can identify an account.
        const where = type === 'password' ? 'a password field' : describeElement(target);
        addBreadcrumb({ kind: 'input', message: `Typed into ${where}` });
    };

    let lastUrl = window.location.href;
    const onNavigate = () => {
        const url = window.location.href;
        if (url === lastUrl) return;
        addBreadcrumb({ kind: 'navigation', message: `Navigated to ${window.location.pathname}` });
        lastUrl = url;
    };

    // Capture phase: a handler that stops propagation would otherwise hide the click from us,
    // and a click that the application swallowed is exactly the one worth knowing about.
    document.addEventListener('click', onClick, true);
    // `change` rather than every keystroke — one crumb per field, not per character.
    document.addEventListener('change', onInput, true);
    window.addEventListener('popstate', onNavigate);
    window.addEventListener('hashchange', onNavigate);

    // A single-page app changes the URL without an event, so the history methods are wrapped.
    const history = window.history as any;
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;

    if (!history.__zharpPatched) {
        history.pushState = function (...args: any[]) {
            const result = originalPush.apply(this, args);
            onNavigate();
            return result;
        };
        history.replaceState = function (...args: any[]) {
            const result = originalReplace.apply(this, args);
            onNavigate();
            return result;
        };
        history.__zharpPatched = true;
    }

    return () => {
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('change', onInput, true);
        window.removeEventListener('popstate', onNavigate);
        window.removeEventListener('hashchange', onNavigate);
        if (history.__zharpPatched) {
            history.pushState = originalPush;
            history.replaceState = originalReplace;
            delete history.__zharpPatched;
        }
    };
}
