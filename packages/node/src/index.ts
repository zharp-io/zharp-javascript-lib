import { ZharpNode } from './zharp';

export { ZharpNode } from './zharp';
export { VERSION } from './version';
export type { NodeOptions, ZharpUser, Attributes, AttributeValue, CaptureBodies, CaptureBodiesOptions } from './types';
export type { ServerlessOptions } from './serverless';

// One instance per process, kept on globalThis: `instrument.mjs` imports the ES build and the
// application may `require` the CommonJS one, and both must reach the SDK that was started.
const g = globalThis as any;
export const Zharp: ZharpNode = g.__ZHARP_NODE__ ?? (g.__ZHARP_NODE__ = new ZharpNode());
export default Zharp;
