// backend/src/routes/app-settings.ts
import express from "express";
import jwt from "jsonwebtoken";
import axios from "axios";
import { User } from "../models/user.model";
import Organization from "../models/organization.model";

export const AUGMENTOS_AUTH_JWT_SECRET =
  process.env.AUGMENTOS_AUTH_JWT_SECRET || "";
import appService, {
  isUninstallable,
  SYSTEM_DASHBOARD_PACKAGE_NAME,
} from "../services/core/app.service";
import UserSession from "../services/session/UserSession";
import { logger as rootLogger } from "../services/logging/pino-logger";
import { CloudToAppMessageType, AppSetting } from "@mentra/sdk";
import { Permission } from "@mentra/sdk";

const router = express.Router();

// TODO(isaiah) define and use appropriate middleware.

// Clean function to remove Mongoose metadata and ensure proper typing
function cleanAllAppSettings(settings: any[]): AppSetting[] {
  return settings.map((setting) => {
    const {
      __parentArray,
      __index,
      // $__parent,
      // $__,
      // $isNew,
      _doc,
      ...cleanSetting
    } = setting;

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

// GET /appsettings/:appName
// Returns the App config with each non-group setting having a "selected" property
// that comes from the user's stored settings (or defaultValue if not present).
router.get("/:appName", async (req, res) => {
  rootLogger.info("Received request for App settings");

  // Extract App name from URL (use third segment if dot-separated).
  // const parts = req.params.appName.split('.');
  const appName =
    req.params.appName === "com.augmentos.dashboard"
      ? SYSTEM_DASHBOARD_PACKAGE_NAME
      : req.params.appName;

  let webviewURL: string | undefined;

  if (!appName) {
    return res.status(400).json({ error: "App name missing in request" });
  }

  // Validate the Authorization header.
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "Authorization header missing" });
  }
  const authParts = authHeader.split(" ");
  if (authParts.length !== 2 || authParts[0] !== "Bearer") {
    return res
      .status(401)
      .json({ error: "Invalid Authorization header format" });
  }
  const coreToken = authParts[1];
  let permissions: Permission[] = [];

  try {
    // Verify token.
    const decoded = jwt.verify(
      coreToken,
      AUGMENTOS_AUTH_JWT_SECRET,
    ) as jwt.JwtPayload;
    const userId = decoded.email;
    if (!userId) {
      return res.status(400).json({ error: "User ID missing in token" });
    }
    const logger = rootLogger.child({ service: "app-settings", userId });

    // Get App configuration from database instead of app_config.json
    const _app = await appService.getApp(appName);

    if (!_app) {
      logger.error({ appName }, "App not found for app:");
      return res.status(404).json({ error: "App not found" });
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

    logger.debug(
      { appConfig },
      `App configuration for user: ${userId} from App ${appName}`,
    );

    // Find or create the user.
    const user = await User.findOrCreateUser(userId);

    // Retrieve stored settings for this app.
    let storedSettings = user.getAppSettings(appName);
    if (!storedSettings) {
      // Build default settings from config (ignoring groups)
      const defaultSettings =
        appConfig && appConfig.settings && Array.isArray(appConfig.settings)
          ? appConfig.settings
              .filter((setting: any) => setting.type !== "group")
              .map((setting: any) => ({
                key: setting.key,
                value: setting.defaultValue, // initially, use defaultValue
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
    const cleanAppSettings = appConfig.settings.map((setting) =>
      JSON.parse(JSON.stringify(setting)),
    );

    // Then merge with stored settings
    const mergedSettings = cleanAppSettings.map((setting: any) => {
      if (setting.type === "group") return setting;

      const stored = storedSettings?.find((s: any) => s.key === setting.key);
      return {
        ...setting,
        selected:
          stored && stored.value !== undefined
            ? stored.value
            : setting.defaultValue,
      };
    });

    // Clean the merged settings to remove Mongoose metadata
    const cleanSettings = cleanAllAppSettings(mergedSettings);

    logger.debug(
      { cleanSettings },
      `Merged and cleaned settings for user: ${userId} from App ${appName}`,
    );

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
        logger.warn(
          { error, organizationId: _app.organizationId },
          "Failed to fetch organization info for App",
        );
      }
    }

    const uninstallable = isUninstallable(appName);
    return res.json({
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
    rootLogger.error(error as Error, "Error processing App settings request:");
    return res
      .status(401)
      .json({ error: "Invalid core token or error processing request" });
  }
});

// GET /appsettings/user/:appName
router.get("/user/:appName", async (req, res) => {
  rootLogger.info(
    "Received request for user-specific App settings with params: " +
      JSON.stringify(req.params),
  );

  const authHeader = req.headers.authorization;
  rootLogger.info(
    "Received request for user-specific App settings with auth header: " +
      JSON.stringify(authHeader),
  );

  if (!authHeader) {
    return res
      .status(400)
      .json({ error: "User ID missing in Authorization header" });
  }
  const userId = authHeader.split(" ")[1];
  const appName =
    req.params.appName === "com.augmentos.dashboard"
      ? SYSTEM_DASHBOARD_PACKAGE_NAME
      : req.params.appName;

  try {
    const user = await User.findOrCreateUser(userId);
    let storedSettings = user.getAppSettings(appName);

    if (!storedSettings && appName !== SYSTEM_DASHBOARD_PACKAGE_NAME) {
      // Get App configuration from database instead of app_config.json
      const _app = await appService.getApp(appName);

      if (!_app) {
        rootLogger.error({ appName }, "App not found for app:");
        return res.status(404).json({ error: "App not found" });
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

    return res.json({ success: true, settings: storedSettings });
  } catch (error) {
    rootLogger.error(
      error as Error,
      "Error processing user-specific App settings request:",
    );
    return res.status(401).json({ error: "Error processing request" });
  }
});

// POST /appsettings/:appName
// Receives an update payload containing all settings with new values and updates the database.
// backend/src/routes/app-settings.ts
router.post("/:appName", async (req, res) => {
  // Extract App name.
  // const parts = req.params.appName.split('.');
  const appName =
    req.params.appName === "com.augmentos.dashboard"
      ? SYSTEM_DASHBOARD_PACKAGE_NAME
      : req.params.appName;

  if (!appName) {
    return res.status(400).json({ error: "App name missing in request" });
  }

  // Validate Authorization header.
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    // console.log('authHeader', authHeader);
    return res.status(401).json({ error: "Authorization header missing" });
  }
  const authParts = authHeader.split(" ");
  if (authParts.length !== 2 || authParts[0] !== "Bearer") {
    // console.log('authParts', authParts);
    return res
      .status(401)
      .json({ error: "Invalid Authorization header format" });
  }
  const coreToken = authParts[1];

  try {
    // Verify token.
    const decoded = jwt.verify(
      coreToken,
      AUGMENTOS_AUTH_JWT_SECRET,
    ) as jwt.JwtPayload;
    const userId = decoded.email;
    if (!userId) {
      // console.log('@@@@@ userId', userId);
      return res.status(400).json({ error: "User ID missing in token" });
    }

    const updatedPayload = req.body;
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
      rootLogger.info(
        `Converted single setting object to array for key: ${updatedPayload.key}`,
      );
    } else {
      // console.log('@@@@@ updatedPayload', updatedPayload);
      return res.status(400).json({
        error:
          "Invalid update payload format. Expected an array of settings or a single setting object.",
      });
    }

    // Find or create the user.
    const user = await User.findOrCreateUser(userId);

    // console.log('@@@@@ user', user);
    // Update the settings for this app from scratch.
    // We assume that the payload contains the complete set of settings (each with key and value).
    const updatedSettings = await user.updateAppSettings(
      appName,
      settingsArray,
    );

    rootLogger.info(`Updated settings for app "${appName}" for user ${userId}`);

    // Get user session to send WebSocket update
    const userSession = UserSession.getById(userId);

    // If user has active sessions, send them settings updates via WebSocket
    if (
      userSession &&
      appName !== SYSTEM_DASHBOARD_PACKAGE_NAME &&
      appName !== "com.augmentos.dashboard"
    ) {
      const settingsUpdate = {
        type: CloudToAppMessageType.SETTINGS_UPDATE,
        packageName: appName,
        sessionId: `${userSession.sessionId}-${appName}`,
        settings: updatedSettings,
        timestamp: new Date(),
      };

      try {
        // When the user is not runnning the app, the appConnection is undefined, so we wrap it in a try/catch.
        const appWebsocket = userSession.appWebsockets.get(appName);
        if (appWebsocket) {
          userSession.logger.warn(
            { packageName: appName },
            `No WebSocket connection found for App ${appName} for user ${userId}`,
          );
          appWebsocket.send(JSON.stringify(settingsUpdate));
          userSession.logger.info(
            { packageName: appName },
            `Sent settings update via WebSocket to ${appName} for user ${userId}`,
          );
        }
      } catch (error) {
        rootLogger.error(
          error as Error,
          "Error sending settings update via WebSocket:",
        );
      }
    }
    // Get the app to access its properties
    const app = await appService.getApp(appName);

    if (app) {
      let appEndpoint;

      // If not a system app or system app info not found, use publicUrl
      if (!appEndpoint && app.publicUrl) {
        appEndpoint = `${app.publicUrl}/settings`;
      }

      // Send settings update if we have an endpoint
      if (appEndpoint) {
        try {
          const response = await axios.post(appEndpoint, {
            userIdForSettings: userId,
            settings: updatedSettings,
          });
          rootLogger.info(
            { responseData: response.data },
            `Called app endpoint at ${appEndpoint} with response:`,
          );
        } catch (err) {
          rootLogger.error(
            err as Error,
            `Error calling app endpoint at ${appEndpoint}:`,
          );
        }
      }
    }

    return res.json({
      success: true,
      message: "Settings updated successfully",
    });
  } catch (error) {
    rootLogger.error(
      error as Error,
      "Error processing update for App settings:",
    );
    return res
      .status(401)
      .json({ error: "Invalid core token or error processing update" });
  }
});

export default router;
