/**
 * @fileoverview Hono public permissions API routes.
 * Public permissions API - allows SDK to check app permissions without authentication.
 * This endpoint is used by the SDK permission validation utilities to verify required permissions.
 * Mounted at: /api/public/permissions
 */

import { Hono } from "hono";
import App from "../../../models/app.model";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "public-permissions.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.get("/:packageName", getAppPermissions);

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/public/permissions/:packageName
 * Get app permissions by package name - no authentication required.
 *
 * Response:
 * {
 *   success: boolean,
 *   packageName: string,
 *   permissions: string[]
 * }
 */
async function getAppPermissions(c: AppContext) {
  try {
    const packageName = c.req.param("packageName");

    if (!packageName) {
      return c.json({ error: "Missing packageName parameter" }, 400);
    }

    // Query database for app by package name
    const appDoc = await App.findOne({ packageName });

    // Return 404 if app doesn't exist
    if (!appDoc) {
      return c.json({ error: "App not found" }, 404);
    }

    // Return app permissions list
    return c.json({
      success: true,
      packageName,
      permissions: appDoc.permissions || [],
    });
  } catch (error) {
    logger.error(error, "GET /api/public/permissions/:packageName error");
    return c.json({ error: "Internal server error" }, 500);
  }
}

export default app;
