/**
 * @fileoverview Hono apps routes.
 * App management endpoints for listing, installing, starting, stopping apps.
 * Mounted at: /api/apps and /apps
 */

import { Hono } from "hono";
import jwt from "jsonwebtoken";
import { AppType } from "@mentra/sdk";
import { User } from "../../../models/user.model";
import appService from "../../../services/core/app.service";
import * as AppUptimeService from "../../../services/core/app-uptime.service";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import { HardwareCompatibilityService } from "../../../services/session/HardwareCompatibilityService";
import UserSession from "../../../services/session/UserSession";
import { CLIENT_VERSIONS } from "../../../version";
import { validateApiKey } from "../../../services/sdk/sdk.auth.service";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "apps.routes" });

const app = new Hono<AppEnv>();

// Environment variables
const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";
const CLOUD_VERSION = CLIENT_VERSIONS.required;

// Allowed package names for API key authentication
const ALLOWED_API_KEY_PACKAGES = [
  "test.augmentos.mira",
  "cloud.augmentos.mira",
  "com.augmentos.mira",
  "com.mentra.mentraai.beta",
];

// ============================================================================
// Routes
// ============================================================================

// Main routes with unified auth
app.get("/", unifiedAuthMiddleware, getAllApps);
app.get("/public", getPublicApps);
app.get("/search", searchApps);
app.get("/installed", authWithOptionalSession, getInstalledApps);
app.get("/available", authWithOptionalSession, getAvailableApps);
app.get("/version", getVersion);
app.get("/:packageName", getAppByPackage);
app.post("/:packageName/start", authWithOptionalSession, startApp);
app.post("/:packageName/stop", authWithOptionalSession, stopApp);
app.post("/install/:packageName", authWithOptionalSession, installApp);
app.post("/uninstall/:packageName", authWithOptionalSession, uninstallApp);

// ============================================================================
// Middleware
// ============================================================================

/**
 * Unified auth middleware - supports API key auth or JWT token auth.
 */
