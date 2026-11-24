/**
 * `dist/renderer.min.js`: the renderer SDK for a page without a bundler, as one script that
 * starts itself with the main process's settings and puts `Zharp` on the window.
 *
 *     <script src="../node_modules/@zharp/electron/dist/renderer.min.js"></script>
 *
 * A file of the app's own, so a strict `script-src 'self'` allows it.
 */
import { Zharp } from './index';

(globalThis as any).Zharp = Zharp;
Zharp.init();
