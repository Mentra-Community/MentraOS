/**
 * @fileoverview Hono store user API routes.
 * User endpoints for the MentraOS Store website.
 * Mounted at: /api/store/user
 */

import { Hono } from "hono";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";
import { User } from "../../../models/user.model";
import { clientAuth, requireUser } from "../middleware/client.middleware";

const logger = rootLogger.child({ service: "store.user.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.get("/me", clientAuth, requireUser, getCurrentUser);

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/store/user/me
 * Get current authenticated user information.
 * Requires authentication.
 */
async function getCurrentUser(c: AppContext) {
  try {
    const email = c.get("email");

    if (!email) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const user = await User.findOrCreateUser(email);

    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    // Return user data (excluding sensitive fields)
    const userData = {
      email: user.email,
      organizations: user.organizations || [],
      defaultOrg: user.defaultOrg || null,
      installedApps:
        user.installedApps?.map((app) => ({
          packageName: app.packageName,
          installedDate: app.installedDate,
        })) || [],
    };

    return c.json({ success: true, data: userData });
  } catch (e: unknown) {
    const error = e as Error;
    logger.error(error, "Failed to get current user");
    return c.json(
      {
        error: error?.message || "Failed to get user information",
      },
      500,
    );
  }
}

export default app;