async function unifiedAuthMiddleware(c: AppContext, next: () => Promise<void>) {
  const apiKey = c.req.query("apiKey");
  const packageName = c.req.query("packageName");
  const userId = c.req.query("userId");

  // Option 1: API key authentication
  if (apiKey && packageName && userId) {
    if (!ALLOWED_API_KEY_PACKAGES.includes(packageName)) {
      return c.json({ success: false, message: "Package not authorized for API key authentication" }, 403);
    }

    const isValid = await validateApiKey(packageName, apiKey);
    if (!isValid) {
      return c.json({ success: false, message: "Invalid API key" }, 401);
    }

    const userSession = UserSession.getById(userId);
    if (!userSession) {
      return c.json({ success: false, message: "No active session found for user." }, 401);
    }

    c.set("email", userId);
    c.set("userSession", userSession);
    await next();
    return;
  }

  // Option 2: JWT token authentication
  const authHeader = c.req.header("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);

    try {
      const decoded = jwt.verify(token, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;
      if (!decoded || !decoded.email) {
        return c.json({ success: false, message: "Invalid token data" }, 401);
      }

      const email = decoded.email.toLowerCase();
      c.set("email", email);

      // Try to get user session
      const userSession = UserSession.getById(email);
      if (userSession) {
        c.set("userSession", userSession);
      }

      // Try to get user
      const user = await User.findOrCreateUser(email);
      if (user) {
        c.set("user", user);
      }

      await next();
      return;
    } catch (error) {
      logger.debug({ error }, "JWT verification failed");
      return c.json({ success: false, message: "Invalid or expired token" }, 401);
    }
  }

  return c.json({ success: false, message: "Authentication required" }, 401);
}

/**
 * Auth middleware with optional session - for routes that work with or without active session.
 */
async function authWithOptionalSession(c: AppContext, next: () => Promise<void>) {
  const authHeader = c.req.header("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Authorization header missing or invalid" }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;
    if (!decoded || !decoded.email) {
      return c.json({ error: "Invalid token data" }, 401);
    }

    const email = decoded.email.toLowerCase();
    c.set("email", email);

    // Try to get user
    const user = await User.findOrCreateUser(email);
    if (user) {
      c.set("user", user);
    }

    // Try to get user session (optional)
    const userSession = UserSession.getById(email);
    if (userSession) {
      c.set("userSession", userSession);
    }

    await next();
  } catch (error) {
    logger.debug({ error }, "JWT verification failed");
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /apps
 * Get all available apps.
 */
async function getAllApps(c: AppContext) {
  try {
    const email = c.get("email");
    const userSession = c.get("userSession");

    if (!email) {
      return c.json({ success: false, message: "Authentication required" }, 401);
    }

    const apps = await appService.getAllApps(email);

    // Add compatibility info if session exists
    const caps = userSession?.deviceManager?.getCapabilities();
    const appsWithExtras = apps.map((app: any) => {
      const plainApp = app.toObject ? app.toObject() : app;
      let compatibilityInfo = {};

      if (caps) {
        const result = HardwareCompatibilityService.checkCompatibility(app, caps);
        compatibilityInfo = {
          isCompatible: result.isCompatible,
          missingRequired: result.missingRequired.map((h: any) => ({ type: h.type, description: h.description })),
          missingOptional: result.missingOptional.map((h: any) => ({ type: h.type, description: h.description })),
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
      const packageNames = appsWithExtras.map((a: any) => a.packageName);
      const latestStatuses = await AppUptimeService.getLatestStatusesForPackages(packageNames);
      const statusMap = new Map<string, boolean>(latestStatuses.map((s) => [s.packageName, Boolean(s.onlineStatus)]));

      for (const app of appsWithExtras) {
        (app as any).isOnline = statusMap.get(app.packageName) ?? null;
      }
    } catch (e) {
      logger.warn({ e }, "Failed to attach latest online statuses");
    }

    return c.json({ success: true, data: appsWithExtras });
  } catch (error) {
    logger.error(error, "Error getting all apps");
    return c.json({ success: false, message: "Error fetching apps" }, 500);
  }
}

/**
 * GET /apps/public
 * Get public apps (no auth required).
 */
async function getPublicApps(c: AppContext) {
  try {
    const apps = await appService.getAllApps();

    // Filter for only published AppType.STANDARD apps that are public
    const publicApps = apps.filter((app: any) => {
      return app.appType === AppType.STANDARD && app.isPublished && app.isPublic;
    });

    return c.json({ success: true, data: publicApps });
  } catch (error) {
    logger.error(error, "Error fetching public apps");
    return c.json({ success: false, message: "Error fetching public apps" }, 500);
  }
}

/**
 * GET /apps/search
 * Search apps by query.
 */
async function searchApps(c: AppContext) {
  try {
    const query = c.req.query("query") || "";
    const organizationId = c.req.query("organizationId");

    if (!query.trim()) {
      return c.json({ success: false, message: "Search query is required" }, 400);
    }

    // Get all apps and filter by query
    const apps = await appService.getAllApps();
    const lowerQuery = query.toLowerCase();

    const searchResults = apps.filter((app: any) => {
      // Filter by organization if specified
      if (organizationId && app.organizationId?.toString() !== organizationId) {
        return false;
      }

      // Search in name, description, packageName
      const name = (app.name || "").toLowerCase();
      const description = (app.description || "").toLowerCase();
      const packageName = (app.packageName || "").toLowerCase();

      return name.includes(lowerQuery) || description.includes(lowerQuery) || packageName.includes(lowerQuery);
    });

    return c.json({ success: true, data: searchResults });
  } catch (error) {
    logger.error(error, "Error searching apps");
    return c.json({ success: false, message: "Error searching apps" }, 500);
  }
}

/**
 * GET /apps/:packageName
 * Get app details by package name.
 */
async function getAppByPackage(c: AppContext) {
  try {
    const packageName = c.req.param("packageName");
    const app = await appService.getApp(packageName);

    if (!app) {
      return c.json({ success: false, message: "App not found" }, 404);
    }

    const plainApp = app.toObject ? app.toObject() : app;

    // Get online status
    try {
      const latestStatuses = await AppUptimeService.getLatestStatusesForPackages([packageName]);
      const isOnline = latestStatuses[0]?.onlineStatus ?? null;
      (plainApp as any).isOnline = isOnline;
    } catch (e) {
      logger.debug({ e }, "Failed to get online status");
    }

    return c.json({
      success: true,
      data: plainApp,
    });
  } catch (error) {
    logger.error(error, "Error getting app by package");
    return c.json({ success: false, message: "Error fetching app" }, 500);
  }
}

/**
 * POST /apps/:packageName/start
 * Start an app.
 */
async function startApp(c: AppContext) {
  const packageName = c.req.param("packageName");
  const userSession = c.get("userSession");
  const email = c.get("email");

  if (!userSession) {
    return c.json({ success: false, message: "No active session found" }, 401);
  }

  try {
    const app = await appService.getApp(packageName);
    if (!app) {
      return c.json({ success: false, message: "App not found" }, 404);
    }

    const result = await userSession.appManager.startApp(packageName);

    // Broadcast state change
    try {
      userSession.appManager.broadcastAppState();
    } catch (e) {
      logger.warn({ e }, "Failed to broadcast app state");
    }

    logger.info({ email, packageName, result }, "App started");

    return c.json({
      success: true,
      data: {
        status: "started",
        isRunning: userSession.appManager.isAppRunning(packageName),
      },
    });
  } catch (error) {
    logger.error({ error, email, packageName }, "Error starting app");
    return c.json({ success: false, message: "Error starting app" }, 500);
  }
}

/**
 * POST /apps/:packageName/stop
 * Stop an app.
 */
async function stopApp(c: AppContext) {
  const packageName = c.req.param("packageName");
  const userSession = c.get("userSession");
  const email = c.get("email");

  if (!userSession) {
    return c.json({ success: false, message: "No active session found" }, 401);
  }

  try {
    const app = await appService.getApp(packageName);
    if (!app) {
      return c.json({ success: false, message: "App not found" }, 404);
    }

    await userSession.appManager.stopApp(packageName);

    // Broadcast state change
    try {
      userSession.appManager.broadcastAppState();
    } catch (e) {
      logger.warn({ e }, "Failed to broadcast app state");
    }

    logger.info({ email, packageName }, "App stopped");

    return c.json({
      success: true,
      data: {
        status: "stopped",
        isRunning: userSession.appManager.isAppRunning(packageName),
      },
    });
  } catch (error) {
    logger.error({ error, email, packageName }, "Error stopping app");
    return c.json({ success: false, message: "Error stopping app" }, 500);
  }
}

/**
 * POST /apps/:packageName/install
 * Install an app for the user.
 */
async function installApp(c: AppContext) {
  const packageName = c.req.param("packageName");
  const userSession = c.get("userSession");
  const user = c.get("user");
  const email = c.get("email");

  if (!email || !packageName) {
    return c.json({ success: false, message: "User session and package name are required" }, 400);
  }

  if (!user) {
    return c.json({ success: false, message: "User not found" }, 404);
  }

  try {
    const app = await appService.getApp(packageName);
    if (!app) {
      return c.json({ success: false, message: "App not found" }, 404);
    }

    // Check if app is already installed
    if (user.installedApps?.some((a: { packageName: string }) => a.packageName === packageName)) {
      return c.json({ success: false, message: "App is already installed" }, 400);
    }

    // Add to installed apps
    await user.installApp(packageName);

    // Broadcast state change if session exists
    if (userSession) {
      try {
        userSession.appManager.broadcastAppState();
      } catch (e) {
        logger.warn({ e }, "Failed to broadcast app state");
      }
    }

    return c.json({ success: true, message: `App ${packageName} installed successfully` });
  } catch (error) {
    logger.error({ error, email, packageName }, "Error installing app");
    return c.json({ success: false, message: "Error installing app" }, 500);
  }
}

/**
 * POST /apps/:packageName/uninstall
 * Uninstall an app for the user.
 */
async function uninstallApp(c: AppContext) {
  const packageName = c.req.param("packageName");
  const userSession = c.get("userSession");
  const user = c.get("user");
  const email = c.get("email");

  if (!email || !packageName) {
    return c.json({ success: false, message: "User session and package name are required" }, 400);
  }

  if (!user) {
    return c.json({ success: false, message: "User not found" }, 404);
  }

  try {
    if (!user.installedApps) {
      return c.json({ success: false, message: "App is not installed" }, 400);
    }

    user.installedApps = user.installedApps.filter((a: { packageName: string }) => a.packageName !== packageName);
    await user.save();

    // Stop the app if running
    if (userSession) {
      try {
        await userSession.appManager.stopApp(packageName);
        userSession.appManager.broadcastAppState();
      } catch (e) {
        logger.warn(e, "Error stopping app during uninstall");
      }
    }

    return c.json({ success: true, message: `App ${packageName} uninstalled successfully` });
  } catch (error) {
    logger.error({ error, email, packageName }, "Error uninstalling app");
    return c.json({ success: false, message: "Error uninstalling app" }, 500);
  }
}

/**
 * GET /apps/installed
 * Get installed apps for the user.
 */
async function getInstalledApps(c: AppContext) {
  const user = c.get("user");
  const userSession = c.get("userSession");

  if (!user) {
    return c.json({ success: false, message: "User not found" }, 404);
  }

  try {
    const installedApps = await Promise.all(
      (user.installedApps || []).map(async (installed: { packageName: string; installedDate: Date }) => {
        const appDetails = await appService.getApp(installed.packageName);
        if (!appDetails) return null;

        const plainApp = appDetails.toObject ? appDetails.toObject() : appDetails;
        let compatibilityInfo = {};
        const caps = userSession?.deviceManager?.getCapabilities();

        if (caps) {
          const result = HardwareCompatibilityService.checkCompatibility(appDetails, caps);
          compatibilityInfo = {
            isCompatible: result.isCompatible,
            missingRequired: result.missingRequired.map((h: any) => ({ type: h.type, description: h.description })),
            missingOptional: result.missingOptional.map((h: any) => ({ type: h.type, description: h.description })),
          };
        }

        return {
          ...plainApp,
          installedDate: installed.installedDate,
          compatibility: compatibilityInfo,
        };
      }),
    );

    const validApps = installedApps.filter(Boolean);

    return c.json({ success: true, data: validApps });
  } catch (error) {
    logger.error(error, "Error getting installed apps");
    return c.json({ success: false, message: "Error fetching installed apps" }, 500);
  }
}

/**
 * GET /apps/available
 * Get available apps for the user.
 */
async function getAvailableApps(c: AppContext) {
  const user = c.get("user");
  const userSession = c.get("userSession");
  const organizationId = c.req.query("organizationId");

  try {
    let apps = await appService.getAllApps(user?.email);

    if (organizationId) {
      apps = apps.filter((app: any) => app.organizationId?.toString() === organizationId);
    }

    const caps = userSession?.deviceManager?.getCapabilities();
    const installedSet = new Set(user?.installedApps?.map((a: { packageName: string }) => a.packageName) || []);

    const enhancedApps = apps.map((app: any) => {
      const plainApp = app.toObject ? app.toObject() : app;
      let compatibilityInfo = {};

      if (caps) {
        const result = HardwareCompatibilityService.checkCompatibility(app, caps);
        compatibilityInfo = {
          isCompatible: result.isCompatible,
          missingRequired: result.missingRequired.map((h: any) => ({ type: h.type, description: h.description })),
          missingOptional: result.missingOptional.map((h: any) => ({ type: h.type, description: h.description })),
        };
      }

      return {
        ...plainApp,
        isInstalled: installedSet.has(app.packageName),
        compatibility: compatibilityInfo,
      };
    });

    // Get online statuses
    try {
      const packageNames = enhancedApps.map((a: any) => a.packageName);
      const latestStatuses = await AppUptimeService.getLatestStatusesForPackages(packageNames);
      const statusMap = new Map<string, boolean>(latestStatuses.map((s) => [s.packageName, Boolean(s.onlineStatus)]));

      for (const app of enhancedApps) {
        (app as any).isOnline = statusMap.get(app.packageName) ?? null;
      }
    } catch (e) {
      logger.warn({ e }, "Failed to attach online statuses");
    }

    return c.json({ success: true, data: enhancedApps });
  } catch (error) {
    logger.error(error, "Error getting available apps");
    return c.json({ success: false, message: "Error fetching available apps" }, 500);
  }
}

/**
 * GET /apps/version
 * Get current cloud version.
 */
async function getVersion(c: AppContext) {
  return c.json({ version: CLOUD_VERSION });
}

export default app;
