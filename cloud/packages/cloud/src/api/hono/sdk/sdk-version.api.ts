/**
 * @fileoverview Hono SDK version API routes.
 * Returns required SDK version (from server) and latest SDK version (from npm).
 * Mounted at: /api/sdk/version
 */

import { Hono } from "hono";
import { SDK_VERSIONS } from "../../../version";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "sdk-version.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.get("/", getVersionHandler);

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/sdk/version
 * Returns required SDK version (from server) and latest SDK version (from npm).
 *
 * Response:
 * {
 *   success: boolean,
 *   data: { required: string, latest: string },
 *   timestamp: string
 * }
 */
async function getVersionHandler(c: AppContext) {
  try {
    const response = await fetch("https://registry.npmjs.org/@mentra/sdk/latest");
    const npmSdkRes = (await response.json()) as { version: string };

    return c.json({
      success: true,
      data: {
        required: SDK_VERSIONS.required,
        latest: npmSdkRes.version,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(error, "Failed to fetch SDK latest version from npm");
    return c.json({ error: "Failed to fetch SDK version" }, 500);
  }
}

export default app;
