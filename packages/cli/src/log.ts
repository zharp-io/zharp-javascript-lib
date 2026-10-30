/** Where progress goes. The CLI prints it; the bundler plugins prefix it with their name. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

export const consoleLogger = (prefix = '[zharp]'): Logger => ({
  info: (message) => console.log(`${prefix} ${message}`),
  warn: (message) => console.warn(`${prefix} ${message}`),
});

export const silentLogger: Logger = { info() {}, warn() {} };
