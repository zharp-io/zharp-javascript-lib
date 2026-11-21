#!/usr/bin/env node
// `npx zharp …` is @zharp/cli: this package only gives it the short name.
const { dirname, join } = require('node:path');
require(join(dirname(require.resolve('@zharp/cli/package.json')), 'dist', 'cli.js'));
