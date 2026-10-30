// An uncaught exception: reported as unhandled, then the process exits 1 as Node would.
setTimeout(() => {
  throw new RangeError(`crash ${process.env.ZHARP_E2E_RUN}`);
}, 10);
