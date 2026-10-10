import {createLoggerWithOutput} from './logger.js';
import type {LoggerOptions, Logger} from './logger.js';
export type {Logger, LogFields, UserScope, LoggerOptions} from './logger.js';
/** JSON stdout logging; log-reading credentials belong to the incident collector. */
export function createLogger(options: LoggerOptions): Logger {
  return createLoggerWithOutput(options, line => {
    if (!process.stdout.destroyed && !process.stdout.writableNeedDrain) process.stdout.write(line);
  });
}
