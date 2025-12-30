// posthog.service.ts
import { PostHog } from "posthog-node";

import { logger } from "./pino-logger";

// Environment constants (mirroring pino-logger for consistency)
const NODE_ENV = process.env.NODE_ENV || "development";
const PORTER_APP_NAME = process.env.PORTER_APP_NAME || "cloud-local";
const REGION = process.env.REGION || process.env.AZURE_SPEECH_REGION || "";
const DEPLOYMENT_REGION = process.env.DEPLOYMENT_REGION;

// Beta flag - true only when connected to staging environment
const isBeta = NODE_ENV === "staging";

const isChina = DEPLOYMENT_REGION === "china";

export const posthog =
  process.env.POSTHOG_PROJECT_API_KEY && !isChina
    ? new PostHog(
        process.env.POSTHOG_PROJECT_API_KEY!, // project API key
        {
          host: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
          flushAt: 20, // batch size
          flushInterval: 5_000, // ms
        },
      )
    : null;

if (posthog) {
  console.log("POSTHOG INITIALIZED");
  process.on("beforeExit", async () => posthog.shutdown()); // ensure flush
} else if (!isChina) {
  console.warn("PostHog API key not provided. Analytics will be disabled.");
} else if (isChina) {
  console.warn("PostHog is disabled for China");
}

// Interface for event properties for type safety.
interface EventProperties {
  [key: string]: any;
}

// Base properties included in all PostHog events (mirrors pino-logger base config)
const baseProperties = {
  env: NODE_ENV,
  server: PORTER_APP_NAME,
  region: REGION,
  beta: isBeta,
};

/**
 * Track an event in PostHog.
 * @param eventName - Name of the event to capture.
 * @param userId - User ID or distinct session ID (if available).
 * @param properties - Additional metadata to attach to the event.
 */
async function trackEvent(
  eventName: string,
  userId?: string,
  properties: EventProperties = {},
): Promise<void> {
  // Only proceed if PostHog is initialized
  if (!posthog) return;
  try {
    posthog.capture({
      distinctId: userId || properties.sessionId || "anonymous", // use provided user ID or fallback
      event: eventName,
      properties: {
        ...baseProperties,
        ...properties,
        timestamp: properties.timestamp || new Date().toISOString(),
      },
    });
  } catch (err) {
    // Log any errors to avoid failing the main application flow
    logger.error(err as Error, "PostHog tracking error:");
  }
}

/**
 * Set person properties in PostHog.
 * @param userId - User ID to set properties for.
 * @param properties - Properties to set on the user profile.
 */
async function setPersonProperties(
  userId: string,
  properties: EventProperties = {},
): Promise<void> {
  // Only proceed if PostHog is initialized
  if (!posthog) return;
  try {
    posthog.capture({
      distinctId: userId,
      event: "$set",
      properties: {
        $set: {
          ...baseProperties,
          ...properties,
        },
      },
    });
    // posthog.identify({
    //   distinctId: userId,
    //   properties: {
    //     $set: properties
    //   }
    // });
  } catch (err) {
    // Log any errors to avoid failing the main application flow
    logger.error(err as Error, "PostHog person properties error:");
  }
}

export const PosthogService = {
  trackEvent,
  setPersonProperties,
};
