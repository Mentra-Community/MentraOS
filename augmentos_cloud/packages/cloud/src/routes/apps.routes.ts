// cloud/src/routes/apps.routes.ts
import express, { Request, Response, NextFunction } from 'express';
import webSocketService from '../services/core/websocket.service';
import sessionService, { ExtendedUserSession } from '../services/core/session.service';
import appService from '../services/core/app.service';
import { User } from '../models/user.model';
import App, { AppI } from '../models/app.model';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { DeveloperProfile } from '@augmentos/sdk';
import { logger as rootLogger } from '../services/logging/pino-logger';
const logger = rootLogger.child({ service: 'apps.routes' });

// Extended app interface for API responses that include developer profile
interface AppWithDeveloperProfile extends AppI {
  developerProfile?: DeveloperProfile;
}

// Enhanced app interface with running state properties
interface EnhancedAppI extends AppI {
  is_running?: boolean;
  is_foreground?: boolean;
}

// Enhanced app with both developer profile and running state
interface EnhancedAppWithDeveloperProfile extends AppWithDeveloperProfile {
  is_running?: boolean;
  is_foreground?: boolean;
}

// Interface for Mongoose document with toObject method
interface MongooseDocument {
  toObject(): any;
}

// This is annyoing to change in the env files everywhere for each region so we set it here.
export const CLOUD_VERSION = "2.1.16"; //process.env.CLOUD_VERSION;
if (!CLOUD_VERSION) {
  logger.error('CLOUD_VERSION is not set');
}

// Allowed package names for API key authentication
const ALLOWED_API_KEY_PACKAGES = ['test.augmentos.mira', 'cloud.augmentos.mira', 'com.augmentos.mira'];

const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

/**
 * Unified authentication middleware: allows either
 * (1) apiKey + packageName + userId (for allowed TPAs), or
 * (2) core token in Authorization header (for user sessions)
 */
async function unifiedAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  // Option 1: API key authentication
  const apiKey = req.query.apiKey as string;
  const packageName = req.query.packageName as string;
  const userId = req.query.userId as string;

  if (apiKey && packageName && userId) {
    if (!ALLOWED_API_KEY_PACKAGES.includes(packageName)) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized package name'
      });
    }
    const isValid = await appService.validateApiKey(packageName, apiKey);
    if (isValid) {
      // Only allow if a full session exists
      const userSessions = sessionService.getSessionsForUser(userId);
      if (userSessions && userSessions.length > 0) {
        (req as any).userSession = userSessions[0];
        return next();
      } else {
        return res.status(401).json({
          success: false,
          message: 'No active session found for user.'
        });
      }
    } else {
      return res.status(401).json({
        success: false,
        message: 'Invalid API key for package.'
      });
    }
  }

  // Option 2: Core token authentication
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      const session = await getSessionFromToken(token);
      if (session) {
        (req as any).userSession = session;
        return next();
      }
    } catch (error) {
      // fall through to error below
    }
  }

  // If neither auth method worked
  return res.status(401).json({
    success: false,
    message: 'Authentication required. Provide either apiKey, packageName, userId or a valid core token with an active session.'
  });
}

/**
 * Helper function to get the active session for a user from their coreToken
 * @param coreToken JWT token from authentication
 * @returns The user's active session or null if not found
 */
async function getSessionFromToken(coreToken: string) {
  try {
    // Verify and decode the token
    const userData = jwt.verify(coreToken, AUGMENTOS_AUTH_JWT_SECRET);
    const userId = (userData as JwtPayload).email;
    if (!userId) {
      return null;
    }

    // Find the active session for this user
    const userSessions = sessionService.getSessionsForUser(userId);

    // Get the most recent active session for this user
    // We could add more sophisticated logic here if needed (e.g., device ID matching)
    if (userSessions && userSessions.length > 0) {
      return userSessions[0]; // Return the first active session
    }

    return null;
  } catch (error) {
    logger.error('Error verifying token or finding session:', error);
    return null;
  }
}

/**
 * Helper function to get the user ID from a token
 * @param token JWT token from authentication
 * @returns The user ID (email) or null if token is invalid
 */
