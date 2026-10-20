// `node --require @zharp/apm/init app.js` — start tracing from the environment before the
// application loads, so `http` is patched before anything holds on to it. See README.md.
require('./dist/index.js').ZharpAPM.init();
