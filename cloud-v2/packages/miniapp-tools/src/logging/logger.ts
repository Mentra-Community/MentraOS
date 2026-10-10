import pino from 'pino';
import {sanitize} from './sanitize.js';
export type LogFields = Readonly<Record<string, unknown>>;
export type UserScope = {mentraUserId: string; requestId?: string; sessionId?: string};
export type LoggerOptions = {packageName: string; environment: string; version?: string; level?: 'debug' | 'info' | 'warn' | 'error'};
export interface Logger {
  forUser(scope: UserScope): Logger;
  child(fields: LogFields): Logger;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}
const RESERVED = new Set(['mentraUserId', 'userId', 'packageName', 'environment', 'version', 'timestamp', 'level', 'message', 'msg', 'time']);
const MAX_LINE_BYTES = 32 * 1024;
function fieldsOnly(fields: LogFields): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !RESERVED.has(key)));
}
/** Internal output seam for deterministic tests, not part of the package export. */
export function createLoggerWithOutput(options: LoggerOptions, output: (line: string) => void): Logger {
  if (!/^[A-Za-z0-9_.-]+$/.test(options.packageName) || !/^[A-Za-z0-9_-]+$/.test(options.environment)) throw new Error('Logger requires packageName and environment');
  if ([options.packageName, options.environment, options.version ?? ''].some(value => value.length > 256)) throw new Error('Logger metadata exceeds 256 characters');
  const base = {packageName: options.packageName, environment: options.environment, ...(options.version ? {version: String(sanitize(options.version))} : {})};
  const sink = {write(line: string) {
    try {
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        const row = JSON.parse(line) as Record<string, unknown>;
        const retained = Object.fromEntries(Object.entries(row).filter(([key]) => ['level', 'packageName', 'environment', 'version', 'mentraUserId', 'timestamp'].includes(key)));
        retained.truncated = true;
        // JSON escapes can cost six bytes per character. Apply the byte limit
        // to the serialized result, not just to the source string length.
        for (const key of ['requestId', 'sessionId', 'message']) {
          const value = row[key];
          if (typeof value !== 'string') continue;
          retained[key] = value;
          while (Buffer.byteLength(JSON.stringify(retained)) + 1 > MAX_LINE_BYTES && String(retained[key]).length > 0) {
            retained[key] = String(retained[key]).slice(0, Math.floor(String(retained[key]).length / 2));
          }
        }
        line = JSON.stringify(retained) + '\n';
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) return;
      }
      output(line);
    } catch { /* Logging never changes a business operation's outcome. */ }
  }};
  const engine = pino({base: null, level: options.level ?? 'info', messageKey: 'message', timestamp: false,
    formatters: {level: label => ({level: label})}}, sink);
  function scoped(scope: Record<string, unknown>, fields: LogFields = {}): Logger {
    const inherited = sanitize(fieldsOnly(fields)) as Record<string, unknown>;
    const emit = (level: NonNullable<LoggerOptions['level']>, message: string, extra: LogFields = {}) => {
      try {
        const safe = sanitize({...inherited, ...fieldsOnly(extra)}) as Record<string, unknown>;
        engine[level]({...safe, ...base, ...scope, timestamp: new Date().toISOString()}, String(sanitize(message)));
      } catch { /* Malformed diagnostic values must not break application code. */ }
    };
    return {
      forUser(user) {
        if (!/^mu_[A-Z0-9]{26}$/.test(user.mentraUserId)) throw new Error('Logger requires an authenticated Mentra user ID');
        if (scope.mentraUserId && scope.mentraUserId !== user.mentraUserId) throw new Error('Cannot rebind a user-scoped logger');
        return scoped({...scope, mentraUserId: user.mentraUserId}, {...inherited, ...(user.requestId ? {requestId: user.requestId} : {}), ...(user.sessionId ? {sessionId: user.sessionId} : {})});
      },
      child(extra) { return scoped(scope, {...inherited, ...fieldsOnly(extra)}); },
      debug: (message, extra) => emit('debug', message, extra), info: (message, extra) => emit('info', message, extra),
      warn: (message, extra) => emit('warn', message, extra), error: (message, extra) => emit('error', message, extra),
    };
  }
  return scoped({});
}