async function getUserIdFromToken(token: string): Promise<string | null> {
  try {
    // Verify and decode the token
    const userData = jwt.verify(token, AUGMENTOS_AUTH_JWT_SECRET);
    const userId = (userData as JwtPayload).email;

    if (!userId) {
      return null;
    }

    return userId;
  } catch (error) {
    logger.error('Error verifying token:', error);
    return null;
  }
}
/**
 * Dual mode auth middleware - works with or without active sessions
 * If a valid token is present but no active session, creates a minimal user context
 */
async function dualModeAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  // Check for Authorization header
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    // Try to get full session
    const session = await getSessionFromToken(token);
    if (session) {
      (req as any).userSession = session;
      next();
      return;
    }
  }

  // Fall back to sessionId in body (for full session only)
  if (req.body && req.body.sessionId) {
    const session = sessionService.getSession(req.body.sessionId);
    if (session) {
      (req as any).userSession = session;
      next();
      return;
    }
  }

  // No valid authentication found
  res.status(401).json({
    success: false,
    message: 'Authentication required. Please provide valid token or session ID with an active session.'
  });
}

/**
 * Middleware to allow authentication via either core token/session or apiKey+packageName+userId
 */
async function apiKeyOrSessionAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  // Accept apiKey/packageName/userId from query, body, or headers
  const apiKey = req.query.apiKey as string || req.body.apiKey || req.headers['x-api-key'] as string;
  const packageName = req.query.packageName as string || req.body.packageName || req.headers['x-package-name'] as string;
  const userId = req.query.userId as string || req.body.userId || req.headers['x-user-id'] as string;
  const allowedPackages = ['test.augmentos.mira', 'com.augmentos.mira'];

  if (apiKey && packageName && userId && allowedPackages.includes(packageName)) {
    // Validate API key
    const valid = await appService.validateApiKey(packageName, apiKey, req.ip);
    if (valid) {
      const userSessions = sessionService.getSessionsForUser(userId);
      if (userSessions && userSessions.length > 0) {
        (req as any).userSession = userSessions[0];
        (req as any).authMode = 'apiKey';
        return next();
      } else {
        // Optionally: fallback to a minimal session, or return an error
        return res.status(401).json({
          success: false,
          message: 'No active session found for user.'
        });
      }
    } else {
      return res.status(401).json({
        success: false,
        message: 'Invalid API key or package name.'
      });
    }
  }

  // Fallback to existing dualModeAuthMiddleware
  return dualModeAuthMiddleware(req, res, next);
}

const router = express.Router();

// Route Handlers
/**
 * Get all available apps
 */
async function getAllApps(req: Request, res: Response) {
  try {
    // Check API key auth first
    const apiKey = req.query.apiKey as string;
    const packageName = req.query.packageName as string;
    const userId = req.query.userId as string;

    if (apiKey && packageName && userId) {
      // Already authenticated via middleware
      const apps = await appService.getAllApps(userId);
      const userSessions = sessionService.getSessionsForUser(userId);
      const enhancedApps = enhanceAppsWithSessionState(apps, userSessions);
      return res.json({
        success: true,
        data: enhancedApps
      });
    }

    // Fall back to token auth
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required. Please provide valid token or API key.'
      });
    }

    // Get the user ID from the token
    const token = authHeader.substring(7);
    const tokenUserId = await getUserIdFromToken(token);

    if (!tokenUserId) {
      return res.status(401).json({
        success: false,
        message: 'User ID is required (via token or userId param)'
      });
    }

    const apps = await appService.getAllApps(tokenUserId);
    const userSessions = sessionService.getSessionsForUser(tokenUserId);
    const enhancedApps = enhanceAppsWithSessionState(apps, userSessions);
    res.json({
      success: true,
      data: enhancedApps
    });
  } catch (error) {
    logger.error({ error }, 'Error fetching apps');
    res.status(500).json({
      success: false,
      message: 'Error fetching apps'
    });
  }
}

/**
 * Get public apps
 */
async function getPublicApps(req: Request, res: Response) {
  try {
    const apps = await appService.getAllApps();
    res.json({
      success: true,
      data: apps
    });
  } catch (error) {
    logger.error({ error }, 'Error fetching public apps');
    res.status(500).json({
      success: false,
      message: 'Error fetching public apps'
    });
  }
}

