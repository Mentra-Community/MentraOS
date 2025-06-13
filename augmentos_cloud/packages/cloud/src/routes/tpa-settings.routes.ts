// backend/src/routes/tpa-settings.ts
import express from 'express';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import { systemApps } from '../services/core/system-apps';
import { User } from '../models/user.model';

export const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";
import appService, { isUninstallable } from '../services/core/app.service';
import { logger as rootLogger } from '../services/logging/pino-logger';
import { CloudToTpaMessageType, UserSession, AppSetting } from '@augmentos/sdk';
import { sessionService } from '../services/core/session.service';
import { Permission } from '@augmentos/sdk';

const router = express.Router();

// TODO(isaiah) define and use appropriate middleware.

// Clean function to remove Mongoose metadata and ensure proper typing
function cleanAppSettings(settings: any[]): AppSetting[] {
  return settings.map(setting => {
    const { __parentArray, __index, $__parent, $__, _doc, $isNew, ...cleanSetting } = setting;

    // Handle GROUP type specially since it has different required fields
    if (setting.type === 'group') {
      return {
        type: setting.type,
        key: setting.key || '',
        label: setting.label || '',
        title: setting.title || '',
        ...(setting._id && { _id: setting._id }),
        ...(setting.options && { options: setting.options })
      } as AppSetting;
    }

    // For all other setting types, preserve the clean properties
    return cleanSetting as AppSetting;
  });
}

// GET /tpasettings/:tpaName
// Returns the TPA config with each non-group setting having a "selected" property
// that comes from the user's stored settings (or defaultValue if not present).
router.get('/:tpaName', async (req, res) => {
  rootLogger.info('Received request for TPA settings');

  // Extract TPA name from URL (use third segment if dot-separated).
  // const parts = req.params.tpaName.split('.');
  const tpaName = req.params.tpaName === "com.augmentos.dashboard" ? systemApps.dashboard.packageName : req.params.tpaName;

  let webviewURL: string | undefined;

  if (!tpaName) {
    return res.status(400).json({ error: 'TPA name missing in request' });
  }

  // Validate the Authorization header.
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header missing' });
  }
  const authParts = authHeader.split(' ');
  if (authParts.length !== 2 || authParts[0] !== 'Bearer') {
    return res.status(401).json({ error: 'Invalid Authorization header format' });
  }
  const coreToken = authParts[1];
  let permissions: Permission[] = [];

  try {
    // Verify token.
    const decoded = jwt.verify(coreToken, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;
    const userId = decoded.email;
    if (!userId) {
      return res.status(400).json({ error: 'User ID missing in token' });
    }
    const logger = rootLogger.child({ service: 'tpa-settings', userId });

    // Get TPA configuration from database instead of tpa_config.json
    const _tpa = await appService.getApp(tpaName);

    if (!_tpa) {
      logger.error('TPA not found for app:', tpaName);
      return res.status(404).json({ error: 'TPA not found' });
    }

    permissions = _tpa.permissions || permissions;
    webviewURL = _tpa.webviewURL;

    // Build TPA config from database data
    const tpaConfig = {
      name: _tpa.name || tpaName,
      description: _tpa.description || '',
      version: _tpa.version || "1.0.0",
      settings: _tpa.settings || []
    };

    logger.debug({ tpaConfig }, `TPA configuration for user: ${userId} from TPA ${tpaName}`);

    // Find or create the user.
    const user = await User.findOrCreateUser(userId);

    // Retrieve stored settings for this app.
    let storedSettings = user.getAppSettings(tpaName);
    if (!storedSettings) {
      // Build default settings from config (ignoring groups)
      const defaultSettings = tpaConfig && tpaConfig.settings && Array.isArray(tpaConfig.settings)
        ? tpaConfig.settings
          .filter((setting: any) => setting.type !== 'group')
          .map((setting: any) => ({
            key: setting.key,
            value: setting.defaultValue,       // initially, use defaultValue
            defaultValue: setting.defaultValue,
            type: setting.type,
            label: setting.label,
            options: setting.options || []
          }))
        : [];
      await user.updateAppSettings(tpaName, defaultSettings);
      storedSettings = defaultSettings;
    }

    // Clean the tpaConfig.settings first to remove Mongoose metadata
    const cleanTpaSettings = tpaConfig.settings.map(setting =>
      JSON.parse(JSON.stringify(setting))
    );

    // Then merge with stored settings
    const mergedSettings = cleanTpaSettings.map((setting: any) => {
      if (setting.type === 'group') return setting;

      const stored = storedSettings?.find((s: any) => s.key === setting.key);
      return {
        ...setting,
        selected: stored && stored.value !== undefined ? stored.value : setting.defaultValue
      };
    });

    // Clean the merged settings to remove Mongoose metadata
    const cleanSettings = cleanAppSettings(mergedSettings);

    logger.debug({ cleanSettings }, `Merged and cleaned settings for user: ${userId} from TPA ${tpaName}`);

    const uninstallable = isUninstallable(tpaName);
    return res.json({
      success: true,
      userId,
      name: tpaConfig.name,
      description: tpaConfig.description,
      uninstallable,
      webviewURL,
      version: tpaConfig.version,
      settings: cleanSettings,
      permissions,
    });
  } catch (error) {
    rootLogger.error('Error processing TPA settings request:', error);
    return res.status(401).json({ error: 'Invalid core token or error processing request' });
  }
});

