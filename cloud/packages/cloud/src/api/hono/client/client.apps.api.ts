/**
 * @fileoverview Hono client apps API routes.
 * Minimal app list endpoint for mobile home screen display.
 * Fast, focused, no bloat - <100ms response time target.
 * Mounted at: /api/client/apps
 *
 * Uses @mentra/types for client-facing interfaces.
 */

import { Hono } from "hono";
import { ClientAppsService } from "../../../services/client/apps.service";
import { clientAuth, requireUserSession } from "../middleware/client.middleware";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "client.apps.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

// requireUserSession returns 503 NO_ACTIVE_SESSION if this pod doesn't hold
// the user's session. The mobile client auto-reconnects the WS and retries,
// which routes to whichever pod now owns the session. Without this guard
// the endpoint silently returned running=false for every app when called on
// the wrong pod, causing the "Cannot reach $miniapp" screen mid-session.
app.get("/", clientAuth, requireUserSession, getApps);

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/client/apps
 * Get apps for home screen.
 *
 * Returns minimal app list optimized for client display:
 * - packageName, name, webviewUrl, logoUrl
 * - type, permissions, hardwareRequirements
 * - running (session state), healthy (cached status)
 *
 * Performance: <100ms response time, ~2KB for 10 apps
 */
async function getApps(c: AppContext) {
  const email = c.get("email")!;
  const startTime = Date.now();

  try {
    const apps = await ClientAppsService.getAppsForHomeScreen(email);

    const duration = Date.now() - startTime;

    logger.debug({ email, count: apps.length, duration }, "Apps fetched for home screen");

    return c.json({
      success: true,
      data: apps,
      timestamp: new Date(),
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error({ error, email, duration }, "Failed to fetch apps for home screen");

    return c.json(
      {
        success: false,
        message: "Failed to fetch apps",
        timestamp: new Date(),
      },
      500,
    );
  }
}

export default app;
