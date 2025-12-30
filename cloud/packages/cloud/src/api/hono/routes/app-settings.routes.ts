/**
 * @fileoverview Hono app-settings routes.
 * App settings management endpoints.
 * Mounted at: /appsettings and /tpasettings
 */

import { Hono } from "hono";
import jwt from "jsonwebtoken";
import axios from "axios";
import { User } from "../../../models/user.model";
import Organization from "../../../models/organization.model";
import appService, { SYSTEM_DASHBOARD_PACKAGE_NAME } from "../../../services/core/app.service";
import { isUninstallable } from "../../../services/core/app.service";
import UserSession from "../../../services/session/UserSession";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import { CloudToAppMessageType, AppSetting } from "@mentra/sdk";
import { Permission } from "@mentra/sdk";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "app-settings.routes" });

const app = new Hono<AppEnv>();

const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

// ============================================================================
// Routes
// ============================================================================

app.get("/:appName", getAppSettings);
app.get("/user/:appName", getUserAppSettings);
app.post("/:appName", updateAppSettings);

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Clean function to remove Mongoose metadata and ensure proper typing.
 */
function cleanAllAppSettings(settings: any[]): AppSetting[] {
  return settings.map((setting) => {
    const { __parentArray, __index, _doc, ...cleanSetting } = setting;

    // Handle GROUP type specially since it has different required fields
    if (setting.type === "group") {
      return {
        type: setting.type,
        key: setting.key || "",
        label: setting.label || "",
        title: setting.title || "",
        ...(setting._id && { _id: setting._id }),
        ...(setting.options && { options: setting.options }),
      } as AppSetting;
    }

    // For all other setting types, preserve the clean properties
    return cleanSetting as AppSetting;
  });
}

/**
 * Normalize app name, handling dashboard alias.
 */
