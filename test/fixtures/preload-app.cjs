// An application started with `node --require @zharp/logs/init` (or `--import`): it never calls
// init() itself, it only logs.
const { ZharpLogger } = require('@zharp/logs');

ZharpLogger.info(`preloaded ${process.argv[2]}`);
const active = ZharpLogger.isActive;
ZharpLogger.destroy().then(() => console.log(`RESULT ${JSON.stringify({ active })}`));
