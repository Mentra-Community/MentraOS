/**
 * @fileoverview Hono app-communication routes.
 * Multi-user app discovery and communication endpoints.
 * Mounted at: /api/app-communication
 */

import { Hono } from "hono";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import appService from "../../../services/core/app.service";
import UserSession from "../../../services/session/UserSession";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "app-communication.routes" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.post("/discover-users", discoverUsers);

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /api/app-communication/discover-users
 * Discover other users currently using the same App.
 *
 * Headers:
 *   - Authorization: Bearer <app-api-key>
 *
 * Body:
 *   - packageName: string (required)
 *   - userId: string (required)
 *   - includeUserProfiles?: boolean (optional, default: false)
 */
async function discoverUsers(c: AppContext) {
  try {
    // Parse API key from Authorization header (Bearer token)
    const authHeader = c.req.header("authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }

    const appApiKey = authHeader.replace("Bearer ", "").trim();

    // Parse request body
    const body = await c.req.json().catch(() => ({}));
    const {
      packageName,
      userId,
      includeUserProfiles = false,
    } = body as {
      packageName?: string;
      userId?: string;
      includeUserProfiles?: boolean;
    };

    // Validate required fields
    if (!packageName) {
      return c.json({ error: "packageName is required" }, 400);
    }

    if (!userId) {
      return c.json({ error: "userId is required" }, 400);
    }

    // Retrieve the app by packageName
    const appDoc = await appService.getApp(packageName);

    if (!appDoc) {
      return c.json({ error: "Invalid packageName" }, 401);
    }

    // Validate the API key
    const isValid = await appService.validateApiKey(packageName, appApiKey);

    if (!isValid) {
      return c.json({ error: "Invalid API key" }, 401);
    }

    // Find the user's active session
    const userSession = UserSession.getById(userId);

    if (!userSession) {
      return c.json({ error: "No active session found for user" }, 404);
    }

    // TODO: Implement multi-user app service for tracking users across apps
    // For now, return an empty array until the multi-user service is fixed
    const users: Array<{
      userId: string;
      sessionId: string;
      joinedAt: Date;
      userProfile?: any;
    }> = [];

    // When multi-user service is implemented, it would look something like:
    // const users = multiUserAppService.getActiveAppUsers(packageName)
    //   .filter((otherUserId: string) => otherUserId !== userId)
    //   .map((otherUserId: string) => {
    //     const otherSession = UserSession.getById(otherUserId);
    //     return {
    //       userId: otherUserId,
    //       sessionId: otherSession?.sessionId || 'unknown',
    //       joinedAt: new Date(),
    //       userProfile: includeUserProfiles ? multiUserAppService.getUserProfile(otherUserId) : undefined
    //     };
    //   });

    return c.json({
      users,
      totalUsers: users.length,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(error, "Error discovering users");
    return c.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
}

export default app;
