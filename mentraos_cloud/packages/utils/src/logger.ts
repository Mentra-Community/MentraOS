import winston from 'winston';
import { UserSession } from '@augmentos/sdk';
import { PostHogTransport } from './PostHogTransport';

// Define the error structure
interface FormattedError {
  kind: string;
  message: string;
  stack: string;
}

// Helper function to convert Maps and Sets to regular objects/arrays
function safeStringify(obj: any): any {
  if (obj instanceof Map) {
    const result: Record<string, any> = {};
    obj.forEach((value, key) => {
      result[key] = safeStringify(value);
    });
    return result;
  } 
  if (obj instanceof Set) {
    return Array.from(obj).map(safeStringify);
  } 
  return obj;
}

// Factory function to create a logger
export function createLogger(defaultMeta = {}) {
  // Create a custom format that processes Map and Set objects
  const mapSetFormat = winston.format((info: any) => {
    // Check for splat (additional arguments)
    const splatSymbol = Symbol.for('splat');
    const splat = info[splatSymbol];
    
    if (splat && Array.isArray(splat) && splat.length > 0) {
      // Get the first argument
      const arg = splat[0];
      
      // Handle Maps and Sets specially
      if (arg instanceof Map || arg instanceof Set) {
        // Convert to plain object/array
        info.data = safeStringify(arg);
        
        // Remove from splat to prevent double logging
        delete info[splatSymbol];
      }
    }
    
    return info;
  });

  // Create a custom format that processes all kinds of objects
  const objectFormat = winston.format((info: any) => {
    // Check for splat (additional arguments)
    const splatSymbol = Symbol.for('splat');
    const splat = info[splatSymbol];
    
    if (splat && Array.isArray(splat) && splat.length > 0) {
      // Get the first argument
      const arg = splat[0];
      
      // Handle any type of object
      if (arg !== null && typeof arg === 'object') {
        // Convert Maps and Sets
        if (arg instanceof Map || arg instanceof Set) {
          info.data = safeStringify(arg);
        } else {
          // For regular objects and arrays
          info.data = arg;
        }
        
        // Remove from splat to prevent double logging
        delete info[splatSymbol];
      }
    }
    
    return info;
  });
  
  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    defaultMeta: {
      service: process.env.SERVICE_NAME || 'unknown-service',
      ...defaultMeta,
    },
    format: winston.format.combine(
      mapSetFormat(),
      objectFormat(),
      winston.format.timestamp(),
      winston.format.splat(),
      winston.format.json()
    ),
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.splat(),
          winston.format.printf(({ level, message, timestamp, userId, data, service, error, ...rest }) => {
            const splatSymbol = Symbol.for('splat');
            const splat = rest[splatSymbol];

            // Format user ID
            const userInfo = userId ? `${userId}` : '';
            
            // Format data (converted Map/Set)
            const dataStr = data ? `\n${JSON.stringify(data)}` : '';

            // Format splat (additional arguments) individually
            const splatStr = splat ? `\n${(splat as []).map((arg: any) => JSON.stringify(arg)).join('\n')}` : '';

            // Clean up rest object by removing numeric properties
            Object.keys(rest).forEach(key => {
              if (/^\d+$/.test(key)) {
                delete rest[key];
              }
            });
            
            // Format rest of metadata
            const metaStr = Object.keys(rest).length > 0 
              ? `\n${JSON.stringify(rest, null, 2)}` 
              : '';
            
            // Format error if present
            const errorStr = error 
              ? `\n${(error as FormattedError).stack}` 
              : '';
            
              // console.log("REST", rest);
              // console.log("SPLAT", splat);
            // return `[${level}, ${timestamp}, ${userInfo}]:\n${message}${metaStr}${errorStr}\n`;
            return `[${level}]: ${timestamp} ${userInfo}\n${message}${dataStr}${splatStr}${metaStr}${errorStr}\n`;
          })
        )
      }),
      new PostHogTransport({ level: 'warn', captureExceptions: true })
    ]
  });
}

export const systemLogger = createLogger();
export const logger = systemLogger;

export function createLoggerForUserSession(userId: string): winston.Logger {
  return createLogger({ userId });
}

// TODO(isaiah): Improve logger, sometimes it double logs objects 🙃.