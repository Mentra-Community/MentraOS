/**
 * @fileoverview Hono hardware routes.
 * Handle hardware-related requests from smart glasses.
 * Mounted at: /api/hardware
 */

import { Hono } from "hono";
import jwt from "jsonwebtoken";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import UserSession from "../../../services/session/UserSession";
import { StreamType } from "@mentra/sdk";
import photoRequestService from "../../../services/core/photo-request.service";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "hardware.routes" });

const app = new Hono<AppEnv>();

const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

// ============================================================================
// Routes
// ============================================================================

app.post("/button-press", validateGlassesAuth, handleButtonPress);
app.get("/system-photo-request/:requestId", validateGlassesAuth, getSystemPhotoRequest);

// ============================================================================
// Middleware
// ============================================================================

/**
 * Middleware to validate glasses authentication.
 * Checks JWT token from Authorization header.
 */
async function validateGlassesAuth(c: AppContext, next: () => Promise<void>) {
  const authHeader = c.req.header("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;

    if (!decoded || !decoded.email) {
      return c.json({ error: "Invalid token data" }, 401);
    }

    c.set("email", decoded.email.toLowerCase());
    // Store decoded token for access in handlers
    (c as any).decodedToken = decoded;

    await next();
  } catch (error) {
    logger.debug({ error }, "Token verification failed");
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /api/hardware/button-press
 * Handles button press events from glasses.
 * Requires glasses authentication.
 */
async function handleButtonPress(c: AppContext) {
  try {
    const decodedToken = (c as any).decodedToken;
    const userId = decodedToken?.email;

    if (!userId) {
      return c.json({ error: "User ID not found in token" }, 401);
    }

    const body = await c.req.json().catch(() => ({}));
    const { buttonId, pressType } = body as { buttonId?: string; pressType?: string };

    logger.info(`Button press event from user ${userId}: ${buttonId} (${pressType})`);

    // Find the user's active session
    const userSession = UserSession.getById(userId);

    // Check if any Apps are subscribed to button events
    const subscribedApps = userSession
      ? userSession.subscriptionManager.getSubscribedApps(StreamType.BUTTON_PRESS)
      : [];

    if (subscribedApps.length === 0) {
      // No Apps subscribed, handle as system action
      logger.info(`No Apps subscribed to button events for user ${userId}, handling as system action`);

      // Create a system photo request using the centralized service
      const requestId = photoRequestService.createSystemPhotoRequest(userId);

      return c.json({
        success: true,
        action: "take_photo",
        requestId,
      });
    } else {
      // Apps are subscribed, let them handle the button press
      logger.info(`Apps subscribed to button events for user ${userId}: ${subscribedApps.join(", ")}`);

      return c.json({
        success: true,
      });
    }
  } catch (error) {
    logger.error(error, "Error handling button press:");
    return c.json({ error: "Failed to process button press" }, 500);
  }
}

/**
 * GET /api/hardware/system-photo-request/:requestId
 * Checks if a system photo request exists.
 * Requires glasses authentication.
 */
async function getSystemPhotoRequest(c: AppContext) {
  try {
    const requestId = c.req.param("requestId");

    if (!requestId) {
      return c.json({ error: "Request ID is required" }, 400);
    }

    const photoRequest = photoRequestService.getPendingPhotoRequest(requestId);

    if (!photoRequest || photoRequest.origin !== "system") {
      return c.json(
        {
          success: false,
          message: "Photo request not found",
        },
        404,
      );
    }

    return c.json({
      success: true,
      action: "take_photo",
    });
  } catch (error) {
    logger.error(error, "Error checking system photo request:");
    return c.json({ error: "Failed to check system photo request" }, 500);
  }
}

export default app;
