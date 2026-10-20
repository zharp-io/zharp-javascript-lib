// `node --require @zharp/logs/init app.js` — start logging from the environment before the
// application loads. See README.md, "Starting without code changes".
require('./dist/index.js').ZharpLogger.init();
