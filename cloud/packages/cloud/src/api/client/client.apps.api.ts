/**
 * Client Apps API
 *
 * /api/client/apps
 *
 * Minimal app list endpoint for mobile home screen display.
 * Fast, focused, no bloat - <100ms response time target.
 *
 * Uses @mentra/types for client-facing interfaces.
 */

import { Router, Request, Response } from "express";
import { ClientAppsService } from "../../services/client/apps.service";
import {
  clientAuthWithEmail,
  RequestWithEmail,
} from "../middleware/client.middleware";
import { logger } from "../../services/logging/pino-logger";

const router = Router();

// ============================================================================
// Routes
// ============================================================================

// GET /api/client/apps - Get apps for home screen
router.get("/", clientAuthWithEmail, getApps);

// ============================================================================
// Handlers
// ============================================================================

/**
 * Get apps for home screen
 *
 * Returns minimal app list optimized for client display:
 * - packageName, name, webviewUrl, logoUrl
 * - type, permissions, hardwareRequirements
 * - running (session state), healthy (cached status)
 *
 * Performance: <100ms response time, ~2KB for 10 apps
 */
async function getApps(req: Request, res: Response) {
  const { email } = req as RequestWithEmail;
  const startTime = Date.now();

  try {
    const apps = await ClientAppsService.getAppsForHomeScreen(email);

    const duration = Date.now() - startTime;

    logger.debug(
      { email, count: apps.length, duration },
      "Apps fetched for home screen",
    );

    res.json({
      success: true,
      data: apps,
      timestamp: new Date(),
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error(
      { error, email, duration },
      "Failed to fetch apps for home screen",
    );

    res.status(500).json({
      success: false,
      message: "Failed to fetch apps",
      timestamp: new Date(),
    });
  }
}

export default router;
