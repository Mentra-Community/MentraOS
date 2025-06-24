// cloud/src/routes/apps.routes.ts
import express, { Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';

// Extend Request type to include pino-http's log property
declare global {
  namespace Express {
    interface Request {
      log: Logger;
    }
  }
}
import webSocketService from '../services/websocket/websocket.service';
import sessionService from '../services/session/session.service';
import appService, { isUninstallable } from '../services/core/app.service';
import { User } from '../models/user.model';
import App, { AppI } from '../models/app.model';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { DeveloperProfile, TpaType } from '@mentra/sdk';
import { logger as rootLogger } from '../services/logging/pino-logger';
import UserSession from '../services/session/UserSession';
import { authWithOptionalSession, OptionalUserSessionRequest } from '../middleware/client/client-auth-middleware';
import dotenv from 'dotenv';
dotenv.config(); // Load environment variables from .env file

const SERVICE_NAME = 'apps.routes';
const logger = rootLogger.child({ service: SERVICE_NAME });

// Extended app interface for API responses that include developer profile
interface AppWithDeveloperProfile extends AppI {
  developerProfile?: DeveloperProfile;
  orgName?: string; // Organization name
}

// Enhanced app interface with running state properties
interface EnhancedAppI extends AppI {
  is_running?: boolean;
  is_foreground?: boolean;
  lastActiveAt?: Date;
}

// Enhanced app with both developer profile and running state
interface EnhancedAppWithDeveloperProfile extends AppWithDeveloperProfile {
  is_running?: boolean;
  is_foreground?: boolean;
  lastActiveAt?: Date;
}

// This is annyoing to change in the env files everywhere for each region so we set it here.
export const CLOUD_VERSION = "2.1.16"; //process.env.CLOUD_VERSION;
if (!CLOUD_VERSION) {
  logger.error('CLOUD_VERSION is not set');
}

// Allowed package names for API key authentication
const ALLOWED_API_KEY_PACKAGES = ['test.augmentos.mira', 'cloud.augmentos.mira', 'com.augmentos.mira'];

const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";
if (!AUGMENTOS_AUTH_JWT_SECRET) {
  logger.error('AUGMENTOS_AUTH_JWT_SECRET is not set');
}

/**
 * TODO(isaiah): Instead of having a unifiedAuthMiddleware, I would prefer to cleanly separate routes that are called
 * by either the client (mobile app, web app, etc.), system apps, or the TPA's (third-party applications), having a more clear separation of concerns.
 * This way we would be able to log, track, and debug defined actions more clearly.
 */
/**
 * Unified authentication middleware: allows either
 * (1) apiKey + packageName + userId (for allowed TPAs), or
 * (2) core token in Authorization header (for user sessions)
 */
async function unifiedAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  // Use req.log from pino-http with middleware context
  const middlewareLogger = req.log.child({
    service: SERVICE_NAME,
    middleware: 'unifiedAuth',
    route: req.route?.path || req.path,
    method: req.method
  });

  const startTime = Date.now();

  // DEBUG: Middleware entry
  middlewareLogger.debug({
    hasApiKey: !!req.query.apiKey,
    hasPackageName: !!req.query.packageName,
    hasUserId: !!req.query.userId,
    hasAuthHeader: !!req.headers.authorization,
    authMethod: req.query.apiKey ? 'apiKey' : req.headers.authorization ? 'bearer' : 'none'
  }, 'Unified auth middleware called');

  // Option 1: API key authentication
  const apiKey = req.query.apiKey as string;
  const packageName = req.query.packageName as string;
  const userId = req.query.userId as string;

  if (apiKey && packageName && userId) {
    middlewareLogger.debug({ packageName, userId }, 'Attempting API key authentication');

    if (!ALLOWED_API_KEY_PACKAGES.includes(packageName)) {
      const duration = Date.now() - startTime;
      middlewareLogger.warn({
        packageName,
        userId,
        duration,
        allowedPackages: ALLOWED_API_KEY_PACKAGES
      }, 'Package name not in allowed list');

      return res.status(403).json({
        success: false,
        message: 'Unauthorized package name'
      });
    }

    const validationStartTime = Date.now();
    const isValid = await appService.validateApiKey(packageName, apiKey);
    const validationDuration = Date.now() - validationStartTime;

    middlewareLogger.debug({
      packageName,
      userId,
      validationDuration,
      isValid
    }, `API key validation completed in ${validationDuration}ms`);

    if (isValid) {
      // Only allow if a full session exists
      const userSession = UserSession.getById(userId);
      if (userSession) {
        const duration = Date.now() - startTime;
        middlewareLogger.info({
          packageName,
          userId,
          duration,
          authMethod: 'apiKey',
          sessionId: userSession.sessionId
        }, `API key auth successful in ${duration}ms`);

        (req as any).userSession = userSession;
        return next();
      } else {
        const duration = Date.now() - startTime;
        middlewareLogger.error({
          packageName,
          userId,
          duration
        }, 'Valid API key but no active session found');

        return res.status(401).json({
          success: false,
          message: 'No active session found for user.'
        });
      }
    } else {
      const duration = Date.now() - startTime;
      middlewareLogger.error({
        packageName,
        userId,
        duration,
        validationDuration
      }, 'Invalid API key provided');

      return res.status(401).json({
        success: false,
        message: 'Invalid API key for package.'
      });
    }
  }

  // Option 2: Core token authentication
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    middlewareLogger.debug('Attempting Bearer token authentication');

    const token = authHeader.substring(7);
    const tokenStartTime = Date.now();

    try {
      const session = await getSessionFromToken(token);
      const tokenDuration = Date.now() - tokenStartTime;

      if (session) {
        (req as any).userSession = session;
        return next();
      } else {
        const duration = Date.now() - startTime;
        middlewareLogger.warn({
          duration,
          tokenDuration
        }, 'Valid token but no session found');
      }
    } catch (error) {
      const tokenDuration = Date.now() - tokenStartTime;
      const duration = Date.now() - startTime;
      middlewareLogger.warn({
        error: error instanceof Error ? {
          name: error.name,
          message: error.message
        } : error,
        duration,
        tokenDuration
      }, 'Bearer token validation failed');
      // fall through to error below
    }
  }

  // If neither auth method worked
  const duration = Date.now() - startTime;
  middlewareLogger.error({
    duration,
    hasApiKey: !!apiKey,
    hasAuthHeader: !!authHeader,
    requestPath: req.path,
    requestMethod: req.method
  }, `Authentication failed - no valid auth method found after ${duration}ms`);

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
    const userSession = UserSession.getById(userId) || null;;
    return userSession;
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
// async function dualModeAuthMiddleware(req: Request, res: Response, next: NextFunction) {
//   // Check for Authorization header
//   const authHeader = req.headers.authorization;

