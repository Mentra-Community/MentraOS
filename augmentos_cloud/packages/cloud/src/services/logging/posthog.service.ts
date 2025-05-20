// posthog.service.ts
import { logger } from './pino-logger';
import { PostHog } from 'posthog-node';

export const posthog = process.env.POSTHOG_PROJECT_API_KEY ? new PostHog(
  process.env.POSTHOG_PROJECT_API_KEY!,                         // project API key
  {
    host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
    flushAt: 20,          // batch size
    flushInterval: 5_000, // ms
  }
) : null

if (posthog) {
  console.log("POSTHOG INITIALIZED")
  process.on('beforeExit', async () => posthog.shutdown())   // ensure flush
} else {
  console.warn('PostHog API key not provided. Analytics will be disabled.');
}

// Interface for event properties for type safety.
interface EventProperties {
  [key: string]: any;
}

/**
 * Track an event in PostHog.
 * @param eventName - Name of the event to capture.
 * @param userId - User ID or distinct session ID (if available).
 * @param properties - Additional metadata to attach to the event.
 */
async function trackEvent(
  eventName: string,
  userId?: string,
  properties: EventProperties = {}
): Promise<void> {
  // Only proceed if PostHog is initialized
  if (!posthog) return;
  try {
    posthog.capture({
      distinctId: userId || properties.sessionId || 'anonymous',  // use provided user ID or fallback
      event: eventName,
      properties: {
        ...properties,
        timestamp: properties.timestamp || new Date().toISOString()
      }
    });
  } catch (err) {
    // Log any errors to avoid failing the main application flow
    logger.error('PostHog tracking error:', err);
  }
}

export const PosthogService = {
  trackEvent
}