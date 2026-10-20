// The ES-module version of preload-app.cjs.
import { ZharpLogger } from '@zharp/logs';

ZharpLogger.info(`preloaded ${process.argv[2]}`);
const active = ZharpLogger.isActive;
await ZharpLogger.destroy();
console.log(`RESULT ${JSON.stringify({ active })}`);
