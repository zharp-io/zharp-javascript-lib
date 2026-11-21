#!/usr/bin/env node
// `npm init zharp` (or `npm create zharp`) runs this with no arguments: that is `zharp init`. Anything else is passed
// to @zharp/cli as it is (`npm init zharp -- --yes`).
const { dirname, join } = require('node:path');
const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith('-')) process.argv.splice(2, 0, 'init');
require(join(dirname(require.resolve('@zharp/cli/package.json')), 'dist', 'cli.js'));
