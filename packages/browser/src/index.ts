import { ZharpBrowser } from './client';

export { ZharpBrowser } from './client';
export type { ZharpSpan } from './client';
export { VERSION } from './version';
export type { BrowserOptions, ReplayOptions, ReplayEvent, ZharpUser, Attributes } from './types';

// One instance per page, kept on globalThis: two copies of the package in one bundle (or the
// script tag and a bundle) must not patch fetch twice or keep two sessions.
const g = globalThis as any;
export const Zharp: ZharpBrowser = g.__ZHARP_BROWSER__ ?? (g.__ZHARP_BROWSER__ = new ZharpBrowser());
export default Zharp;
