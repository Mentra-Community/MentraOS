/**
 * @fileoverview Hono min-version API routes.
 * API endpoints for checking client minimum versions.
 * Mounted at: /api/client/min-version
 */

import { Hono } from "hono";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import { CLIENT_VERSIONS } from "../../../version";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "min-version.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.get("/", getClientMinVersions);

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/client/min-version
 * Get client minimum versions.
 *
 * Disable caching to prevent 304 responses that cause JSON parse errors on mobile.
 * See: cloud/issues/015-http-304-etag-caching-bug
 */
async function getClientMinVersions(c: AppContext) {
  try {
    const body = {
      success: true,
      data: CLIENT_VERSIONS,
      timestamp: new Date(),
    };

    // Return response with no-cache headers to prevent 304 responses
    return c.json(body, 200, {
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    });
  } catch (error) {
    logger.error(error, "Error getting client minimum versions");
    return c.json(
      {
        success: false,
        message: "Failed to get client minimum versions",
        timestamp: new Date(),
      },
      500,
    );
  }
}

export default app;
