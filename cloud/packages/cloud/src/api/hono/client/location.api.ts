/**
 * @fileoverview Hono location API routes.
 * API endpoints for location updates from mobile clients.
 * Mounted at: /api/client/location
 */

import { Hono } from "hono";
import { clientAuth, requireUserSession } from "../middleware/client.middleware";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "location.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.post("/", clientAuth, requireUserSession, updateLocation);
app.post("/poll-response/:correlationId", clientAuth, requireUserSession, updateLocationPollResponse);

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /api/client/location
 * Update location from mobile client.
 * Body: { location: { coords: { latitude, longitude, ... } } } or Expo LocationObject directly
 */
async function updateLocation(c: AppContext) {
  const userSession = c.get("userSession")!;
  const reqLogger = c.get("logger") || logger;

  try {
    const body = await c.req.json().catch(() => ({}));

    // Accept both formats:
    // 1. { location: { coords: { latitude, longitude, ... } } } - wrapped format
    // 2. { coords: { latitude, longitude, ... } } - Expo LocationObject directly
    let location = (body as any).location;

    // If no 'location' wrapper but has 'coords', treat the body as the location object itself
    if (!location && (body as any).coords && typeof (body as any).coords === "object") {
      location = body;
      reqLogger.debug(
        { userId: userSession.userId },
        "Location API received unwrapped Expo LocationObject format - auto-wrapping",
      );
    }

    if (!location || typeof location !== "object") {
      reqLogger.warn(
        {
          userId: userSession.userId,
          bodyKeys: Object.keys(body || {}),
          hasLocation: !!(body as any)?.location,
          hasCoords: !!(body as any)?.coords,
        },
        "Location API received invalid payload - missing location object",
      );
      return c.json(
        {
          success: false,
          message: "location object required. Expected { location: {...} } or Expo LocationObject with coords",
        },
        400,
      );
    }

    await userSession.locationManager.updateFromAPI({ location });

    return c.json({
      success: true,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    reqLogger.error(error, `Error updating location for user ${userSession.userId}:`);

    return c.json(
      {
        success: false,
        message: "Failed to update location",
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
}

/**
 * POST /api/client/location/poll-response/:correlationId
 * Update location as a response to a poll request.
 * Body: { location: { coords: { latitude, longitude, ... } } } or Expo LocationObject directly
 */
async function updateLocationPollResponse(c: AppContext) {
  const userSession = c.get("userSession")!;
  const reqLogger = c.get("logger") || logger;
  const correlationId = c.req.param("correlationId");

  try {
    const body = await c.req.json().catch(() => ({}));

    // Accept both formats (same as updateLocation)
    let location = (body as any).location;

    if (!location && (body as any).coords && typeof (body as any).coords === "object") {
      location = body;
      reqLogger.debug(
        { userId: userSession.userId, correlationId },
        "Location poll-response API received unwrapped Expo LocationObject format - auto-wrapping",
      );
    }

    if (!location || typeof location !== "object") {
      reqLogger.warn(
        {
          userId: userSession.userId,
          correlationId,
          bodyKeys: Object.keys(body || {}),
          hasLocation: !!(body as any)?.location,
          hasCoords: !!(body as any)?.coords,
        },
        "Location poll-response API received invalid payload - missing location object",
      );
      return c.json(
        {
          success: false,
          message: "location object required. Expected { location: {...} } or Expo LocationObject with coords",
        },
        400,
      );
    }

    if (!correlationId) {
      return c.json(
        {
          success: false,
          message: "correlationId parameter required",
        },
        400,
      );
    }

    // Add correlationId to location payload
    const locationWithCorrelation = {
      ...location,
      correlationId,
    };

    await userSession.locationManager.updateFromAPI({
      location: locationWithCorrelation,
    });

    return c.json({
      success: true,
      resolved: true, // Indicates this was a poll response
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    reqLogger.error(error, `Error updating location poll response for user ${userSession.userId}:`);

    return c.json(
      {
        success: false,
        message: "Failed to update location poll response",
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
}

export default app;
