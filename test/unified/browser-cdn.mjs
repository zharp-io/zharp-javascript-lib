// The script-tag build: one file that gives the page a global `Zharp`.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const code = readFileSync(new URL('../../packages/browser/dist/zharp.min.js', import.meta.url), 'utf8');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:5173/', runScripts: 'outside-only' });
dom.window.eval(code);
const Z = dom.window.Zharp;
const api = ['init', 'setUser', 'clearUser', 'captureError', 'startSpan', 'setTag', 'flush'].filter((k) => typeof Z?.[k] === 'function');
console.log(`RESULT ${JSON.stringify({ type: typeof Z, api, log: Object.keys(Z?.log ?? {}) })}`);
