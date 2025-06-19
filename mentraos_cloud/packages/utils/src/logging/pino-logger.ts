import pino from 'pino';
import { posthog } from '../posthog';

// Constants and configuration
const BETTERSTACK_SOURCE_TOKEN = process.env.BETTERSTACK_SOURCE_TOKEN;
const BETTERSTACK_ENDPOINT = process.env.BETTERSTACK_ENDPOINT || 'https://s1311181.eu-nbg-2.betterstackdata.com';
const NODE_ENV = process.env.NODE_ENV || 'development';
const SERVICE_NAME = process.env.SERVICE_NAME || 'augmentos-cloud';

// Determine log level based on environment
const LOG_LEVEL = NODE_ENV === 'production' ? 'info' : 'debug';

// Define the BetterStack transport configuration
const transport = pino.transport({
  target: '@logtail/pino',
  options: {
    sourceToken: BETTERSTACK_SOURCE_TOKEN,
    options: { endpoint: BETTERSTACK_ENDPOINT },
  },
});

/**
 * Configuration for the root logger
 */
const baseLoggerOptions: pino.LoggerOptions = {
  level: LOG_LEVEL,
  base: {
    env: NODE_ENV,
    service: SERVICE_NAME,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // formatters: {
  //   level: (label) => {
  //     return { level: label };
  //   },
  //   // Handle Error objects specially
  //   log: (object) => {
  //     const result: Record<string, any> = { ...object };
      
  //     // Handle Error objects
  //     if (object.error && object.error instanceof Error) {
  //       result.error = {
  //         message: object.error.message,
  //         name: object.error.name,
  //         stack: object.error.stack,
  //       };
  //     }
      
  //     // Handle Maps and Sets
  //     for (const key in object) {
  //       if (object[key] instanceof Map) {
  //         result[key] = Object.fromEntries(object[key]);
  //       } else if (object[key] instanceof Set) {
  //         result[key] = Array.from(object[key]);
  //       }
  //     }
      
  //     return result;
  //   },
  // },
};

// Create the root logger
export const rootLogger = BETTERSTACK_SOURCE_TOKEN
  ? pino(baseLoggerOptions, transport)
  : pino(baseLoggerOptions);

/**
 * Creates a child logger for a specific service
 * @param serviceName The name of the service
 * @returns A child logger with service context
 */
export function createServiceLogger(serviceName: string) {
  return rootLogger.child({ service: serviceName });
}

/**
 * Creates a child logger for a specific file
 * @param fileName The name of the file
 * @param serviceName Optional service name for additional context
 * @returns A child logger with file context
 */
export function createFileLogger(fileName: string, serviceName?: string) {
  return rootLogger.child({ 
    file: fileName,
    ...(serviceName && { service: serviceName })
  });
}

/**
 * Interface for session logger context
 */
export interface SessionLoggerContext {
  sessionId: string;
  userId: string;
  [key: string]: any;
}

/**
 * Creates a child logger for a user session
 * @param context The session context (sessionId, userId, etc.)
 * @param serviceName Optional service name for additional context
 * @returns A child logger with session context
 */
export function createSessionLogger(context: SessionLoggerContext, serviceName?: string) {
  return rootLogger.child({
    ...context,
    ...(serviceName && { service: serviceName })
  });
}

/**
 * Track exceptions in PostHog
 * @param error The error object
 * @param context Additional context
 */
export function trackException(error: Error, context: Record<string, any> = {}) {
  if (posthog) {
    const distinctId = context.userId || context.sessionId || 'system';
    
    posthog.captureException({
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...context
    }, distinctId, context);
  }
}

/**
 * Helper function for safely serializing complex objects
 * @param obj The object to serialize
 * @returns A serializable version of the object
 */
export function safeSerialize(obj: any): any {
  if (obj instanceof Map) {
    return Object.fromEntries(obj);
  } 
  if (obj instanceof Set) {
    return Array.from(obj);
  }
  if (obj instanceof Error) {
    return {
      name: obj.name,
      message: obj.message,
      stack: obj.stack
    };
  }
  return obj;
}

// Default export is the root logger
export default rootLogger;