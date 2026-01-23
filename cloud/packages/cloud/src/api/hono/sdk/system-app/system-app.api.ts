/**
 * @fileoverview Hono system-app API.
 * App management endpoints for listing, starting, and stopping apps.
 * Mounted at: /api/sdk/system-app
 *
 * Authentication: API key via query params (for whitelisted packages)
 * - apiKey: The app's API key
 * - packageName: The calling app's package name
 * - userId: The user's email/ID
 *
 * Only whitelisted packages (MentraAI, Mira) can use these endpoints.
 */

import { Hono } from "hono";
import axios from "axios";
import { ToolCall, ToolSchema } from "@mentra/sdk";
import { logger as rootLogger } from "../../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../../types/hono";
import { User } from "../../../../models/user.model";
import App, { AppI } from "../../../../models/app.model";
import UserSession from "../../../../services/session/UserSession";
import { validateApiKey } from "../../../../services/sdk/sdk.auth.service";
import * as AppUptimeService from "../../../../services/core/app-uptime.service";
import { HardwareCompatibilityService } from "../../../../services/session/HardwareCompatibilityService";
import { LOCAL_APPS } from "../../../../services/core/app.service";

const logger = rootLogger.child({ service: "system-app.api" });

const app = new Hono<AppEnv>();

// Packages allowed to use API key authentication for app management
const ALLOWED_API_KEY_PACKAGES = [
  "test.augmentos.mira",
  "cloud.augmentos.mira",
  "com.augmentos.mira",
  "com.mentra.mentraai.beta",
  "com.mentra.mentraai.dev",
  "com.mentra.ai.noporter",
  "com.mentra.ai.dev",
  "com.mentra.ai",
];

// ============================================================================
// Routes
// ============================================================================

// App management
app.get("/apps", apiKeyAuth, listApps);
app.post("/:packageName/start", apiKeyAuth, startApp);
app.post("/:packageName/stop", apiKeyAuth, stopApp);

// Tools
app.get("/tools", apiKeyAuth, getUserTools);
app.get("/apps/:targetPackageName/tools", apiKeyAuth, getAppTools);
app.post("/apps/:targetPackageName/tool", apiKeyAuth, triggerTool);
app.post("/invoke-tool", apiKeyAuth, invokeTool);

// ============================================================================
// Middleware
// ============================================================================

/**
 * API key authentication middleware.
 * Requires apiKey, packageName, and userId query parameters.
 * Only allows whitelisted packages.
 */
