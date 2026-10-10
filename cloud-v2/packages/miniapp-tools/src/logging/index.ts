import {createLoggerWithOutput} from './logger.js';
import type {LoggerOptions, Logger} from './logger.js';
export type {Logger, LogFields, UserScope, LoggerOptions} from './logger.js';

// A single process-wide adapter, shared by every logger. Node reports broken
// pipes asynchronously; catching write() alone cannot contain those failures.
let stdoutFailed = false;
let watchingStdout = false;
function writeStdout(line: string): void {
  if (!watchingStdout) {
    process.stdout.on('error', () => { stdoutFailed = true; });
    watchingStdout = true;
  }
  if (!stdoutFailed && !process.stdout.destroyed && !process.stdout.writableNeedDrain) process.stdout.write(line);
}

/** JSON stdout logging; log-reading credentials belong to the incident collector. */
export function createLogger(options: LoggerOptions): Logger {
  return createLoggerWithOutput(options, writeStdout);
}
