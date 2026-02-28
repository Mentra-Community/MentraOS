// cloud/src/api/client/location.api.ts
// API endpoints for location updates from mobile clients

import { Router, Request, Response } from "express";

import { logger as rootLogger } from "../../services/logging/pino-logger";
import { clientAuthWithUserSession, RequestWithUserSession } from "../middleware/client.middleware";

const router = Router();
const logger = rootLogger.child({ service: "location.api" });

// API Endpoints // /api/client/location/*
router.post("/", clientAuthWithUserSession, updateLocation);
router.post("/poll-response/:correlationId", clientAuthWithUserSession, updateLocationPollResponse);

// Handler functions
// POST     /api/client/location
// BODY     { location: { lat, lng, accuracy?, timestamp? } } or Expo LocationObject directly
async function updateLocation(req: Request, res: Response) {
  const _req = req as RequestWithUserSession;
  const userSession = _req.userSession;

  // Accept both formats:
  // 1. { location: { coords: { latitude, longitude, ... } } } - wrapped format
  // 2. { coords: { latitude, longitude, ... } } - Expo LocationObject directly
  let location = req.body.location;

  // If no 'location' wrapper but has 'coords', treat the body as the location object itself
  if (!location && req.body.coords && typeof req.body.coords === "object") {
    location = req.body;
    logger.debug(
      { userId: userSession.userId },
      "Location API received unwrapped Expo LocationObject format - auto-wrapping",
    );
  }

  if (!location || typeof location !== "object") {
    logger.warn(
      {
        userId: userSession.userId,
        bodyKeys: Object.keys(req.body || {}),
        hasLocation: !!req.body?.location,
        hasCoords: !!req.body?.coords,
      },
      "Location API received invalid payload - missing location object",
    );
    return res.status(400).json({
      success: false,
      message: "location object required. Expected { location: {...} } or Expo LocationObject with coords",
    });
  }

  try {
    await userSession.locationManager.updateFromAPI({ location });
    return res.json({
      success: true,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    _req.logger.error(error, `Error updating location for user ${userSession.userId}:`);

    return res.status(500).json({
      success: false,
      message: "Failed to update location",
      timestamp: new Date().toISOString(),
    });
  }
}

// POST     /api/client/location/poll-response/:correlationId
// BODY     { location: { lat, lng, accuracy?, timestamp? } } or Expo LocationObject directly
async function updateLocationPollResponse(req: Request, res: Response) {
  const _req = req as RequestWithUserSession;
  const userSession = _req.userSession;
  const { correlationId } = req.params;

  // Accept both formats (same as updateLocation)
  let location = req.body.location;

  if (!location && req.body.coords && typeof req.body.coords === "object") {
    location = req.body;
    logger.debug(
      { userId: userSession.userId, correlationId },
      "Location poll-response API received unwrapped Expo LocationObject format - auto-wrapping",
    );
  }

  if (!location || typeof location !== "object") {
    logger.warn(
      {
        userId: userSession.userId,
        correlationId,
        bodyKeys: Object.keys(req.body || {}),
        hasLocation: !!req.body?.location,
        hasCoords: !!req.body?.coords,
      },
      "Location poll-response API received invalid payload - missing location object",
    );
    return res.status(400).json({
      success: false,
      message: "location object required. Expected { location: {...} } or Expo LocationObject with coords",
    });
  }

  if (!correlationId) {
    return res.status(400).json({
      success: false,
      message: "correlationId parameter required",
    });
  }

  try {
    // Add correlationId to location payload
    const locationWithCorrelation = {
      ...location,
      correlationId,
    };

    await userSession.locationManager.updateFromAPI({
      location: locationWithCorrelation,
    });

    return res.json({
      success: true,
      resolved: true, // Indicates this was a poll response
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    _req.logger.error(error, `Error updating location poll response for user ${userSession.userId}:`);

    return res.status(500).json({
      success: false,
      message: "Failed to update location poll response",
      timestamp: new Date().toISOString(),
    });
  }
}

export default router;
