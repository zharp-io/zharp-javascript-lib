/**
 * The source lines around the place an exception was thrown.
 *
 * A stack trace names a file and a line; it does not say what is on that line. Reading the code
 * is the first thing anyone does with a stack, and doing it means leaving the incident, finding
 * the right revision, and opening the file. Attaching the lines to the error removes that step
 * entirely — which matters most at 3am, when the reader is not near the repository.
 *
 * Node only. In a browser the stack points at bundled, minified output whose lines mean nothing
 * without a source map, and resolving those belongs on the server where the maps live.
 */

/** One frame of a stack, with the code around it. */
export interface CodeContext {
    /** Absolute path as the stack reported it. */
    file: string;
    /** 1-based line the frame points at. */
    line: number;
    column?: number;
    /** The enclosing function, when the stack named one. */
    function?: string;
    /** Lines before the failing one, in order. */
    pre: string[];
    /** The failing line itself. */
    source: string;
    /** Lines after it, in order. */
    post: string[];
}

/** How many lines either side to take. Enough to see the statement in its block. */
const CONTEXT_LINES = 5;

/** Frames past this are almost always framework internals nobody reads. */
const MAX_FRAMES = 5;

/** Files are read once per process: source does not change under a running application. */
const fileCache = new Map<string, string[] | null>();

/**
 * `at fn (/path/file.js:12:34)` and `at /path/file.js:12:34` — V8 writes both, depending on
 * whether the frame is inside a named function.
 */
const FRAME = /^\s*at\s+(?:([^\s(]+)\s+\()?([^\s():]+(?::[^\s():]+)?):(\d+):(\d+)\)?\s*$/;

/** Which numbered group is which. Named groups would need ES2018; the bundle targets ES2017. */
const FN = 1;
const FILE = 2;
const LINE = 3;
const COLUMN = 4;

/**
 * Frames worth reading.
 *
 * `node_modules` and Node's own internals are excluded not to save work but because they are
 * noise: an error thrown three libraries deep is almost never a bug in the third library, and
 * the frame the reader wants is the last one in their own code.
 */
function isApplicationFrame(file: string): boolean {
    if (!file) return false;
    if (file.indexOf('node_modules') !== -1) return false;
    if (file.indexOf('node:') === 0) return false;
    if (file.indexOf('internal/') === 0) return false;
    return true;
}

/** Read a file's lines, or null if it cannot be read. */
function readLines(file: string): string[] | null {
    if (fileCache.has(file)) return fileCache.get(file) ?? null;

    let lines: string[] | null = null;
    try {
        // Indirect so a browser bundler does not try to resolve `fs`.
        const req = typeof require === 'function' ? require : null;
        if (req) {
            const contents: string = req('fs').readFileSync(file, 'utf8');
            lines = contents.split(/\r?\n/);
        }
    } catch {
        // Unreadable — a deleted file, a permission, a virtual path from a bundler. Cached as
        // null so the same failure is not retried on every subsequent error.
        lines = null;
    }

    fileCache.set(file, lines);
    return lines;
}

/**
 * Pull the source around each application frame of a stack.
 *
 * @param stack - The `error.stack` string
 * @returns One entry per readable frame, outermost first; empty in a browser or when nothing
 *          could be read
 */
export function codeContextFromStack(stack: string | undefined): CodeContext[] {
    // A browser has no filesystem, and its stack points at bundled output regardless.
    if (!stack || typeof window !== 'undefined') return [];

    const contexts: CodeContext[] = [];

    for (const raw of stack.split('\n')) {
        if (contexts.length >= MAX_FRAMES) break;

        const match = FRAME.exec(raw);
        if (!match) continue;

        const file = match[FILE].replace(/^file:\/\//, '');
        if (!isApplicationFrame(file)) continue;

        const lines = readLines(file);
        if (!lines) continue;

        const lineNumber = Number(match[LINE]);
        // Stack lines are 1-based and arrays are not.
        const index = lineNumber - 1;
        if (index < 0 || index >= lines.length) continue;

        contexts.push({
            file,
            line: lineNumber,
            column: Number(match[COLUMN]),
            function: match[FN],
            pre: lines.slice(Math.max(0, index - CONTEXT_LINES), index),
            source: lines[index],
            post: lines.slice(index + 1, index + 1 + CONTEXT_LINES),
        });
    }

    return contexts;
}