async function apiKeyAuth(c: AppContext, next: () => Promise<void>) {
  const apiKey = c.req.query("apiKey");
  const packageName = c.req.query("packageName");
  const userId = c.req.query("userId");

  if (!apiKey || !packageName || !userId) {
    return c.json(
      {
        success: false,
        error: "Missing required query parameters: apiKey, packageName, userId",
      },
      400,
    );
  }

  // Check if package is in the whitelist
  if (!ALLOWED_API_KEY_PACKAGES.includes(packageName)) {
    logger.warn({ packageName }, "Package not authorized for API key authentication");
    return c.json(
      {
        success: false,
        error: "Package not authorized for API key authentication",
      },
      403,
    );
  }

  // Validate API key
  const isValid = await validateApiKey(packageName, apiKey);
  if (!isValid) {
    return c.json({ success: false, error: "Invalid API key" }, 401);
  }

  // Get user session
  const userSession = UserSession.getById(userId);
  if (!userSession) {
    return c.json(
      {
        success: false,
        error: "No active session found for user",
      },
      401,
    );
  }

  // Set context
  c.set("email", userId);
  c.set("userSession", userSession);

  await next();
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/sdk/system-app/apps
 * List all available apps with running status and tools info.
 * Requires active user session.
 */
async function listApps(c: AppContext) {
  try {
    const userId = c.req.query("userId");
    const userSession = c.get("userSession");

    if (!userId) {
      return c.json({ success: false, error: "Missing userId" }, 400);
    }

    // Get user's installed apps
    const user = await User.findOne({ email: userId });
    const installedPackageNames =
      user?.installedApps?.map((installed: { packageName: string }) => installed.packageName) || [];

    // Fetch apps from database
    const installedApps = (await App.find({
      packageName: { $in: installedPackageNames },
    })) as AppI[];

    // Combine with LOCAL_APPS (pre-installed system apps), avoiding duplicates
    const appMap = new Map<string, AppI>();
    for (const localApp of LOCAL_APPS) {
      appMap.set(localApp.packageName, localApp);
    }
    for (const installedApp of installedApps) {
      if (!appMap.has(installedApp.packageName)) {
        appMap.set(installedApp.packageName, installedApp);
      }
    }

    const apps = Array.from(appMap.values());

    // Add compatibility info and running state
    const caps = userSession?.deviceManager?.getCapabilities();
    const appsWithExtras = apps.map((appDoc) => {
      const plainApp = appDoc.toObject ? appDoc.toObject() : appDoc;
      let compatibilityInfo = {};

      if (caps) {
        const result = HardwareCompatibilityService.checkCompatibility(appDoc, caps);
        compatibilityInfo = {
          isCompatible: result.isCompatible,
          missingRequired: result.missingRequired.map((h) => ({
            type: h.type,
            description: h.description || "",
          })),
          missingOptional: result.missingOptional.map((h) => ({
            type: h.type,
            description: h.description || "",
          })),
        };
      }

      // Add running state if session exists
      let sessionState = {};
      if (userSession) {
        sessionState = {
          is_running: userSession.appManager.isAppRunning(plainApp.packageName),
        };
      }

      return { ...plainApp, compatibility: compatibilityInfo, ...sessionState };
    });

    // Attach latest online status for each app
    try {
      const packageNames = appsWithExtras.map((a: any) => a.packageName as string);
      const latestStatuses = await AppUptimeService.getLatestStatusesForPackages(packageNames);
      const statusMap = new Map<string, boolean>(latestStatuses.map((s) => [s.packageName, Boolean(s.onlineStatus)]));

      for (const appData of appsWithExtras) {
        (appData as any).isOnline = statusMap.get((appData as any).packageName) ?? null;
      }
    } catch (e) {
      logger.warn({ e }, "Failed to attach latest online statuses");
    }

    logger.info({ userId, appCount: appsWithExtras.length }, "Listed apps via system-app API");

    return c.json({ success: true, data: appsWithExtras });
  } catch (e: unknown) {
    const error = e as Error;
    logger.error(error, "Failed to list apps");
    return c.json(
      {
        success: false,
        error: error?.message || "Failed to list apps",
      },
      500,
    );
  }
}

/**
 * POST /api/sdk/system-app/:packageName/start
 * Start an app for the authenticated user.
 * Requires active user session.
 */
async function startApp(c: AppContext) {
  try {
    const targetPackage = c.req.param("packageName");
    const callerPackage = c.req.query("packageName");
    const userId = c.req.query("userId");
    const userSession = c.get("userSession");

    if (!targetPackage) {
      return c.json({ success: false, error: "Missing target packageName" }, 400);
    }

    if (!userSession) {
      return c.json(
        {
          success: false,
          error: "No active session found. Please connect your device first.",
        },
        401,
      );
    }

    logger.info({ callerPackage, userId, targetPackage }, "Starting app via system-app API");

    // Check if app is installed
    const user = await User.findOrCreateUser(userId!);
    if (!user.isAppInstalled(targetPackage)) {
      return c.json({ success: false, error: "App is not installed" }, 404);
    }

    // Start the app
    const result = await userSession.appManager.startApp(targetPackage);

    if (!result.success) {
      return c.json(
        {
          success: false,
          error: "Failed to start app",
          details: result.error,
        },
        500,
      );
    }

    logger.info({ callerPackage, userId, targetPackage }, "App started successfully");

    return c.json({ success: true, message: "App started successfully" });
  } catch (e: unknown) {
    const error = e as Error;
    logger.error(error, "Failed to start app");
    return c.json(
      {
        success: false,
        error: error?.message || "Failed to start app",
      },
      500,
    );
  }
}

/**
 * POST /api/sdk/system-app/:packageName/stop
 * Stop a running app for the authenticated user.
 * Requires active user session.
 */
async function stopApp(c: AppContext) {
  try {
    const targetPackage = c.req.param("packageName");
    const callerPackage = c.req.query("packageName");
    const userId = c.req.query("userId");
    const userSession = c.get("userSession");

    if (!targetPackage) {
      return c.json({ success: false, error: "Missing target packageName" }, 400);
    }

    if (!userSession) {
      return c.json(
        {
          success: false,
          error: "No active session found",
        },
        401,
      );
    }

    logger.info({ callerPackage, userId, targetPackage }, "Stopping app via system-app API");

    // Check if app is running
    const isRunning = userSession.appManager.isAppRunning(targetPackage);
    if (!isRunning) {
      return c.json({ success: true, message: "App is not running" });
    }

    // Stop the app
    await userSession.appManager.stopApp(targetPackage);

    logger.info({ callerPackage, userId, targetPackage }, "App stopped successfully");

    return c.json({ success: true, message: "App stopped successfully" });
  } catch (e: unknown) {
    const error = e as Error;
    logger.error(error, "Failed to stop app");
    return c.json(
      {
        success: false,
        error: error?.message || "Failed to stop app",
      },
      500,
    );
  }
}

// ============================================================================
// Tool Handlers
// ============================================================================

/**
 * GET /api/sdk/system-app/tools
 * Get all tools for the user's installed apps.
 */
async function getUserTools(c: AppContext) {
  try {
    const userId = c.req.query("userId");

    if (!userId) {
      return c.json({ success: false, error: "Missing userId" }, 400);
    }

    // Get user's installed apps
    const user = await User.findOne({ email: userId });
    const installedPackageNames =
      user?.installedApps?.map((installed: { packageName: string }) => installed.packageName) || [];

    if (installedPackageNames.length === 0) {
      return c.json({ success: true, data: [] });
    }

    // Fetch apps with tools from database
    const apps = await App.find({
      packageName: { $in: installedPackageNames },
      tools: { $exists: true, $ne: [] },
    });

    // Collect all tools with app info
    const allTools: Array<ToolSchema & { appPackageName: string }> = [];
    for (const appDoc of apps) {
      if (appDoc.tools && Array.isArray(appDoc.tools)) {
        for (const tool of appDoc.tools) {
          allTools.push({
            ...tool,
            appPackageName: appDoc.packageName,
          });
        }
      }
    }

    logger.info({ userId, toolCount: allTools.length }, "Fetched user tools via system-app API");

    return c.json({ success: true, data: allTools });
  } catch (e: unknown) {
    const error = e as Error;
    logger.error(error, "Failed to get user tools");
    return c.json(
      {
        success: false,
        error: error?.message || "Failed to get user tools",
      },
      500,
    );
  }
}

/**
 * GET /api/sdk/system-app/apps/:targetPackageName/tools
 * Get tools for a specific app.
 */
async function getAppTools(c: AppContext) {
  try {
    const targetPackageName = c.req.param("targetPackageName");

    if (!targetPackageName) {
      return c.json({ success: false, error: "Missing targetPackageName" }, 400);
    }

    // Fetch app from database
    const appDoc = await App.findOne({ packageName: targetPackageName });

    if (!appDoc) {
      return c.json({ success: false, error: "App not found" }, 404);
    }

    const tools = appDoc.tools || [];

    logger.info({ targetPackageName, toolCount: tools.length }, "Fetched app tools via system-app API");

    return c.json({ success: true, data: tools });
  } catch (e: unknown) {
    const error = e as Error;
    logger.error(error, "Failed to get app tools");
    return c.json(
      {
        success: false,
        error: error?.message || "Failed to get app tools",
      },
      500,
    );
  }
}

/**
 * POST /api/sdk/system-app/apps/:targetPackageName/tool
 * Trigger a tool webhook on an app.
 */
async function triggerTool(c: AppContext) {
  try {
    const targetPackageName = c.req.param("targetPackageName");
    const payload = (await c.req.json().catch(() => ({}))) as ToolCall;

    if (!targetPackageName) {
      return c.json({ success: false, error: "Missing targetPackageName" }, 400);
    }

    if (!payload.toolId) {
      return c.json({ success: false, error: "Missing required field: toolId" }, 400);
    }

    if (!payload.userId) {
      return c.json({ success: false, error: "Missing required field: userId" }, 400);
    }

    // Get app from database
    const appDoc = await App.findOne({ packageName: targetPackageName });

    if (!appDoc) {
      return c.json({ success: false, error: "App not found" }, 404);
    }

    if (!appDoc.publicUrl) {
      return c.json({ success: false, error: "App does not have a public URL" }, 400);
    }

    logger.info({ targetPackageName, toolId: payload.toolId, userId: payload.userId }, "Triggering tool webhook");

    // Call the app's /tool endpoint
    const webhookUrl = `${appDoc.publicUrl}/tool`;

    const response = await axios.post(webhookUrl, payload, {
      headers: {
        "Content-Type": "application/json",
        "X-App-API-Key": appDoc.hashedApiKey,
      },
      timeout: 20000,
    });

    logger.info({ targetPackageName, toolId: payload.toolId }, "Tool webhook triggered successfully");

    return c.json({ success: true, data: response.data });
  } catch (e: unknown) {
    const error = e as Error;
    logger.error(error, "Failed to trigger tool");

    if (axios.isAxiosError(e)) {
      return c.json(
        {
          success: false,
          error: e.response?.data?.message || e.message || "Tool webhook failed",
        },
        500,
      );
    }

    return c.json(
      {
        success: false,
        error: error?.message || "Failed to trigger tool",
      },
      500,
    );
  }
}

/**
 * POST /api/sdk/system-app/invoke-tool
 * Invoke a tool on a target app (app-to-app communication).
 *
 * Body:
 *   - targetPackageName: string (required)
 *   - toolId: string (required)
 *   - parameters: object (optional)
 */
async function invokeTool(c: AppContext) {
  try {
    const userId = c.req.query("userId");
    const userSession = c.get("userSession");
    const body = await c.req.json().catch(() => ({}));

    const {
      targetPackageName,
      toolId,
      parameters = {},
    } = body as {
      targetPackageName?: string;
      toolId?: string;
      parameters?: Record<string, unknown>;
    };

    if (!targetPackageName) {
      return c.json({ success: false, error: "targetPackageName is required" }, 400);
    }
    if (!toolId) {
      return c.json({ success: false, error: "toolId is required" }, 400);
    }
    if (!userId) {
      return c.json({ success: false, error: "userId is required" }, 400);
    }

    logger.info({ targetPackageName, toolId, userId }, "Invoke tool request received");

    // Check if target app is running
    if (!userSession) {
      return c.json({ success: false, error: "No active session found" }, 401);
    }

    const runningAppNames = userSession.appManager.getRunningAppNames();
    if (!runningAppNames.has(targetPackageName)) {
      return c.json(
        {
          success: false,
          error: `App ${targetPackageName} is not running. Start it first using /api/sdk/system-app/${targetPackageName}/start`,
        },
        400,
      );
    }

    // Get target app
    const targetAppDoc = await App.findOne({ packageName: targetPackageName });
    if (!targetAppDoc || !targetAppDoc.publicUrl) {
      return c.json(
        {
          success: false,
          error: `App ${targetPackageName} does not have a public URL configured`,
        },
        400,
      );
    }

    // Build tool call payload
    const toolCallPayload = {
      toolId,
      toolParameters: parameters,
      userId,
      timestamp: new Date().toISOString(),
    };

    const toolEndpoint = `${targetAppDoc.publicUrl}/tool`;
    logger.info({ toolEndpoint, toolCallPayload }, "Calling TPA tool endpoint");

    const response = await axios.post(toolEndpoint, toolCallPayload, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
    });

    logger.info({ targetPackageName, toolId, response: response.data }, "Tool invocation successful");

    if (response.data.status === "success") {
      return c.json({
        success: true,
        result: response.data.reply,
        message: `Tool ${toolId} executed successfully on ${targetPackageName}`,
      });
    } else {
      return c.json(
        {
          success: false,
          error: response.data.message || "Tool execution failed",
        },
        500,
      );
    }
  } catch (e: unknown) {
    const error = e as Error;
    logger.error(error, "Failed to invoke tool");

    if (axios.isAxiosError(e)) {
      return c.json(
        {
          success: false,
          error: `Tool execution failed: ${e.response?.data?.message || e.message}`,
        },
        500,
      );
    }

    return c.json(
      {
        success: false,
        error: error?.message || "Failed to invoke tool",
      },
      500,
    );
  }
}

export default app;