function normalizeAppName(appName: string): string {
  return appName === "com.augmentos.dashboard" ? SYSTEM_DASHBOARD_PACKAGE_NAME : appName;
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /appsettings/:appName
 * Returns the App config with each non-group setting having a "selected" property
 * that comes from the user's stored settings (or defaultValue if not present).
 */
async function getAppSettings(c: AppContext) {
  logger.info("Received request for App settings");

  const appName = normalizeAppName(c.req.param("appName") || "");
  let webviewURL: string | undefined;

  if (!appName) {
    return c.json({ error: "App name missing in request" }, 400);
  }

  // Validate the Authorization header
  const authHeader = c.req.header("authorization");
  if (!authHeader) {
    return c.json({ error: "Authorization header missing" }, 401);
  }

  const authParts = authHeader.split(" ");
  if (authParts.length !== 2 || authParts[0] !== "Bearer") {
    return c.json({ error: "Invalid Authorization header format" }, 401);
  }

  const coreToken = authParts[1];
  let permissions: Permission[] = [];

  try {
    // Verify token
    const decoded = jwt.verify(coreToken, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;
    const userId = decoded.email;

    if (!userId) {
      return c.json({ error: "User ID missing in token" }, 400);
    }

    const reqLogger = logger.child({ userId });

    // Get App configuration from database
    const _app = await appService.getApp(appName);

    if (!_app) {
      reqLogger.error({ appName }, "App not found for app:");
      return c.json({ error: "App not found" }, 404);
    }

    permissions = _app.permissions || permissions;
    webviewURL = _app.webviewURL;

    // Build App config from database data
    const appConfig = {
      name: _app.name || appName,
      description: _app.description || "",
      version: _app.version || "1.0.0",
      settings: _app.settings || [],
    };

    reqLogger.debug({ appConfig }, `App configuration for user: ${userId} from App ${appName}`);

    // Find or create the user
    const user = await User.findOrCreateUser(userId);

    // Retrieve stored settings for this app
    let storedSettings = user.getAppSettings(appName);
    if (!storedSettings) {
      // Build default settings from config (ignoring groups)
      const defaultSettings =
        appConfig && appConfig.settings && Array.isArray(appConfig.settings)
          ? appConfig.settings
              .filter((setting: any) => setting.type !== "group")
              .map((setting: any) => ({
                key: setting.key,
                value: setting.defaultValue,
                defaultValue: setting.defaultValue,
                type: setting.type,
                label: setting.label,
                options: setting.options || [],
              }))
          : [];
      await user.updateAppSettings(appName, defaultSettings);
      storedSettings = defaultSettings;
    }

    // Clean the appConfig.settings first to remove Mongoose metadata
    const cleanAppSettings = appConfig.settings.map((setting) => JSON.parse(JSON.stringify(setting)));

    // Then merge with stored settings
    const mergedSettings = cleanAppSettings.map((setting: any) => {
      if (setting.type === "group") return setting;

      const stored = storedSettings?.find((s: any) => s.key === setting.key);
      return {
        ...setting,
        selected: stored && stored.value !== undefined ? stored.value : setting.defaultValue,
      };
    });

    // Clean the merged settings to remove Mongoose metadata
    const cleanSettings = cleanAllAppSettings(mergedSettings);

    reqLogger.debug({ cleanSettings }, `Merged and cleaned settings for user: ${userId} from App ${appName}`);

    // Get organization information
    let _organization = null;
    if (_app.organizationId) {
      try {
        const organization = await Organization.findById(_app.organizationId);
        if (organization && organization.profile) {
          _organization = {
            name: organization.name,
            website: organization.profile.website,
            contactEmail: organization.profile.contactEmail,
            description: organization.profile.description,
            logo: organization.profile.logo,
          };
        }
      } catch (error) {
        reqLogger.warn({ error, organizationId: _app.organizationId }, "Failed to fetch organization info for App");
      }
    }

    const uninstallable = isUninstallable(appName);

    return c.json({
      success: true,
      userId,
      name: appConfig.name,
      description: appConfig.description,
      uninstallable,
      webviewURL,
      version: appConfig.version,
      settings: cleanSettings,
      permissions,
      organization: _organization,
    });
  } catch (error) {
    logger.error(error, "Error processing App settings request:");
    return c.json({ error: "Invalid core token or error processing request" }, 401);
  }
}

/**
 * GET /appsettings/user/:appName
 * Get user-specific app settings.
 */
async function getUserAppSettings(c: AppContext) {
  logger.info("Received request for user-specific App settings");

  const authHeader = c.req.header("authorization");

  if (!authHeader) {
    return c.json({ error: "User ID missing in Authorization header" }, 400);
  }

  const userId = authHeader.split(" ")[1];
  const appName = normalizeAppName(c.req.param("appName") || "");

  try {
    const user = await User.findOrCreateUser(userId);
    let storedSettings = user.getAppSettings(appName);

    if (!storedSettings && appName !== SYSTEM_DASHBOARD_PACKAGE_NAME) {
      // Get App configuration from database
      const _app = await appService.getApp(appName);

      if (!_app) {
        logger.error({ appName }, "App not found for app:");
        return c.json({ error: "App not found" }, 404);
      }

      // Build App config from database data
      const appConfig = {
        name: _app.name || appName,
        description: _app.description || "",
        version: _app.version || "1.0.0",
        settings: _app.settings || [],
      };

      const defaultSettings =
        appConfig && appConfig.settings && Array.isArray(appConfig.settings)
          ? appConfig.settings
              .filter((setting: any) => setting.type !== "group")
              .map((setting: any) => ({
                key: setting.key,
                value: setting.defaultValue,
                defaultValue: setting.defaultValue,
                type: setting.type,
                label: setting.label,
                options: setting.options || [],
              }))
          : [];
      await user.updateAppSettings(appName, defaultSettings);
      storedSettings = defaultSettings;
    }

    return c.json({ success: true, settings: storedSettings });
  } catch (error) {
    logger.error(error, "Error processing user-specific App settings request:");
    return c.json({ error: "Error processing request" }, 401);
  }
}

/**
 * POST /appsettings/:appName
 * Update app settings for a user.
 */
async function updateAppSettings(c: AppContext) {
  const appName = normalizeAppName(c.req.param("appName") || "");

  if (!appName) {
    return c.json({ error: "App name missing in request" }, 400);
  }

  // Validate Authorization header
  const authHeader = c.req.header("authorization");
  if (!authHeader) {
    return c.json({ error: "Authorization header missing" }, 401);
  }

  const authParts = authHeader.split(" ");
  if (authParts.length !== 2 || authParts[0] !== "Bearer") {
    return c.json({ error: "Invalid Authorization header format" }, 401);
  }

  const coreToken = authParts[1];

  try {
    // Verify token
    const decoded = jwt.verify(coreToken, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;
    const userId = decoded.email;

    if (!userId) {
      return c.json({ error: "User ID missing in token" }, 400);
    }

    const updatedPayload = await c.req.json().catch(() => ({}));
    let settingsArray;

    // Handle both array and single object formats
    if (Array.isArray(updatedPayload)) {
      settingsArray = updatedPayload;
    } else if (
      updatedPayload &&
      typeof updatedPayload === "object" &&
      "key" in updatedPayload &&
      "value" in updatedPayload
    ) {
      // If it's a single setting object, wrap it in an array
      settingsArray = [updatedPayload];
      logger.info(`Converted single setting object to array for key: ${(updatedPayload as any).key}`);
    } else {
      return c.json(
        {
          error: "Invalid update payload format. Expected an array of settings or a single setting object.",
        },
        400,
      );
    }

    // Find or create the user
    const user = await User.findOrCreateUser(userId);

    // Update the settings for this app
    const updatedSettings = await user.updateAppSettings(appName, settingsArray);

    logger.info(`Updated settings for app "${appName}" for user ${userId}`);

    // Get user session to send WebSocket update
    const userSession = UserSession.getById(userId);

    // If user has active sessions, send them settings updates via WebSocket
    if (userSession && appName !== SYSTEM_DASHBOARD_PACKAGE_NAME && appName !== "com.augmentos.dashboard") {
      const settingsUpdate = {
        type: CloudToAppMessageType.SETTINGS_UPDATE,
        packageName: appName,
        sessionId: `${userSession.sessionId}-${appName}`,
        settings: updatedSettings,
        timestamp: new Date(),
      };

      try {
        const appWebsocket = userSession.appWebsockets.get(appName);
        if (appWebsocket) {
          logger.warn({ packageName: appName }, `No WebSocket connection found for App ${appName} for user ${userId}`);
          appWebsocket.send(JSON.stringify(settingsUpdate));
          logger.info({ packageName: appName }, `Sent settings update via WebSocket to ${appName} for user ${userId}`);
        }
      } catch (error) {
        logger.error(error, "Error sending settings update via WebSocket:");
      }
    }

    // Get the app to access its properties
    const appDoc = await appService.getApp(appName);

    if (appDoc) {
      let appEndpoint;

      // If not a system app or system app info not found, use publicUrl
      if (!appEndpoint && appDoc.publicUrl) {
        appEndpoint = `${appDoc.publicUrl}/settings`;
      }

      // Send settings update if we have an endpoint
      if (appEndpoint) {
        try {
          const response = await axios.post(appEndpoint, {
            userIdForSettings: userId,
            settings: updatedSettings,
          });
          logger.info({ responseData: response.data }, `Called app endpoint at ${appEndpoint} with response:`);
        } catch (err) {
          logger.error(err, `Error calling app endpoint at ${appEndpoint}:`);
        }
      }
    }

    return c.json({
      success: true,
      message: "Settings updated successfully",
    });
  } catch (error) {
    logger.error(error, "Error processing update for App settings:");
    return c.json({ error: "Invalid core token or error processing update" }, 401);
  }
}

export default app;
