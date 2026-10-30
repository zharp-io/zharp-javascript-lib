// Uncaught exception or unhandled rejection: reported, then the process exits 1 as Node would.
console.log('RESULT {}');
if (process.argv[2] === 'reject') {
  Promise.reject(new SyntaxError('rejected and nobody listened'));
} else {
  setTimeout(() => {
    throw new RangeError('thrown and nobody caught');
  }, 5);
}
