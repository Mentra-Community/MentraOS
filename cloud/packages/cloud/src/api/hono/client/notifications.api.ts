/**
 * @fileoverview Hono notifications API routes.
 * API endpoints for phone notifications from mobile clients.
 * Mounted at: /api/client/notifications
 */

import { Hono } from "hono";
import { StreamType } from "@mentra/sdk";
import { clientAuth, requireUserSession } from "../middleware/client.middleware";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "notifications.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.post("/", clientAuth, requireUserSession, handlePhoneNotification);
app.post("/dismissed", clientAuth, requireUserSession, handlePhoneNotificationDismissed);

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /api/client/notifications
 * Handle incoming phone notification from mobile client.
 * Body: { notificationId, app, title, content, priority, timestamp, packageName }
 */
async function handlePhoneNotification(c: AppContext) {
  const userSession = c.get("userSession")!;
  const reqLogger = c.get("logger") || logger;

  try {
    const body = await c.req.json().catch(() => ({}));
    const { notificationId, app, title, content, priority, timestamp, packageName } = body as {
      notificationId?: string;
      app?: string;
      title?: string;
      content?: string;
      priority?: string;
      timestamp?: number;
      packageName?: string;
    };

    // Validate required fields
    if (!notificationId || !app || !title || !content) {
      return c.json(
        {
          success: false,
          message: "Missing required fields: notificationId, app, title, content",
        },
        400,
      );
    }

    // Create notification message to relay to apps
    const notificationMessage = {
      type: StreamType.PHONE_NOTIFICATION,
      notificationId,
      app,
      title,
      content,
      priority: priority || "normal",
      timestamp: timestamp || Date.now(),
      packageName,
    };

    reqLogger.debug(
      { notification: notificationMessage },
      `Phone notification received from mobile for user ${userSession.userId}`,
    );

    // Relay to all apps subscribed to phone_notification stream
    userSession.relayMessageToApps(notificationMessage);

    return c.json({
      success: true,
      message: "Notification relayed to subscribed apps",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    reqLogger.error(error, `Error handling phone notification for user ${userSession.userId}:`);

    return c.json(
      {
        success: false,
        message: "Failed to handle phone notification",
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
}

/**
 * POST /api/client/notifications/dismissed
 * Handle phone notification dismissal from mobile client.
 * Body: { notificationId, notificationKey, packageName }
 */
async function handlePhoneNotificationDismissed(c: AppContext) {
  const userSession = c.get("userSession")!;
  const reqLogger = c.get("logger") || logger;

  try {
    const body = await c.req.json().catch(() => ({}));
    const { notificationId, notificationKey, packageName } = body as {
      notificationId?: string;
      notificationKey?: string;
      packageName?: string;
    };

    // Validate required fields
    if (!notificationId || !notificationKey || !packageName) {
      return c.json(
        {
          success: false,
          message: "Missing required fields: notificationId, notificationKey, packageName",
        },
        400,
      );
    }

    // Create dismissal message to relay to apps
    const dismissalMessage = {
      type: StreamType.PHONE_NOTIFICATION_DISMISSED,
      notificationId,
      notificationKey,
      packageName,
      timestamp: Date.now(),
    };

    reqLogger.debug(
      { dismissal: dismissalMessage },
      `Phone notification dismissal received from mobile for user ${userSession.userId}`,
    );

    // Relay to all apps subscribed to phone_notification_dismissed stream
    userSession.relayMessageToApps(dismissalMessage);

    return c.json({
      success: true,
      message: "Notification dismissal relayed to subscribed apps",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    reqLogger.error(error, `Error handling phone notification dismissal for user ${userSession.userId}:`);

    return c.json(
      {
        success: false,
        message: "Failed to handle phone notification dismissal",
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
}

export default app;
