// What the dashboard tells Node users to write, loaded with `node --import ./instrument.mjs`.
import { Zharp } from '@zharp/node';

Zharp.init({
  key: process.env.ZHARP_E2E_NODE_KEY,
  service: 'checkout-api',
  environment: 'e2e',
  endpoint: process.env.ZHARP_E2E_ENDPOINT,
  release: 'api@e2e',
});
