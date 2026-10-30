// The script-tag build: `<script src=".../zharp.min.js">` gives the page a global `Zharp`.
import { Zharp } from './index';
import { rememberScriptSrc } from './replay/controller';

// Read now: `currentScript` is only set while this script is first running.
rememberScriptSrc(typeof document !== 'undefined' ? (document.currentScript as HTMLScriptElement | null)?.src : undefined);
(globalThis as any).Zharp = Zharp;
