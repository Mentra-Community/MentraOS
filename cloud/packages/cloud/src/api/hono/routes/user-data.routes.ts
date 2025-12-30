/**
 * @fileoverview Hono user-data routes.
 * User data management endpoints including datetime settings.
 * Mounted at: /api/user-data
 */

import { Hono } from "hono";
import jwt from "jsonwebtoken";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import UserSession from "../../../services/session/UserSession";
import { StreamType, CloudToAppMessageType } from "@mentra/sdk";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "user-data.routes" });

const app = new Hono<AppEnv>();

const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

// ============================================================================
// Routes
// ============================================================================

app.post("/set-datetime", setDatetime);

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /api/user-data/set-datetime
 * Set the datetime for a user session and relay to subscribed apps.
 * Body: { coreToken: string, datetime: string (ISO format) }
 */
async function setDatetime(c: AppContext) {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { coreToken, datetime } = body as { coreToken?: string; datetime?: string };

    logger.debug({ datetime }, "Setting datetime with core token");

    // Validate inputs
    if (!coreToken) {
      return c.json({ error: "Missing coreToken" }, 400);
    }

    if (!datetime || isNaN(Date.parse(datetime))) {
      return c.json({ error: "Missing or invalid datetime (must be ISO string)" }, 400);
    }

    try {
      // Verify and decode the core token to extract userId
      const userData = jwt.verify(coreToken, AUGMENTOS_AUTH_JWT_SECRET);
      const userId = (userData as jwt.JwtPayload).email;

      if (!userId) {
        return c.json({ error: "Invalid core token - missing user email" }, 401);
      }

      logger.debug({ userId, datetime }, "Setting datetime for user");

      const userSession = UserSession.getById(userId);
      if (!userSession) {
        return c.json({ error: "User session not found" }, 404);
      }

      // Store the datetime in the session
      userSession.userDatetime = datetime;
      logger.debug({ userDatetime: userSession.userDatetime }, "User session updated");

      // Relay custom_message to all Apps subscribed to custom_message
      const subscribedApps = userSession.subscriptionManager.getSubscribedApps(StreamType.CUSTOM_MESSAGE);

      logger.debug({ subscribedApps }, "Subscribed apps for custom message");

      const customMessage = {
        type: CloudToAppMessageType.CUSTOM_MESSAGE,
        action: "update_datetime",
        payload: {
          datetime: datetime,
          section: "topLeft",
        },
        timestamp: new Date(),
      };

      for (const packageName of subscribedApps) {
        const appWebsocket = userSession.appWebsockets.get(packageName);
        if (appWebsocket && appWebsocket.readyState === 1) {
          appWebsocket.send(JSON.stringify(customMessage));
        }
      }

      return c.json({ success: true, userId, datetime });
    } catch (error) {
      logger.error(error, "Error verifying core token");
      return c.json({ error: "Invalid or expired core token" }, 401);
    }
  } catch (error) {
    logger.error(error, "Error processing set-datetime request");
    return c.json({ error: "Internal server error" }, 500);
  }
}

export default app;
