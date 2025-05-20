/**
 * PostHog Transport for Pino Logger
 * Sends warning and error logs to PostHog for monitoring and analytics
 */

import { posthog } from '../posthog.service';
// Define a simple callback type instead of importing from pino
type TransportCallback = () => void;

/**
 * PostHog Transport for Pino
 * This transport sends logs to PostHog when they are warnings or errors
 */
export const pinoPostHogTransport = {
  /**
   * Process log entry and send to PostHog
   * @param line The log entry as a string
   * @param callback Callback to signal completion
   */
  write(line: string, callback: TransportCallback): void {
    try {
      // Parse the log line
      const log = JSON.parse(line);
      
      // Only forward warnings and errors to PostHog
      if (!log.level || !(log.level === 'warn' || log.level === 'error' || log.level === 50 || log.level === 40)) {
        callback();
        return;
      }

      // Extract data we need
      const {
        level,
        msg,
        err,
        error,
        module,
        service,
        userId,
        ...rest
      } = log;
      
      // Determine level name
      const levelName = typeof level === 'number' 
        ? (level === 50 ? 'error' : level === 40 ? 'warn' : 'info')
        : level;
        
      // Process error object if present
      const errorObj = err || error;
      const errorMessage = errorObj?.message || msg;
      const errorStack = errorObj?.stack;
      
      if (posthog) {
        if (levelName === 'error' || levelName === 'warn') {
          // Create an error object for PostHog
          const errorData = {
            name: errorObj?.name || levelName.toUpperCase(),
            message: errorMessage,
            stack: errorStack,
            level: levelName,
            module,
            userId: userId || 'system',
            ...rest
          };
          
          // Send to PostHog
          posthog.captureException(errorData, userId || 'system', {
            level: levelName,
            module,
            service,
            ...rest
          });
        }
      }
    } catch (err) {
      console.error('Error in PostHog transport:', err);
    }
    
    // Always call the callback to continue processing
    callback();
  }
};
