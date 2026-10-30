// A rejected key: one warning, then nothing more is sent from the page.
import { installPage, endpoint, wait, result } from './page.mjs';

installPage();
const warnings = [];
const warn = console.warn;
console.warn = (...args) => {
  warnings.push(args.join(' '));
  warn(...args);
};
const { Zharp } = await import('@zharp/browser');
Zharp.init({ key: 'rejected-key', service: 'web-rejected', endpoint });
Zharp.log.info('first');
await Zharp.flush();
Zharp.log.info('second');
Zharp.captureError(new Error('third'));
await wait(50);
await Zharp.flush();
result({ warnings: warnings.filter((w) => w.startsWith('[Zharp]')) });
process.exit(0);
