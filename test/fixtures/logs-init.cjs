// ZharpLogger.init() with whatever options argv[2] gives (none: everything from the environment).
const { ZharpLogger } = require('@zharp/logs');

const options = process.argv[2] ? JSON.parse(process.argv[2]) : undefined;
ZharpLogger.init(options);
ZharpLogger.info(`init-check ${process.argv[3] ?? ''}`.trim());
const active = ZharpLogger.isActive;
ZharpLogger.destroy().then(() => console.log(`RESULT ${JSON.stringify({ active })}`));
