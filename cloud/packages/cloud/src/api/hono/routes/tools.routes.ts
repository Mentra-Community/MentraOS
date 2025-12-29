/**
 * @fileoverview Hono tools routes.
 * Tool webhook endpoints for AI integrations.
 * Mounted at: /api/tools
 */

import { Hono } from "hono";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import appService from "../../../services/core/app.service";
import { User } from "../../../models/user.model";
import { ToolCall } from "@mentra/sdk";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "tools.routes" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.post("/apps/:packageName/tool", triggerTool);
app.get("/apps/:packageName/tools", getAppTools);
app.get("/users/:userId/tools", getUserTools);

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /api/tools/apps/:packageName/tool
 * Trigger a tool webhook to an App.
 * Used by Mira AI to send tools to Apps.
 */
async function triggerTool(c: AppContext) {
  try {
    const packageName = c.req.param("packageName");

    logger.debug({ packageName }, "Triggering tool for package");

    const payload = (await c.req.json().catch(() => ({}))) as ToolCall;

    logger.debug({ packageName, payload }, "Tool trigger payload");

    // Validate the payload has the required fields
    if (!payload.toolId) {
      return c.json(
        {
          error: true,
          message: "Missing required fields: toolId",
        },
        400,
      );
    }

    if (!payload.userId) {
      return c.json(
        {
          error: true,
          message: "Missing required fields: userId",
        },
        400,
      );
    }

    // Log the tool request
    logger.info({ toolId: payload.toolId, userId: payload.userId }, `Triggering tool webhook for app ${packageName}`);

    // Call the service method to trigger the webhook
    const result = await appService.triggerAppToolWebhook(packageName, payload);

    logger.debug({ result }, "Tool trigger result");

    // Return the response from the App
    return c.json(result.data, result.status as 200 | 400 | 404 | 500);
  } catch (error) {
    logger.error(error, "Error triggering tool webhook:");
    return c.json(
      {
        error: true,
        message: error instanceof Error ? error.message : "Unknown error occurred",
      },
      500,
    );
  }
}

/**
 * GET /api/tools/apps/:packageName/tools
 * Get all tools for a specific App.
 * Used by Mira AI to discover available tools.
 */
async function getAppTools(c: AppContext) {
  try {
    const packageName = c.req.param("packageName");

    if (!packageName) {
      return c.json(
        {
          error: true,
          message: "Missing required parameter: packageName",
        },
        400,
      );
    }

    // Call the service method to get the tools
    const tools = await appService.getAppTools(packageName);

    // Return the tools array
    return c.json(tools);
  } catch (error) {
    logger.error(error, "Error fetching App tools:");
    return c.json(
      {
        error: true,
        message: error instanceof Error ? error.message : "Unknown error occurred",
      },
      500,
    );
  }
}

/**
 * GET /api/tools/users/:userId/tools
 * Get all tools for a user's installed Apps.
 * Used by Mira AI to discover all available tools for a user.
 */
async function getUserTools(c: AppContext) {
  try {
    const userId = c.req.param("userId");

    if (!userId) {
      return c.json(
        {
          error: true,
          message: "Missing required parameter: userId",
        },
        400,
      );
    }

    // Find the user by userId (email)
    const user = await User.findOne({ email: userId });

    if (!user) {
      return c.json(
        {
          error: true,
          message: "User not found",
        },
        404,
      );
    }

    // Get list of installed app packageNames from user
    const installedPackageNames = user.installedApps?.map((app) => app.packageName) || [];

    if (installedPackageNames.length === 0) {
      return c.json([]);
    }

    // Collect all tools from all installed apps
    const allUserTools = [];

    for (const packageName of installedPackageNames) {
      try {
        // Get tools for this app
        const appTools = await appService.getAppTools(packageName);

        // Add app identifier to each tool
        const toolsWithAppInfo = appTools.map((tool) => ({
          ...tool,
          appPackageName: packageName,
        }));

        allUserTools.push(...toolsWithAppInfo);
      } catch (error) {
        // Log error but continue with other apps
        logger.error(error, `Error fetching tools for app ${packageName}:`);
      }
    }

    // Return the combined list of tools
    return c.json(allUserTools);
  } catch (error) {
    logger.error(error, "Error fetching user tools:");
    return c.json(
      {
        error: true,
        message: error instanceof Error ? error.message : "Unknown error occurred",
      },
      500,
    );
  }
}

export default app;