/**
 * Search apps by query
 */
async function searchApps(req: Request, res: Response) {
  try {
    const query = req.query.q as string;
    if (!query) {
      return res.status(400).json({
        success: false,
        message: 'Search query is required'
      });
    }

    const apps = await appService.getAllApps();
    const searchResults = apps.filter(app =>
      app.name.toLowerCase().includes(query.toLowerCase()) ||
      (app.description && app.description.toLowerCase().includes(query.toLowerCase()))
    );

    res.json({
      success: true,
      data: searchResults
    });
  } catch (error) {
    logger.error('Error searching apps:', error);
    res.status(500).json({
      success: false,
      message: 'Error searching apps'
    });
  }
}

/**
 * Get specific app by package name
 */
async function getAppByPackage(req: Request, res: Response) {
  try {
    const { packageName } = req.params;
    const app = await appService.getApp(packageName);

    if (!app) {
      return res.status(404).json({
        success: false,
        message: `App with package name ${packageName} not found`
      });
    }

    // Convert Mongoose document to plain JavaScript object
    // Use toObject() method if available, otherwise use as is
    const plainApp = typeof (app as any).toObject === 'function'
      ? (app as any).toObject()
      : app;

    // Log permissions for debugging
    logger.debug({ packageName, permissions: plainApp.permissions }, 'App permissions');

    // If the app has a developerId, try to get the developer profile information
    let developerProfile = null;
    if (plainApp.developerId) {
      try {
        const developer = await User.findByEmail(plainApp.developerId);
        if (developer && developer.profile) {
          developerProfile = developer.profile;
        }
      } catch (err) {
        logger.error({ error: err, developerId: plainApp.developerId }, 'Error fetching developer profile');
        // Continue without developer profile
      }
    }

    // Create response with developer profile if available
    // Use the plain app directly instead of spreading its properties
    const appObj = plainApp as AppWithDeveloperProfile;
    if (developerProfile) {
      appObj.developerProfile = developerProfile;
    }

    res.json({
      success: true,
      data: appObj
    });
  } catch (error) {
    logger.error('Error fetching app:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching app'
    });
  }
}

/**
 * Start app for session
 */
async function startApp(req: Request, res: Response) {
  const { packageName } = req.params;
  const session = (req as any).userSession;
  try {
    await webSocketService.startAppSession(session, packageName);
    const appStateChange = await webSocketService.generateAppStateStatus(session);
    res.json({
      success: true,
      data: {
        status: 'started',
        packageName,
        appState: appStateChange
      }
    });
    if (session.websocket && session.websocket.readyState === 1) {
      session.websocket.send(JSON.stringify(appStateChange));
    }
  } catch (error) {
    logger.error(`Error starting app ${packageName}:`, error);
    res.status(500).json({
      success: false,
      message: 'Error starting app'
    });
  }
}

/**
 * Stop app for session 
 */
async function stopApp(req: Request, res: Response) {
  const { packageName } = req.params;
  const session = (req as any).userSession;
  try {
    const app = await appService.getApp(packageName);
    if (!app) {
      return res.status(404).json({
        success: false,
        message: 'App not found'
      });
    }
    await webSocketService.stopAppSession(session, packageName);
    const appStateChange = await webSocketService.generateAppStateStatus(session);
    res.json({
      success: true,
      data: {
        status: 'stopped',
        packageName,
        appState: appStateChange
      }
    });
    if (session.websocket && session.websocket.readyState === 1) {
      session.websocket.send(JSON.stringify(appStateChange));
    }
  } catch (error) {
    logger.error(`Error stopping app ${packageName}:`, error);
    res.status(500).json({
      success: false,
      message: 'Error stopping app'
    });
  }
}

/**
 * Install app for user
 */
