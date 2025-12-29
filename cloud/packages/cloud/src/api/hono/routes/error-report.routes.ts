/**
 * @fileoverview Hono error-report routes.
 * App error tracking and reporting endpoints.
 * Mounted at: /api/error-report and /app/error-report
 */

import { Hono } from "hono";
import jwt from "jsonwebtoken";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import { PosthogService } from "../../../services/logging/posthog.service";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "error-report.routes" });

const app = new Hono<AppEnv>();

const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

// ============================================================================
// Routes
// ============================================================================

app.post("/app/error-report", errorReport);
app.post("/api/error-report", errorReport);

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /app/error-report or /api/error-report
 * Submit an error report from an app.
 * Accepts optional authentication to associate with user.
 */
async function errorReport(c: AppContext) {
  let userId = "anonymous";

  try {
    // Try to extract userId from various auth methods
    const authHeader = c.req.header("authorization");

    if (authHeader) {
      const token = authHeader.split(" ")[1];
      if (token) {
        try {
          const userData = jwt.verify(token, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;
          userId = userData.email || "anonymous";
        } catch (e) {
          // Token verification failed, continue with anonymous
          logger.debug("Failed to verify auth token for error report");
        }
      }
    }

    // Also check for coreToken in body or headers
    const reportData = await c.req.json().catch(() => ({}));

    if (!userId || userId === "anonymous") {
      const coreToken = reportData?.coreToken || c.req.header("x-core-token") || c.req.header("core-token");

      if (coreToken) {
        try {
          const userData = jwt.verify(coreToken, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;
          userId = userData.email || "anonymous";
        } catch (e) {
          // Token verification failed, continue with anonymous
          logger.debug("Failed to verify coreToken for error report");
        }
      }
    }

    logger.info({ userId, reportData }, "Sending error report");

    // Track the error in PostHog
    PosthogService.trackEvent("error_report", userId, reportData);

    return c.json({ success: true });
  } catch (error) {
    logger.error(error, "Error sending error report");
    return c.json(
      {
        success: false,
        message: "Error sending error report",
      },
      500,
    );
  }
}

export default app;