//   if (authHeader && authHeader.startsWith('Bearer ')) {
//     const token = authHeader.substring(7); // Remove 'Bearer ' prefix
//     // Try to get full session
//     const session = await getSessionFromToken(token);
//     if (session) {
//       (req as any).userSession = session;
//       next();
//       return;
//     }
//   }

//   // Fall back to sessionId in body (for full session only)
//   if (req.body && req.body.sessionId) {
//     const session = sessionService.getSession(req.body.sessionId);
//     if (session) {
//       (req as any).userSession = session;
//       next();
//       return;
//     }
//   }

//   // No valid authentication found
//   res.status(401).json({
//     success: false,
//     message: 'Authentication required. Please provide valid token or session ID with an active session.'
//   });
// }


const router = express.Router();

// Route Handlers
/**
 * Get all available apps
 */
async function getAllApps(req: Request, res: Response) {
  try {
    // console.log('getAllApps');
    // Check API key auth first
    const apiKey = req.query.apiKey as string;
    const packageName = req.query.packageName as string;
    const userId = req.query.userId as string;

    if (apiKey && packageName && userId) {
      // Already authenticated via middleware
      const apps = await appService.getAllApps(userId);
      const userSession = UserSession.getById(userId);
      if (!userSession) {
        return res.status(401).json({
          success: false,
          message: 'No active session found for user.'
        });
      }

      // Get user data for last active timestamps
      const user = await User.findByEmail(userId);
      const enhancedApps = enhanceAppsWithSessionState(apps, userSession, user);
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
    // const userSessions = sessionService.getSessionsForUser(tokenUserId);
    const userSession: UserSession = (req as any).userSession;
    // Get user data for last active timestamps
    const user = await User.findByEmail(tokenUserId);
    const enhancedApps = enhanceAppsWithSessionState(apps, userSession, user);
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
    const organizationId = req.query.organizationId as string;

    if (!query) {
      return res.status(400).json({
        success: false,
        message: 'Search query is required'
      });
    }

    const apps = await appService.getAllApps();

    // First filter by search query
    let searchResults = apps.filter(app =>
      app.name.toLowerCase().includes(query.toLowerCase()) ||
      (app.description && app.description.toLowerCase().includes(query.toLowerCase()))
    );

    // Then filter by organization if specified
    if (organizationId) {
      searchResults = searchResults.filter(app =>
        app.organizationId && app.organizationId.toString() === organizationId
      );

      logger.debug(`Filtered search results by organizationId: ${organizationId}, found ${searchResults.length} results`);
    }

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

    // If the app has an organizationId, get the organization profile information
    let orgProfile = null;

    try {
      if (plainApp.organizationId) {
        // Import Organization model
        const Organization = require('../models/organization.model').Organization;
        const org = await Organization.findById(plainApp.organizationId);
        if (org) {
          orgProfile = {
            name: org.name,
            profile: org.profile || {}
          };
        }
      }
      // Fallback to developer profile for backward compatibility
      else if (plainApp.developerId) {
        const developer = await User.findByEmail(plainApp.developerId);
        if (developer && developer.profile) {
          orgProfile = {
            name: developer.profile.company || developer.email.split('@')[0],
            profile: developer.profile
          };
        }
      }
    } catch (err) {
      logger.error({ error: err, orgId: plainApp.organizationId, developerId: plainApp.developerId },
        'Error fetching organization/developer profile');
      // Continue without profile
    }

    // Create response with organization profile if available
    // Use the plain app directly instead of spreading its properties
    const appObj = plainApp as AppWithDeveloperProfile;
    if (orgProfile) {
      appObj.developerProfile = orgProfile.profile;
      appObj.orgName = orgProfile.name;
    }

    // Add uninstallable property for store frontend
    (appObj as any).uninstallable = isUninstallable(packageName);

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
  // console.log('@#$%^&#@42342 startApp', packageName);
  const userSession: UserSession = (req as any).userSession;

  // Use req.log from pino-http with service context
  const routeLogger = req.log.child({
    service: SERVICE_NAME,
    userId: userSession.userId,
    packageName,
    route: 'POST /apps/:packageName/start',
    sessionId: userSession.sessionId
  });

  const startTime = Date.now();

  // INFO: Route entry
  routeLogger.info({
    sessionState: {
      websocketConnected: userSession.websocket?.readyState === WebSocket.OPEN,
      runningAppsCount: userSession.runningApps.size,
      loadingAppsCount: userSession.loadingApps.size
    }
  }, `Starting app ${packageName} for user ${userSession.userId}`);

  // DEBUG: Detailed context
  routeLogger.debug({
    detailedSessionState: {
      runningApps: Array.from(userSession.runningApps),
      loadingApps: Array.from(userSession.loadingApps),
      installedAppsCount: userSession.installedApps.size,
      appWebsocketsCount: userSession.appWebsockets.size
    }
  }, 'Route entry context');

  try {
    // Validate that the app exists before attempting to start it
    const app = await appService.getApp(packageName);
    if (!app) {
      const totalDuration = Date.now() - startTime;
      routeLogger.error({
        totalDuration
      }, `App ${packageName} not found in database`);

      return res.status(404).json({
        success: false,
        message: 'App not found'
      });
    }

    // WARN: Already running (weird but we handle gracefully)
    if (userSession.runningApps.has(packageName)) {
      routeLogger.warn('App already in runningApps before startApp call');
    }

    // WARN: Already loading (weird but we handle gracefully)
    if (userSession.loadingApps.has(packageName)) {
      routeLogger.warn('App already in loadingApps before startApp call');
    }

    // DEBUG: AppManager call
    routeLogger.debug('Calling userSession.appManager.startApp()');
    const appManagerStartTime = Date.now();

    const result = await userSession.appManager.startApp(packageName);
    const appManagerDuration = Date.now() - appManagerStartTime;

    // DEBUG: AppManager result
    routeLogger.debug({
      appManagerResult: result,
      appManagerDuration,
      postStartState: {
        isNowRunning: userSession.runningApps.has(packageName),
        isStillLoading: userSession.loadingApps.has(packageName),
        hasWebsocket: userSession.appWebsockets.has(packageName)
      }
    }, `AppManager.startApp completed in ${appManagerDuration}ms`);

    // DEBUG: Broadcast call
    routeLogger.debug('Calling userSession.appManager.broadcastAppState()');
    const broadcastStartTime = Date.now();

    const appStateChange = userSession.appManager.broadcastAppState();
    const broadcastDuration = Date.now() - broadcastStartTime;

    // DEBUG: Broadcast result
    routeLogger.debug({
      broadcastDuration,
      appStateChangeGenerated: !!appStateChange,
      appStateChangeSize: appStateChange ? JSON.stringify(appStateChange).length : 0
    }, `App state broadcast completed in ${broadcastDuration}ms`);

    // ERROR: This shouldn't happen - broadcast should always work
    if (!appStateChange) {
      const totalDuration = Date.now() - startTime;
      routeLogger.error({
        totalDuration,
        sessionState: {
          websocketReady: userSession.websocket?.readyState === WebSocket.OPEN,
          runningApps: Array.from(userSession.runningApps),
          loadingApps: Array.from(userSession.loadingApps)
        }
      }, 'Broadcast failed to generate app state change - this should not happen');

      return res.status(500).json({
        success: false,
        message: 'Error generating app state change'
      });
    }

    const totalDuration = Date.now() - startTime;

    // INFO: Successful completion
    routeLogger.info({
      totalDuration,
      success: result.success
    }, `App start completed in ${totalDuration}ms`);

    // DEBUG: Final state details
    routeLogger.debug({
      appManagerDuration,
      broadcastDuration,
      finalState: {
        runningApps: Array.from(userSession.runningApps),
        loadingApps: Array.from(userSession.loadingApps)
      }
    }, 'Route completion details');

    res.json({
      success: true,
      data: {
        status: 'started',
        packageName,
        appState: appStateChange
      }
    });

  } catch (error) {
    const totalDuration = Date.now() - startTime;

    // ERROR: Route execution failed
    routeLogger.error({
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : error,
      totalDuration
    }, `Route failed after ${totalDuration}ms`);

    // DEBUG: Error context for debugging
    routeLogger.debug({
      sessionStateOnError: {
        websocketState: userSession.websocket?.readyState,
        runningApps: Array.from(userSession.runningApps),
        loadingApps: Array.from(userSession.loadingApps),
        appWebsockets: Array.from(userSession.appWebsockets.keys())
      },
      requestContext: {
        method: req.method,
        url: req.url,
        userAgent: req.headers['user-agent']
      }
    }, 'Error context details');

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
  const userSession: UserSession = (req as any).userSession;

  // Use req.log from pino-http with service context
  const routeLogger = req.log.child({
    service: SERVICE_NAME,
    userId: userSession?.userId,
    packageName,
    route: 'POST /apps/:packageName/stop',
    sessionId: userSession?.sessionId
  });

  const startTime = Date.now();

  // INFO: Route entry
  routeLogger.info({
    isCurrentlyRunning: userSession?.runningApps?.has(packageName),
    runningAppsCount: userSession?.runningApps?.size || 0
  }, `Stopping app ${packageName} for user ${userSession?.userId || 'unknown'}`);

  // ERROR: Missing user session (shouldn't happen due to middleware)
  if (!userSession || !userSession.userId) {
    routeLogger.error({
      userSessionExists: !!userSession,
      userIdExists: !!userSession?.userId
    }, 'User session validation failed - middleware issue');

    return res.status(401).json({
      success: false,
      message: 'User session is required'
    });
  }

  // DEBUG: Session state details
  routeLogger.debug({
    sessionState: {
      websocketConnected: userSession.websocket?.readyState === WebSocket.OPEN,
      isCurrentlyLoading: userSession.loadingApps.has(packageName),
      hasWebsocketConnection: userSession.appWebsockets.has(packageName),
      runningApps: Array.from(userSession.runningApps),
      loadingApps: Array.from(userSession.loadingApps)
    }
  }, 'Stop app route context');

  try {
    // DEBUG: App lookup
    routeLogger.debug('Looking up app in database');
    const appLookupStart = Date.now();

    const app = await appService.getApp(packageName);
    const appLookupDuration = Date.now() - appLookupStart;

    // DEBUG: App lookup result
    routeLogger.debug({
      appLookupDuration,
      appFound: !!app
    }, `App lookup completed in ${appLookupDuration}ms`);

    // ERROR: App not found (shouldn't happen for valid requests)
    if (!app) {
      const totalDuration = Date.now() - startTime;
      routeLogger.error({
        totalDuration
      }, `App ${packageName} not found in database`);

      return res.status(404).json({
        success: false,
        message: 'App not found'
      });
    }

    // WARN: App not running (weird but we handle gracefully)
    if (!userSession.runningApps.has(packageName) && !userSession.loadingApps.has(packageName)) {
      routeLogger.warn('App not in runningApps or loadingApps but stop requested');
    }

    // DEBUG: AppManager stop call
    routeLogger.debug('Calling userSession.appManager.stopApp()');
    const stopStartTime = Date.now();

    await userSession.appManager.stopApp(packageName);
    const stopDuration = Date.now() - stopStartTime;

    // DEBUG: Stop result
    routeLogger.debug({
      stopDuration,
      postStopState: {
        isStillRunning: userSession.runningApps.has(packageName),
        isStillLoading: userSession.loadingApps.has(packageName),
        stillHasWebsocket: userSession.appWebsockets.has(packageName)
      }
    }, `AppManager.stopApp completed in ${stopDuration}ms`);

    // DEBUG: Broadcast call
    routeLogger.debug('Calling userSession.appManager.broadcastAppState()');
    const broadcastStartTime = Date.now();

    const appStateChange = userSession.appManager.broadcastAppState();
    const broadcastDuration = Date.now() - broadcastStartTime;

    // DEBUG: Broadcast result
    routeLogger.debug({
      broadcastDuration,
      appStateChangeGenerated: !!appStateChange
    }, `App state broadcast completed in ${broadcastDuration}ms`);

    // ERROR: Broadcast failed (shouldn't happen)
    if (!appStateChange) {
      const totalDuration = Date.now() - startTime;
      routeLogger.error({
        totalDuration
      }, 'Failed to generate app state change - this should not happen');

      return res.status(500).json({
        success: false,
        message: 'Error generating app state change'
      });
    }

    const totalDuration = Date.now() - startTime;

    // INFO: Successful completion
    routeLogger.info({
      totalDuration
    }, `App stop completed in ${totalDuration}ms`);

    // DEBUG: Timing breakdown
    routeLogger.debug({
      appLookupDuration,
      stopDuration,
      broadcastDuration
    }, 'Route timing breakdown');

    res.json({
      success: true,
      data: {
        status: 'stopped',
        packageName,
        appState: appStateChange
      }
    });

  } catch (error) {
    const totalDuration = Date.now() - startTime;

    // ERROR: Route execution failed
    routeLogger.error({
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : error,
      totalDuration
    }, `Route failed after ${totalDuration}ms`);

    // DEBUG: Error context
    routeLogger.debug({
      sessionStateOnError: {
        runningApps: Array.from(userSession.runningApps),
        loadingApps: Array.from(userSession.loadingApps),
        appWebsockets: Array.from(userSession.appWebsockets.keys())
      }
    }, 'Error context details');

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
  const request = req as OptionalUserSessionRequest;

  const { packageName } = req.params;
  const userSession = request.userSession; // Get optional userSession from middleware
  const email = request.email; // Get email from request
  const user = request.user; // Get user from middleware

  try {
    if (!email || !packageName) {
      return res.status(400).json({
        success: false,
        message: 'User session and package name are required'
      });
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Get app details
    const app = await appService.getApp(packageName);
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
    await user.installApp(packageName);

    res.json({
      success: true,
      message: `App ${packageName} installed successfully`
    });

    // If there's an active userSession, update the session with the new app.
    try {
      // sessionService.triggerAppStateChange(email);
      if (userSession) {
        userSession.appManager.broadcastAppState();
      }
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
  const request = req as OptionalUserSessionRequest;
  const { packageName } = req.params;

  try {
    // Find user
    const userSession = request.userSession; // Get userSession from middleware
    const user = request.user; // Get user from middleware
    const email = request.email; // Get email from request

    if (!email || !packageName) {
      return res.status(400).json({
        success: false,
        message: 'User session and package name are required'
      });
    }

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
      if (userSession) {
        // TODO(isaiah): Ensure this automatically triggers appstate change sent to client.
        await userSession.appManager.stopApp(packageName);
        await userSession.appManager.broadcastAppState();
      }
      else {
        logger.warn({ email, packageName }, 'Unable to ensure app is stopped before uninstalling, no active session');
      }
    } catch (error) {
      logger.warn('Error stopping app during uninstall:', error);
    }
  } catch (error) {
    logger.error({ error, userId: request.email, packageName }, 'Error uninstalling app');
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
  const request = req as OptionalUserSessionRequest;

  try {
    const user = request.user;
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // TODO(isaiah): There's a better way to get list of all apps from MongoDB that doesn't spam DB with fetching one at a time.
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

    // If the app has an organizationId, get the organization profile information
    let orgProfile = null;

    try {
      if (plainApp.organizationId) {
        // Import Organization model
        const Organization = require('../models/organization.model').Organization;
        const org = await Organization.findById(plainApp.organizationId);
        if (org) {
          orgProfile = {
            name: org.name,
            profile: org.profile || {}
          };
        }
      }
      // Fallback to developer profile for backward compatibility
      else if (plainApp.developerId) {
        const developer = await User.findByEmail(plainApp.developerId);
        if (developer && developer.profile) {
          orgProfile = {
            name: developer.profile.company || developer.email.split('@')[0],
            profile: developer.profile
          };
        }
      }
    } catch (err) {
      logger.error('Error fetching organization/developer profile:', err);
      // Continue without profile
    }

    // Create response with organization/developer profile if available
    // Use the AppWithDeveloperProfile interface for type safety
    const appObj = plainApp as AppWithDeveloperProfile;
    if (orgProfile) {
      appObj.developerProfile = orgProfile.profile;
      appObj.orgName = orgProfile.name;
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
    const organizationId = req.query.organizationId as string;
    let apps = await appService.getAvailableApps();

    // Filter by organization if specified
    if (organizationId) {
      apps = apps.filter(app =>
        app.organizationId && app.organizationId.toString() === organizationId
      );

      logger.debug(`Filtered available apps by organizationId: ${organizationId}, found ${apps.length} apps`);
    }

    // Enhance apps with organization profiles
    const enhancedApps = await Promise.all(apps.map(async (app) => {
      // Convert app to plain object for modification and type as AppWithDeveloperProfile
      const appObj = { ...app } as unknown as AppWithDeveloperProfile;

      // Add organization profile if the app has an organizationId
      try {
        if (app.organizationId) {
          const Organization = require('../models/organization.model').Organization;
          const org = await Organization.findById(app.organizationId);
          if (org) {
            appObj.developerProfile = org.profile || {};
            appObj.orgName = org.name;
          }
        }
        // Fallback to developer profile for backward compatibility
        else if (app.developerId) {
          const developer = await User.findByEmail(app.developerId);
          if (developer && developer.profile) {
            appObj.developerProfile = developer.profile;
            appObj.orgName = developer.profile.company || developer.email.split('@')[0];
          }
        }
      } catch (err) {
        logger.error(`Error fetching profile for app ${app.packageName}:`, err);
        // Continue without profile
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

// [DEPRECATED] dualModeAuthMiddleware no longer exists.
//  Use authWithEmail, authWithUser, authWithSession or authWithOptionalSession instead. from middleware/client/client-auth-middleware.ts

// App store operations - use dual-mode auth (work with or without active sessions)
// router.get('/installed', dualModeAuthMiddleware, getInstalledApps);
// router.post('/install/:packageName', dualModeAuthMiddleware, installApp);
// router.post('/uninstall/:packageName', dualModeAuthMiddleware, uninstallApp);

// TODO(isaiah): move appstore only
// App store operations - use client-auth-middleware.ts
router.get('/installed', authWithOptionalSession, getInstalledApps);
router.post('/install/:packageName', authWithOptionalSession, installApp);
router.post('/uninstall/:packageName', authWithOptionalSession, uninstallApp);

router.get('/version', async (req, res) => {
  res.json({ version: CLOUD_VERSION });
});

router.get('/available', getAvailableApps);
router.get('/:packageName', getAppByPackage);

// Device-specific operations - use unified auth
router.post('/:packageName/start', unifiedAuthMiddleware, startApp);
router.post('/:packageName/stop', unifiedAuthMiddleware, stopApp);

// Helper to enhance apps with running/foreground state and activity data
/**
 * Enhances a list of apps (SDK AppI or local AppI) with running/foreground state and last active timestamp.
 * Accepts AppI[] from either @mentra/sdk or local model.
 */
function enhanceAppsWithSessionState(apps: AppI[], userSession: UserSession, user?: any): EnhancedAppI[] {
  const plainApps = apps.map(app => {
    return (app as any).toObject?.() || app;
  });

  return plainApps.map(app => {
    const enhancedApp: EnhancedAppI = {
      ...app,
      is_running: false,
      is_foreground: false
    };

    enhancedApp.is_running = userSession.runningApps.has(app.packageName);
    if (enhancedApp.is_running) {
      enhancedApp.is_foreground = app.tpaType === TpaType.STANDARD;;
    }

    // Add last active timestamp if user data is available
    if (user && user.installedApps) {
      const installedApp = user.installedApps.find((installed: any) => installed.packageName === app.packageName);
      if (installedApp && installedApp.lastActiveAt) {
        enhancedApp.lastActiveAt = installedApp.lastActiveAt;
      }
    }

    return enhancedApp;
  });
}

export default router;