// GET /tpasettings/user/:tpaName
router.get('/user/:tpaName', async (req, res) => {
  rootLogger.info('Received request for user-specific TPA settings with params: ' + JSON.stringify(req.params));

  const authHeader = req.headers.authorization;
  rootLogger.info('Received request for user-specific TPA settings with auth header: ' + JSON.stringify(authHeader));

  if (!authHeader) {
    return res.status(400).json({ error: 'User ID missing in Authorization header' });
  }
  const userId = authHeader.split(' ')[1];
  const tpaName = req.params.tpaName === "com.augmentos.dashboard" ? systemApps.dashboard.packageName : req.params.tpaName;

  try {
    const user = await User.findOrCreateUser(userId);
    let storedSettings = user.getAppSettings(tpaName);

    if (!storedSettings && tpaName !== systemApps.dashboard.packageName) {
      // Get TPA configuration from database instead of tpa_config.json
      const _tpa = await appService.getApp(tpaName);

      if (!_tpa) {
        rootLogger.error('TPA not found for app:', tpaName);
        return res.status(404).json({ error: 'TPA not found' });
      }

      // Build TPA config from database data
      const tpaConfig = {
        name: _tpa.name || tpaName,
        description: _tpa.description || '',
        version: _tpa.version || "1.0.0",
        settings: _tpa.settings || []
      };

      const defaultSettings = tpaConfig && tpaConfig.settings && Array.isArray(tpaConfig.settings)
        ? tpaConfig.settings
          .filter((setting: any) => setting.type !== 'group')
          .map((setting: any) => ({
            key: setting.key,
            value: setting.defaultValue,
            defaultValue: setting.defaultValue,
            type: setting.type,
            label: setting.label,
            options: setting.options || []
          }))
        : [];
      await user.updateAppSettings(tpaName, defaultSettings);
      storedSettings = defaultSettings;
    }

    return res.json({ success: true, settings: storedSettings });
  } catch (error) {
    rootLogger.error('Error processing user-specific TPA settings request:', error);
    return res.status(401).json({ error: 'Error processing request' });
  }
});

