// Caught errors logged the usual ways — each should arrive with its stack, with nobody passing it.
const { ZharpLogger } = require('@zharp/logs');

ZharpLogger.init({ apiKey: 'errors-logged', service: 'errors-app', endpoint: process.env.ZHARP_TEST_ENDPOINT });

function charge() {
  throw new TypeError('card declined');
}

try { charge(); } catch (err) { ZharpLogger.error(err); }
try { charge(); } catch (err) { err.code = 'E_CARD'; ZharpLogger.error('Payment failed', { err, orderId: 99 }); }
ZharpLogger.warn('nested', { result: { errors: [new Error('sync failed', { cause: new RangeError('page out of range') })] } });
ZharpLogger.error('explicit stack', { stack: 'my own stack' });
ZharpLogger.info('plain', { a: 1, when: new Date(0), list: [1, 2] });

ZharpLogger.destroy().then(() => console.log('RESULT {}'));