async function installApp(req: Request, res: Response) {
  const { packageName } = req.params;
  const session = (req as any).userSession; // Get session from middleware
  const email = session.userId;

  if (!email || !packageName) {
    return res.status(400).json({
      success: false,
      message: 'User session and package name are required'
    });
  }

  try {
    // Find or create user
    const user = await User.findOrCreateUser(email);

    // Get app details
    const app = await appService.findFromAppStore(packageName);
    if (!app) {
      return res.status(404).json({
        success: false,
        message: 'App not found'
      });
    }

    // Check if app is already installed
    if (user.installedApps?.some(app => app.packageName === packageName)) {
      return res.status(400).json({
        success: false,
        message: 'App is already installed'
      });
    }

    // Add to installed apps
    if (!user.installedApps) {
      user.installedApps = [];
    }

    user.installedApps.push({
      packageName,
      installedDate: new Date()
    });

    await user.save();

    res.json({
      success: true,
      message: `App ${packageName} installed successfully`
    });

    // Always attempt WebSocket notifications for full session
    try {
      sessionService.triggerAppStateChange(email);
    } catch (error) {
      logger.warn({ error, email, packageName }, 'Error sending app state notification');
      // Non-critical error, installation succeeded
    }
  } catch (error) {
    logger.error({ error, email, packageName }, 'Error installing app');
    res.status(500).json({
      success: false,
      message: 'Error installing app'
    });
  }
}

/**
 * Uninstall app for user
 */
async function uninstallApp(req: Request, res: Response) {
  const { packageName } = req.params;
  const session = (req as any).userSession; // Get session from middleware
  const email = session.userId;

  if (!email || !packageName) {
    return res.status(400).json({
      success: false,
      message: 'User session and package name are required'
    });
  }

  try {
    // Find user
    const user = await User.findByEmail(email);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Remove from installed apps
    if (!user.installedApps) {
      return res.status(400).json({
        success: false,
        message: 'App is not installed'
      });
    }

    user.installedApps = user.installedApps.filter(
      app => app.packageName !== packageName
    );

    await user.save();

    res.json({
      success: true,
      message: `App ${packageName} uninstalled successfully`
    });

    // Attempt to stop the app session before uninstalling.
    try {
      const userSession = sessionService.getSession(email);
      if (userSession) {
        await webSocketService.stopAppSession(userSession, packageName);
      }
      else {
        logger.warn({ email, packageName }, 'Unable to ensure app is stopped before uninstalling, no active session');
      }
      await webSocketService.stopAppSession(session, packageName);
    } catch (error) {
      logger.warn('Error stopping app during uninstall:', error);
    }

    // Send app state change notification.
    try {
      sessionService.triggerAppStateChange(email);
    } catch (error) {
      logger.warn({ error, email }, 'Error updating client AppStateChange after uninstall');
      // Non-critical error, uninstallation succeeded, but updating client state failed.
    }

  } catch (error) {
    logger.error({ error, email, packageName }, 'Error uninstalling app');
    res.status(500).json({
      success: false,
      message: 'Error uninstalling app'
    });
  }
}

/**
 * Get installed apps for user
 */
async function getInstalledApps(req: Request, res: Response) {
  const session = (req as any).userSession; // Get session from middleware
  const email = session.userId;

  try {
    const user = await User.findByEmail(email);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Get details for all installed apps
    const installedApps = await Promise.all(
      (user.installedApps || []).map(async (installedApp) => {
        const appDetails = await appService.getApp(installedApp.packageName);
        if (!appDetails) return null;
        return {
          ...appDetails,
          installedDate: installedApp.installedDate
        };
      })
    );

    // Filter out null entries (in case an app was deleted)
    const validApps = installedApps.filter(app => app !== null);

    res.json({
      success: true,
      data: validApps
    });
  } catch (error) {
    logger.error('Error fetching installed apps:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching installed apps'
    });
  }
}

/**
 * Get app details by package name
 * Public endpoint - no authentication required
 */