// POST /tpasettings/:tpaName
// Receives an update payload containing all settings with new values and updates the database.
// backend/src/routes/tpa-settings.ts
router.post('/:tpaName', async (req, res) => {
  // Extract TPA name.
  // const parts = req.params.tpaName.split('.');
  const tpaName = req.params.tpaName === "com.augmentos.dashboard" ? systemApps.dashboard.packageName : req.params.tpaName;

  if (!tpaName) {
    return res.status(400).json({ error: 'TPA name missing in request' });
  }

  // Validate Authorization header.
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    // console.log('authHeader', authHeader);
    return res.status(401).json({ error: 'Authorization header missing' });
  }
  const authParts = authHeader.split(' ');
  if (authParts.length !== 2 || authParts[0] !== 'Bearer') {
    // console.log('authParts', authParts);
    return res.status(401).json({ error: 'Invalid Authorization header format' });
  }
  const coreToken = authParts[1];

  try {
    // Verify token.
    const decoded = jwt.verify(coreToken, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;
    const userId = decoded.email;
    if (!userId) {
      // console.log('@@@@@ userId', userId);
      return res.status(400).json({ error: 'User ID missing in token' });
    }

    const updatedPayload = req.body;
    let settingsArray;

    // Handle both array and single object formats
    if (Array.isArray(updatedPayload)) {
      settingsArray = updatedPayload;
    } else if (updatedPayload && typeof updatedPayload === 'object' && 'key' in updatedPayload && 'value' in updatedPayload) {
      // If it's a single setting object, wrap it in an array
      settingsArray = [updatedPayload];
      rootLogger.info(`Converted single setting object to array for key: ${updatedPayload.key}`);
    } else {
      // console.log('@@@@@ updatedPayload', updatedPayload);
      return res.status(400).json({ error: 'Invalid update payload format. Expected an array of settings or a single setting object.' });
    }

    // Find or create the user.
    const user = await User.findOrCreateUser(userId);

    // console.log('@@@@@ user', user);
    // Update the settings for this app from scratch.
    // We assume that the payload contains the complete set of settings (each with key and value).
    const updatedSettings = await user.updateAppSettings(tpaName, settingsArray);

    rootLogger.info(`Updated settings for app "${tpaName}" for user ${userId}`);

    // Get user session to send WebSocket update
    // const sessionService = require('../services/core/session.service');
    const userSession = sessionService.getSession(userId);

    // If user has active sessions, send them settings updates via WebSocket
    if (userSession && tpaName !== systemApps.dashboard.packageName && tpaName !== "com.augmentos.dashboard") {
      const settingsUpdate = {
        type: CloudToTpaMessageType.SETTINGS_UPDATE,
        packageName: tpaName,
        sessionId: `${userSession.sessionId}-${tpaName}`,
        settings: updatedSettings,
        timestamp: new Date()
      };

      try {
        // When the user is not runnning the app, the appConnection is undefined, so we wrap it in a try/catch.
        const tpaConnection = userSession.appConnections.get(tpaName);
        tpaConnection.send(JSON.stringify(settingsUpdate));
        rootLogger.info(`Sent settings update via WebSocket to ${tpaName} for user ${userId}`);
      }
      catch (error) {
        rootLogger.error('Error sending settings update via WebSocket:', error);
      }
    }
    // Get the app to access its properties
    const app = await appService.getApp(tpaName);

    if (app) {
      let appEndpoint;

      // console.log('@@@@@ app', app);

      // Check if it's a system app first
      if (app.isSystemApp) {
        // For system apps, use the internal host approach
        const matchingApp = Object.values(systemApps).find(sysApp =>
          sysApp.packageName === tpaName
        );

        if (matchingApp && matchingApp.host) {
          appEndpoint = `http://${matchingApp.host}/settings`;
        }
      }

      // If not a system app or system app info not found, use publicUrl
      if (!appEndpoint && app.publicUrl) {
        appEndpoint = `${app.publicUrl}/settings`;
      }

      // Send settings update if we have an endpoint
      if (appEndpoint) {
        try {
          const response = await axios.post(appEndpoint, {
            userIdForSettings: userId,
            settings: updatedSettings
          });
          rootLogger.info(`Called app endpoint at ${appEndpoint} with response:`, response.data);
        } catch (err) {
          rootLogger.error(`Error calling app endpoint at ${appEndpoint}:`, err);
        }
      }
    }

    return res.json({ success: true, message: 'Settings updated successfully' });
  } catch (error) {
    rootLogger.error('Error processing update for TPA settings:', error);
    return res.status(401).json({ error: 'Invalid core token or error processing update' });
  }
});

export default router;
