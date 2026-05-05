/**
 * PostHog Analytics
 *
 * Singleton client for event tracking in the Mentra CLI.
 * Uses flushAt:1 / flushInterval:0 for immediate sends in this short-lived CLI process.
 */

import { PostHog } from "posthog-node";

let _client: PostHog | null = null;

function getClient(): PostHog {
  if (!_client) {
    _client = new PostHog(process.env.POSTHOG_API_KEY ?? "", {
      host: process.env.POSTHOG_HOST,
      flushAt: 1,
      flushInterval: 0,
      enableExceptionAutocapture: true,
    });
  }
  return _client;
}

export const posthog = {
  capture(distinctId: string, event: string, properties?: Record<string, any>) {
    try {
      getClient().capture({ distinctId, event, properties });
    } catch {
      // Never let analytics errors affect CLI behaviour
    }
  },

  identify(distinctId: string, properties?: Record<string, any>) {
    try {
      getClient().identify({ distinctId, properties });
    } catch {
      // Never let analytics errors affect CLI behaviour
    }
  },

  captureException(error: unknown, distinctId?: string) {
    try {
      getClient().captureException(error, distinctId);
    } catch {
      // Never let analytics errors affect CLI behaviour
    }
  },

  async shutdown() {
    try {
      if (_client) {
        await _client.shutdown();
      }
    } catch {
      // Ignore shutdown errors
    }
  },
};