async function getAppDetails(req: Request, res: Response) {
  try {
    const { packageName } = req.params;

    // Get app details and convert to plain object with lean()
    const app = await appService.getAppByPackageName(packageName);

    if (!app) {
      return res.status(404).json({
        success: false,
        message: `App with package name ${packageName} not found`
      });
    }

    // Convert to plain JavaScript object if it's a Mongoose document
    const plainApp = (app as any).toObject ? (app as any).toObject() : app;

    // If the app has a developerId, try to get the developer profile information
    let developerProfile = null;
    if (plainApp.developerId) {
      try {
        const developer = await User.findByEmail(plainApp.developerId);
        if (developer && developer.profile) {
          developerProfile = developer.profile;
        }
      } catch (err) {
        logger.error('Error fetching developer profile:', err);
        // Continue without developer profile
      }
    }

    // Create response with developer profile if available
    // Use the AppWithDeveloperProfile interface for type safety
    const appObj = plainApp as AppWithDeveloperProfile;
    if (developerProfile) {
      appObj.developerProfile = developerProfile;
    }

    // Log the permissions to verify they are properly included
    logger.debug(`App ${packageName} permissions:`, plainApp.permissions);

    res.json({
      success: true,
      data: appObj
    });
  } catch (error) {
    logger.error('Error fetching app details:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch app details'
    });
  }
};

async function getAvailableApps(req: Request, res: Response) {
  try {
    const apps = await appService.getAvailableApps();

    // Enhance apps with developer profiles
    const enhancedApps = await Promise.all(apps.map(async (app) => {
      // Convert app to plain object for modification and type as AppWithDeveloperProfile
      const appObj = { ...app } as unknown as AppWithDeveloperProfile;

      // Add developer profile if the app has a developerId
      if (app.developerId) {
        try {
          const developer = await User.findByEmail(app.developerId);
          if (developer && developer.profile) {
            appObj.developerProfile = developer.profile;
          }
        } catch (err) {
          logger.error(`Error fetching developer profile for app ${app.packageName}:`, err);
          // Continue without developer profile
        }
      }

      return appObj;
    }));

    // Return the enhanced apps with success flag
    res.json({
      success: true,
      data: enhancedApps
    });
  } catch (error) {
    logger.error('Error fetching available apps:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch available apps'
    });
  }
};

// Route Definitions
router.get('/', unifiedAuthMiddleware, getAllApps);
router.get('/public', getPublicApps);
router.get('/search', searchApps);

// App store operations - use dual-mode auth (work with or without active sessions)
router.get('/installed', dualModeAuthMiddleware, getInstalledApps);
router.post('/install/:packageName', dualModeAuthMiddleware, installApp);
router.post('/uninstall/:packageName', dualModeAuthMiddleware, uninstallApp);

// Keep backward compatibility for now (can be removed later)
// router.post('/install/:packageName/:email', installApp);
// router.post('/uninstall/:packageName/:email', uninstallApp);
// router.get('/install/:packageName/:email', installApp);
// router.get('/uninstall/:packageName/:email', uninstallApp);

router.get('/version', async (req, res) => {
  res.json({ version: CLOUD_VERSION });
});

router.get('/available', getAvailableApps);
router.get('/:packageName', getAppByPackage);

// Device-specific operations - use unified auth
router.post('/:packageName/start', unifiedAuthMiddleware, startApp);
router.post('/:packageName/stop', unifiedAuthMiddleware, stopApp);

// Helper to enhance apps with running/foreground state
/**
 * Enhances a list of apps (SDK AppI or local AppI) with running/foreground state.
 * Accepts AppI[] from either @augmentos/sdk or local model.
 */
function enhanceAppsWithSessionState(apps: any[], userSessions: any[]): EnhancedAppI[] {
  const plainApps = apps.map(app => {
    return (app as any).toObject?.() || app;
  });
  return plainApps.map(app => {
    const enhancedApp: EnhancedAppI = {
      ...app,
      is_running: false,
      is_foreground: false
    };
    if (userSessions && userSessions.length > 0) {
      const isRunning = userSessions.some(session =>
        session.activeAppSessions && session.activeAppSessions.includes(app.packageName)
      );
      enhancedApp.is_running = isRunning;
      if (isRunning) {
        const isForeground = userSessions.some(session =>
          (session as any).foregroundAppPackageName === app.packageName ||
          (session as any).foregroundApp === app.packageName
        );
        enhancedApp.is_foreground = isForeground;
      }
    }
    return enhancedApp;
  });
}

export default router;
