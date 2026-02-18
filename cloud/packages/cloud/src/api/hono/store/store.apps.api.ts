/**
 * @fileoverview Hono store apps API routes.
 * Store app management endpoints for the MentraOS Store website.
 * Mounted at: /api/store
 */

import { Hono } from "hono";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";
import { User } from "../../../models/user.model";
import UserSession from "../../../services/session/UserSession";
import { clientAuth, requireUser } from "../middleware/client.middleware";
import storeService from "../../../services/core/store.service";
import { batchEnrichAppsWithProfiles } from "../../../services/core/app-enrichment.service";

const logger = rootLogger.child({ service: "store.apps.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

// IMPORTANT: Specific routes must come before dynamic routes (/:packageName)
// Otherwise /:packageName will match everything

// Public endpoints (no auth required)
app.get("/published-apps", getPublicApps);
app.get("/search", searchApps);

// Authenticated endpoints (require user auth)
app.get("/published-apps-loggedin", clientAuth, requireUser, getPublishedAppsForUser);
app.get("/installed", clientAuth, requireUser, getInstalledApps);
app.post("/install/:packageName", clientAuth, requireUser, installApp);
app.post("/uninstall/:packageName", clientAuth, requireUser, uninstallApp);
// Disabled for now as the webview store does not manage apps:
// app.post("/:packageName/start", clientAuth, requireUser, startApp);
// app.post("/:packageName/stop", clientAuth, requireUser, stopApp);

// Dynamic route must come LAST (catches everything else)
app.get("/:packageName", getAppDetails);

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/store/published-apps
 * Get all published apps available in the store.
 * No authentication required.
 */
async function getPublicApps(c: AppContext) {
  try {
    const apps = await storeService.getPublishedApps();
    const enrichedApps = await batchEnrichAppsWithProfiles(apps);
    return c.json({ success: true, data: enrichedApps });
  } catch (e: unknown) {
    const error = e as Error;
    logger.error(error, "Failed to get public apps");
    return c.json(
      {
        error: error?.message || "Failed to get public apps",
      },
      500,
    );
  }
}

/**
 * GET /api/store/published-apps-loggedin
 * Get available apps for authenticated user with installation status.
 * Requires authentication.
 */
async function getPublishedAppsForUser(c: AppContext) {
  try {
    const email = c.get("email");
    const user = c.get("user");

    if (!email) {
      return c.json({ error: "Authentication required" }, 401);
    }
    if (!user) {
      return c.json({ error: "User not found" }, 401);
    }

    const appsWithStatus = await storeService.getPublishedAppsForUser(user);
    const enrichedApps = await batchEnrichAppsWithProfiles(appsWithStatus);

    return c.json({ success: true, data: enrichedApps });
  } catch (e: unknown) {
    const error = e as Error;
    logger.error(error, "Failed to get available apps");
    return c.json(
      {
        error: error?.message || "Failed to get available apps",
      },
      500,
    );
  }
}

/**
 * GET /api/store/installed
 * Get user's installed apps.
 * Requires authentication.
 */
async function getInstalledApps(c: AppContext) {
  try {
    const email = c.get("email");
    const user = c.get("user");

    if (!email) {
      return c.json({ error: "Authentication required" }, 401);
    }
    if (!user) {
      return c.json({ error: "User not found" }, 401);
    }

    const installedApps = await storeService.getInstalledAppsForUser(user);
    const enrichedApps = await batchEnrichAppsWithProfiles(installedApps);

    return c.json({ success: true, data: enrichedApps });
  } catch (e: unknown) {
    const error = e as Error;
    logger.error(error, "Failed to get installed apps");
    return c.json(
      {
        error: error?.message || "Failed to get installed apps",
      },
      500,
    );
  }
}

/**
 * GET /api/store/:packageName
 * Get app details by package name.
 * No authentication required.
 */
async function getAppDetails(c: AppContext) {
  try {
    const packageName = c.req.param("packageName");

    if (!packageName) {
      return c.json({ error: "Missing packageName" }, 400);
    }

    const app = await storeService.getAppByPackageName(packageName);

    if (!app) {
      return c.json({ error: "App not found" }, 404);
    }

    const enrichedApps = await batchEnrichAppsWithProfiles([app]);

    return c.json({ success: true, data: enrichedApps[0] || app });
  } catch (e: unknown) {
    const error = e as Error;
    logger.error(error, "Failed to get app details");
    return c.json(
      {
        error: error?.message || "Failed to get app details",
      },
      500,
    );
  }
}

/**
 * GET /api/store/search
 * Search for apps by query string.
 * No authentication required.
 */
async function searchApps(c: AppContext) {
  try {
    const query = c.req.query("q");

    if (!query) {
      return c.json({ error: "Missing search query parameter 'q'" }, 400);
    }

    const filteredApps = await storeService.searchApps(query);
    const enrichedApps = await batchEnrichAppsWithProfiles(filteredApps);

    return c.json({ success: true, data: enrichedApps });
  } catch (e: unknown) {
    const error = e as Error;
    logger.error(error, "Failed to search apps");
    return c.json(
      {
        error: error?.message || "Failed to search apps",
      },
      500,
    );
  }
}

/**
 * POST /api/store/install/:packageName
 * Install an app for the authenticated user.
 * Requires authentication.
 */
async function installApp(c: AppContext) {
  try {
    const email = c.get("email");
    const user = c.get("user");

    if (!email) {
      return c.json({ error: "Authentication required" }, 401);
    }
    if (!user) {
      return c.json({ error: "User not found" }, 401);
    }

    const packageName = c.req.param("packageName");

    if (!packageName) {
      return c.json({ error: "Missing packageName" }, 400);
    }

    const result = await storeService.installAppForUser(user, packageName);

    if (result.alreadyInstalled) {
      return c.json({ success: true, message: "App already installed" });
    }

    return c.json({ success: true, message: "App installed successfully" });
  } catch (e: unknown) {
    const error = e as Error;
    logger.error(error, "Failed to install app");

    // Check for specific error messages
    if (error.message === "App not found") {
      return c.json({ error: "App not found" }, 404);
    }

    return c.json(
      {
        error: error?.message || "Failed to install app",
      },
      500,
    );
  }
}

/**
 * POST /api/store/uninstall/:packageName
 * Uninstall an app for the authenticated user.
 * Requires authentication.
 */
async function uninstallApp(c: AppContext) {
  try {
    const email = c.get("email");
    const user = c.get("user");

    if (!email) {
      return c.json({ error: "Authentication required" }, 401);
    }
    if (!user) {
      return c.json({ error: "User not found" }, 401);
    }

    const packageName = c.req.param("packageName");

    if (!packageName) {
      return c.json({ error: "Missing packageName" }, 400);
    }

    // Stop app if it's running (handled at API layer, not service layer)
    const userSession = UserSession.getById(email);
    if (userSession) {
      const isRunning = userSession.appManager.isAppRunning(packageName);
      if (isRunning) {
        await userSession.appManager.stopApp(packageName);
        logger.info(`Stopped running app ${packageName} before uninstall`);
      }
    }

    // Uninstall app using service
    await storeService.uninstallAppForUser(user, packageName);

    return c.json({ success: true, message: "App uninstalled successfully" });
  } catch (e: unknown) {
    const error = e as Error;
    logger.error(error, "Failed to uninstall app");

    // Check for specific error messages
    if (error.message === "App is not installed") {
      return c.json({ error: "App is not installed" }, 404);
    }

    return c.json(
      {
        error: error?.message || "Failed to uninstall app",
      },
      500,
    );
  }
}

/**
 * POST /api/store/:packageName/start
 * Start an app for the authenticated user.
 * Requires active user session.
 */
async function startApp(c: AppContext) {
  try {
    const email = c.get("email");

    if (!email) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const packageName = c.req.param("packageName");

    if (!packageName) {
      return c.json({ error: "Missing packageName" }, 400);
    }

    // Check if user has active session
    const userSession = UserSession.getById(email);
    if (!userSession) {
      return c.json(
        {
          error: "No active session found. Please connect your device first.",
        },
        401,
      );
    }

    // Check if app is installed
    const user = await User.findOrCreateUser(email);
    if (!user.isAppInstalled(packageName)) {
      return c.json({ error: "App is not installed" }, 404);
    }

    // Start the app
    const result = await userSession.appManager.startApp(packageName);

    if (!result.success) {
      return c.json(
        {
          error: "Failed to start app",
          details: result.error,
        },
        500,
      );
    }

    return c.json({ success: true, message: "App started successfully" });
  } catch (e: unknown) {
    const error = e as Error;
    logger.error(error, "Failed to start app");
    return c.json(
      {
        error: error?.message || "Failed to start app",
      },
      500,
    );
  }
}

/**
 * POST /api/store/:packageName/stop
 * Stop a running app for the authenticated user.
 * Requires active user session.
 */
async function stopApp(c: AppContext) {
  try {
    const email = c.get("email");

    if (!email) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const packageName = c.req.param("packageName");

    if (!packageName) {
      return c.json({ error: "Missing packageName" }, 400);
    }

    // Check if user has active session
    const userSession = UserSession.getById(email);
    if (!userSession) {
      return c.json(
        {
          error: "No active session found",
        },
        401,
      );
    }

    // Check if app is running
    const isRunning = userSession.appManager.isAppRunning(packageName);
    if (!isRunning) {
      return c.json({ success: true, message: "App is not running" });
    }

    // Stop the app
    await userSession.appManager.stopApp(packageName);

    return c.json({ success: true, message: "App stopped successfully" });
  } catch (e: unknown) {
    const error = e as Error;
    logger.error(error, "Failed to stop app");
    return c.json(
      {
        error: error?.message || "Failed to stop app",
      },
      500,
    );
  }
}

export default app;
