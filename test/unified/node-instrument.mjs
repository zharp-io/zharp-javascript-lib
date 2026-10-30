// Preloaded with `node --import`, as the dashboard tells people to.
import { Zharp } from '@zharp/node';

Zharp.init({
  key: process.env.TEST_KEY,
  service: 'node-test',
  environment: 'test',
  release: 'api@1',
  endpoint: `${process.env.ZHARP_TEST_ENDPOINT}/otlp`,
});
