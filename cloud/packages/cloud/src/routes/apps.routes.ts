// cloud/src/routes/apps.routes.ts
import express, { Request, Response, NextFunction } from "express";
import webSocketService from "../services/websocket/websocket.service";
import appService, { isUninstallable } from "../services/core/app.service";
import { User } from "../models/user.model";
import { AppI } from "../models/app.model";
import jwt, { JwtPayload } from "jsonwebtoken";
import { DeveloperProfile, AppType } from "@mentra/sdk";
import { logger as rootLogger } from "../services/logging/pino-logger";
import * as AppUptimeService from "../services/core/app-uptime.service";
import UserSession from "../services/session/UserSession";
import {
  authWithOptionalSession,
  optionalAuthWithOptionalSession,
  RequestWithOptionalUserSession,
} from "../middleware/client/client-auth-middleware";
import { HardwareCompatibilityService } from "../services/session/HardwareCompatibilityService";
import dotenv from "dotenv";
import Organization from "../models/organization.model";
import { CLIENT_VERSIONS } from "../version";
dotenv.config(); // Load environment variables from .env file

const SERVICE_NAME = "apps.routes";
const logger = rootLogger.child({ service: SERVICE_NAME });

// This is annyoing to change in the env files everywhere for each region so we set it here.
export const CLOUD_VERSION = CLIENT_VERSIONS.required; // e.g. "2.1.16"
if (!CLOUD_VERSION) {
  logger.error("CLOUD_VERSION is not set");
}

// Allowed package names for API key authentication
const ALLOWED_API_KEY_PACKAGES = [
  "test.augmentos.mira",
  "cloud.augmentos.mira",
  "com.augmentos.mira",
  "com.mentra.mentraai.beta",
  // "com.mentra.mentraai.dev",  //later
  // "com.mentra.mentraai" //later

];

const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";
if (!AUGMENTOS_AUTH_JWT_SECRET) {
  logger.error("AUGMENTOS_AUTH_JWT_SECRET is not set");
}

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

/**
 * TODO(isaiah): Instead of having a unifiedAuthMiddleware, I would prefer to cleanly separate routes that are called
 * by either the client (mobile app, web app, etc.), system apps, or the App's (third-party applications), having a more clear separation of concerns.
 * This way we would be able to log, track, and debug defined actions more clearly.
 */
/**
 * Unified authentication middleware: allows either
 * (1) apiKey + packageName + userId (for allowed Apps), or
 * (2) core token in Authorization header (for user sessions)
 */
async function unifiedAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // Use req.log from pino-http with middleware context
  const middlewareLogger = req.log.child({
    service: SERVICE_NAME,
    middleware: "unifiedAuth",
    route: req.route?.path || req.path,
    method: req.method,
  });

  const startTime = Date.now();

  // Option 1: API key authentication
  const apiKey = req.query.apiKey as string;
  const packageName = req.query.packageName as string;
  const userId = req.query.userId as string;

  if (apiKey && packageName && userId) {
    // middlewareLogger.debug({ packageName, userId }, 'Attempting API key authentication');

    if (!ALLOWED_API_KEY_PACKAGES.includes(packageName)) {
      const duration = Date.now() - startTime;
      middlewareLogger.warn(
        {
          packageName,
          userId,
          duration,
          allowedPackages: ALLOWED_API_KEY_PACKAGES,
        },
        "Package name not in allowed list",
      );

      return res.status(403).json({
        success: false,
        message: "Unauthorized package name",
      });
    }

    const validationStartTime = Date.now();
    const isValid = await appService.validateApiKey(packageName, apiKey);
    const validationDuration = Date.now() - validationStartTime;

    if (isValid) {
      // Only allow if a full session exists
      const userSession = UserSession.getById(userId);
      if (userSession) {
        (req as any).userSession = userSession;
        return next();
      } else {
        const duration = Date.now() - startTime;
        middlewareLogger.error(
          {
            packageName,
            userId,
            duration,
          },
          "Valid API key but no active session found",
        );

        return res.status(401).json({
          success: false,
          message: "No active session found for user.",
        });
      }
    } else {
      const duration = Date.now() - startTime;
      middlewareLogger.error(
        {
          packageName,
          userId,
          duration,
          validationDuration,
        },
        "Invalid API key provided",
      );

      return res.status(401).json({
        success: false,
        message: "Invalid API key for package.",
      });
    }
  }

  // Option 2: Core token authentication
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    middlewareLogger.debug("Attempting Bearer token authentication");

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
        middlewareLogger.warn(
          {
            duration,
            tokenDuration,
          },
          "Valid token but no session found",
        );
      }
    } catch (error) {
      const tokenDuration = Date.now() - tokenStartTime;
      const duration = Date.now() - startTime;
      middlewareLogger.warn(
        {
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                }
              : error,
          duration,
          tokenDuration,
        },
        "Bearer token validation failed",
      );
      // fall through to error below
    }
  }

  // If neither auth method worked
  const duration = Date.now() - startTime;
  middlewareLogger.error(
    {
      duration,
      hasApiKey: !!apiKey,
      hasAuthHeader: !!authHeader,
      requestPath: req.path,
      requestMethod: req.method,
    },
    `Authentication failed - no valid auth method found after ${duration}ms`,
  );

  return res.status(401).json({
    success: false,
    message:
      "Authentication required. Provide either apiKey, packageName, userId or a valid core token with an active session.",
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
    const userSession = UserSession.getById(userId) || null;
    return userSession;
  } catch (error) {
    logger.error(error, "Error verifying token or finding session:");
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
    logger.error(error, "Error verifying token:");
    return null;
  }
}

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
          message: "No active session found for user.",
        });
      }

      // Add hardware compatibility information to each app
      const appsWithCompatibility = apps.map((app) => {
        let compatibilityInfo = null;
        const caps = userSession.deviceManager.getCapabilities();
        if (caps) {
          const compatibilityResult =
            HardwareCompatibilityService.checkCompatibility(app, caps);

          compatibilityInfo = {
            isCompatible: compatibilityResult.isCompatible,
            missingRequired: compatibilityResult.missingRequired.map((req) => ({
              type: req.type,
              description: req.description,
            })),
            missingOptional: compatibilityResult.missingOptional.map((req) => ({
              type: req.type,
              description: req.description,
            })),
            message:
              HardwareCompatibilityService.getCompatibilityMessage(
                compatibilityResult,
              ),
          };
        }

        return {
          ...((app as any).toObject?.() || app),
          compatibility: compatibilityInfo,
        };
      });

      // Get user data for last active timestamps
      const user = await User.findByEmail(userId);
      const enhancedApps = enhanceAppsWithSessionState(
        appsWithCompatibility,
        userSession,
        user,
      );

      // Enrich with organization/developer profile and display name
      let finalApps = enhancedApps as any[];
      try {
        finalApps = await batchEnrichAppsWithProfiles(enhancedApps as any[]);
      } catch (e) {
        logger.warn(
          { e },
          "Failed to enrich apps with organization/developer profile (apiKey branch)",
        );
      }

      // Attach latest online status for each app
      try {
        const packageNames = finalApps.map((a: any) => a.packageName);
        const latestStatuses =
          await AppUptimeService.getLatestStatusesForPackages(packageNames);
        const statusMap = new Map<string, boolean>(
          latestStatuses.map((s) => [s.packageName, Boolean(s.onlineStatus)]),
        );
        for (const app of finalApps as any[]) {
          (app as any).isOnline = statusMap.get(app.packageName);
        }
      } catch (e) {
        logger.warn(
          { e },
          "Failed to attach latest online statuses (apiKey branch)",
        );
      }

      return res.json({
        success: true,
        data: finalApps,
      });
    }

    // Fall back to token auth
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message:
          "Authentication required. Please provide valid token or API key.",
      });
    }

    // Get the user ID from the token
    const token = authHeader.substring(7);
    const tokenUserId = await getUserIdFromToken(token);

    if (!tokenUserId) {
      return res.status(401).json({
        success: false,
        message: "User ID is required (via token or userId param)",
      });
    }

    const apps = await appService.getAllApps(tokenUserId);
    // const userSessions = sessionService.getSessionsForUser(tokenUserId);
    const userSession: UserSession = (req as any).userSession;

    // Add hardware compatibility information to each app
    const appsWithCompatibility = apps.map((app) => {
      let compatibilityInfo = null;
      if (userSession && userSession.deviceManager.getCapabilities()) {
        const compatibilityResult =
          HardwareCompatibilityService.checkCompatibility(
            app,
            userSession.deviceManager.getCapabilities(),
          );

        compatibilityInfo = {
          isCompatible: compatibilityResult.isCompatible,
          missingRequired: compatibilityResult.missingRequired.map((req) => ({
            type: req.type,
            description: req.description,
          })),
          missingOptional: compatibilityResult.missingOptional.map((req) => ({
            type: req.type,
            description: req.description,
          })),
          message:
            HardwareCompatibilityService.getCompatibilityMessage(
              compatibilityResult,
            ),
        };
      }

      return {
        ...((app as any).toObject?.() || app),
        compatibility: compatibilityInfo,
      };
    });

    // Get user data for last active timestamps
    const user = await User.findByEmail(tokenUserId);
    const enhancedApps = enhanceAppsWithSessionState(
      appsWithCompatibility,
      userSession,
      user,
    );

    // Enrich with organization/developer profile and display name
    let finalApps = enhancedApps as any[];
    try {
      finalApps = await batchEnrichAppsWithProfiles(enhancedApps as any[]);
    } catch (e) {
      logger.warn(
        { e },
        "Failed to enrich apps with organization/developer profile",
      );
    }

    // Attach latest online status for each app
    try {
      const packageNames = finalApps.map((a: any) => a.packageName);
      const latestStatuses =
        await AppUptimeService.getLatestStatusesForPackages(packageNames);
      const statusMap = new Map<string, boolean>(
        latestStatuses.map((s) => [s.packageName, Boolean(s.onlineStatus)]),
      );
      for (const app of finalApps as any[]) {
        (app as any).isOnline = statusMap.get(app.packageName);
      }
    } catch (e) {
      logger.warn({ e }, "Failed to attach latest online statuses");
    }

    res.json({
      success: true,
      data: finalApps,
    });
  } catch (error) {
    logger.error(error, "Error fetching apps");
    res.status(500).json({
      success: false,
      message: "Error fetching apps",
    });
  }
}

/**
 * Get public apps
 */
async function getPublicApps(req: Request, res: Response) {
  const request = req as RequestWithOptionalUserSession;

  try {
    let apps = await appService.getAllApps();

    // Filter apps by hardware compatibility if user has connected glasses
    const caps = request.userSession?.deviceManager.getCapabilities();
    if (request.userSession && caps) {
      apps = HardwareCompatibilityService.filterCompatibleApps(
        apps,
        caps,
        true, // Include apps with missing optional hardware
      );
    }

    res.json({
      success: true,
      data: apps,
    });
  } catch (error) {
    logger.error(error, "Error fetching public apps");
    res.status(500).json({
      success: false,
      message: "Error fetching public apps",
    });
  }
}

/**
 * Search apps by query
 */
async function searchApps(req: Request, res: Response) {
  const request = req as RequestWithOptionalUserSession;

  try {
    const query = req.query.q as string;
    const organizationId = req.query.organizationId as string;

    if (!query) {
      return res.status(400).json({
        success: false,
        message: "Search query is required",
      });
    }

    const apps = await appService.getAllApps();

    // First filter by search query
    let searchResults = apps.filter(
      (app) =>
        app.name.toLowerCase().includes(query.toLowerCase()) ||
        (app.description &&
          app.description.toLowerCase().includes(query.toLowerCase())),
    );

    // Then filter by organization if specified
    if (organizationId) {
      searchResults = searchResults.filter(
        (app) =>
          app.organizationId &&
          app.organizationId.toString() === organizationId,
      );

      logger.debug(
        `Filtered search results by organizationId: ${organizationId}, found ${searchResults.length} results`,
      );
    }

    // Filter apps by hardware compatibility if user has connected glasses
    const caps = request.userSession?.deviceManager.getCapabilities();
    if (request.userSession && caps) {
      searchResults = HardwareCompatibilityService.filterCompatibleApps(
        searchResults,
        caps,
        true, // Include apps with missing optional hardware
      );
    }

    res.json({
      success: true,
      data: searchResults,
    });
  } catch (error) {
    logger.error(error, "Error searching apps:");
    res.status(500).json({
      success: false,
      message: "Error searching apps",
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
        message: `App with package name ${packageName} not found`,
      });
    }

    // Convert Mongoose document to plain JavaScript object
    // Use toObject() method if available, otherwise use as is
    const plainApp =
      typeof (app as any).toObject === "function"
        ? (app as any).toObject()
        : app;

    // Log permissions for debugging
    logger.debug(
      { packageName, permissions: plainApp.permissions },
      "App permissions",
    );

    // If the app has an organizationId, get the organization profile information
    let orgProfile = null;

    try {
      if (plainApp.organizationId) {
        const org = await Organization.findById(plainApp.organizationId);
        if (org) {
          orgProfile = {
            name: org.name,
            profile: org.profile || {},
          };
        }
      }
      // Fallback to developer profile for backward compatibility
      else if (plainApp.developerId) {
        const developer = await User.findByEmail(plainApp.developerId);
        if (developer && developer.profile) {
          orgProfile = {
            name: developer.profile.company || developer.email.split("@")[0],
            profile: developer.profile,
          };
        }
      }
    } catch (err) {
      logger.error(
        {
          error: err,
          orgId: plainApp.organizationId,
          developerId: plainApp.developerId,
        },
        "Error fetching organization/developer profile",
      );
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

    // Attach latest online status for this app
    try {
      const latestStatuses =
        await AppUptimeService.getLatestStatusesForPackages([packageName]);
      const statusMap = new Map<string, boolean>(
        latestStatuses.map((s) => [s.packageName, Boolean(s.onlineStatus)]),
      );
      (appObj as any).isOnline = statusMap.get(packageName);
    } catch (e) {
      logger.warn({ e, packageName }, "Failed to attach latest online status");
    }

    res.json({
      success: true,
      data: appObj,
    });
  } catch (error) {
    logger.error(error, "Error fetching app");
    res.status(500).json({
      success: false,
      message: "Error fetching app",
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
    route: "POST /apps/:packageName/start",
    sessionId: userSession.sessionId,
  });

  const startTime = Date.now();

  // INFO: Route entry
  routeLogger.info(
    {
      sessionState: {
        websocketConnected:
          userSession.websocket?.readyState === WebSocket.OPEN,
        runningAppsCount: userSession.runningApps.size,
        loadingAppsCount: userSession.loadingApps.size,
      },
    },
    `Starting app ${packageName} for user ${userSession.userId}`,
  );

  // DEBUG: Detailed context
  routeLogger.debug(
    {
      detailedSessionState: {
        runningApps: Array.from(userSession.runningApps),
        loadingApps: Array.from(userSession.loadingApps),
        installedAppsCount: userSession.installedApps.size,
        appWebsocketsCount: userSession.appWebsockets.size,
      },
    },
    "Route entry context",
  );

  try {
    // Validate that the app exists before attempting to start it
    const app = await appService.getApp(packageName);
    if (!app) {
      const totalDuration = Date.now() - startTime;
      routeLogger.error(
        {
          totalDuration,
        },
        `App ${packageName} not found in database`,
      );

      return res.status(404).json({
        success: false,
        message: "App not found",
      });
    }

    // WARN: Already running (weird but we handle gracefully)
    if (userSession.runningApps.has(packageName)) {
      routeLogger.warn("App already in runningApps before startApp call");
    }

    // WARN: Already loading (weird but we handle gracefully)
    if (userSession.loadingApps.has(packageName)) {
      routeLogger.warn("App already in loadingApps before startApp call");
    }

    // DEBUG: AppManager call
    routeLogger.debug("Calling userSession.appManager.startApp()");
    const appManagerStartTime = Date.now();

    const result = await userSession.appManager.startApp(packageName);
    const appManagerDuration = Date.now() - appManagerStartTime;

    // DEBUG: AppManager result
    routeLogger.debug(
      {
        appManagerResult: result,
        appManagerDuration,
        postStartState: {
          isNowRunning: userSession.runningApps.has(packageName),
          isStillLoading: userSession.loadingApps.has(packageName),
          hasWebsocket: userSession.appWebsockets.has(packageName),
        },
      },
      `AppManager.startApp completed in ${appManagerDuration}ms`,
    );

    // DEBUG: Broadcast call
    routeLogger.debug("Calling userSession.appManager.broadcastAppState()");
    const broadcastStartTime = Date.now();

    const appStateChange = userSession.appManager.broadcastAppState();
    const broadcastDuration = Date.now() - broadcastStartTime;

    // DEBUG: Broadcast result
    routeLogger.debug(
      {
        broadcastDuration,
        appStateChangeGenerated: !!appStateChange,
        appStateChangeSize: appStateChange
          ? JSON.stringify(appStateChange).length
          : 0,
      },
      `App state broadcast completed in ${broadcastDuration}ms`,
    );

    // ERROR: This shouldn't happen - broadcast should always work
    if (!appStateChange) {
      const totalDuration = Date.now() - startTime;
      routeLogger.error(
        {
          totalDuration,
          sessionState: {
            websocketReady:
              userSession.websocket?.readyState === WebSocket.OPEN,
            runningApps: Array.from(userSession.runningApps),
            loadingApps: Array.from(userSession.loadingApps),
          },
        },
        "Broadcast failed to generate app state change - this should not happen",
      );

      return res.status(500).json({
        success: false,
        message: "Error generating app state change",
      });
    }

    const totalDuration = Date.now() - startTime;

    // INFO: Successful completion
    routeLogger.info(
      {
        totalDuration,
        success: result.success,
      },
      `App start completed in ${totalDuration}ms`,
    );

    // DEBUG: Final state details
    routeLogger.debug(
      {
        appManagerDuration,
        broadcastDuration,
        finalState: {
          runningApps: Array.from(userSession.runningApps),
          loadingApps: Array.from(userSession.loadingApps),
        },
      },
      "Route completion details",
    );

    res.json({
      success: true,
      data: {
        status: "started",
        packageName,
        appState: appStateChange,
      },
    });

    // Send app started notification to WebSocket
    if (userSession.websocket) {
      webSocketService.sendAppStarted(userSession, packageName);
    }
  } catch (error) {
    const totalDuration = Date.now() - startTime;

    // ERROR: Route execution failed
    routeLogger.error(
      {
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : error,
        totalDuration,
      },
      `Route failed after ${totalDuration}ms`,
    );

    // DEBUG: Error context for debugging
    routeLogger.debug(
      {
        sessionStateOnError: {
          websocketState: userSession.websocket?.readyState,
          runningApps: Array.from(userSession.runningApps),
          loadingApps: Array.from(userSession.loadingApps),
          appWebsockets: Array.from(userSession.appWebsockets.keys()),
        },
        requestContext: {
          method: req.method,
          url: req.url,
          userAgent: req.headers["user-agent"],
        },
      },
      "Error context details",
    );

    res.status(500).json({
      success: false,
      message: "Error starting app",
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
    route: "POST /apps/:packageName/stop",
    sessionId: userSession?.sessionId,
  });

  const startTime = Date.now();

  // INFO: Route entry
  routeLogger.info(
    {
      isCurrentlyRunning: userSession?.runningApps?.has(packageName),
      runningAppsCount: userSession?.runningApps?.size || 0,
    },
    `Stopping app ${packageName} for user ${userSession?.userId || "unknown"}`,
  );

  // ERROR: Missing user session (shouldn't happen due to middleware)
  if (!userSession || !userSession.userId) {
    routeLogger.error(
      {
        userSessionExists: !!userSession,
        userIdExists: !!userSession?.userId,
      },
      "User session validation failed - middleware issue",
    );

    return res.status(401).json({
      success: false,
      message: "User session is required",
    });
  }

  // DEBUG: Session state details
  routeLogger.debug(
    {
      sessionState: {
        websocketConnected:
          userSession.websocket?.readyState === WebSocket.OPEN,
        isCurrentlyLoading: userSession.loadingApps.has(packageName),
        hasWebsocketConnection: userSession.appWebsockets.has(packageName),
        runningApps: Array.from(userSession.runningApps),
        loadingApps: Array.from(userSession.loadingApps),
      },
    },
    "Stop app route context",
  );

  try {
    // DEBUG: App lookup
    routeLogger.debug("Looking up app in database");
    const appLookupStart = Date.now();

    const app = await appService.getApp(packageName);
    const appLookupDuration = Date.now() - appLookupStart;

    // DEBUG: App lookup result
    routeLogger.debug(
      {
        appLookupDuration,
        appFound: !!app,
      },
      `App lookup completed in ${appLookupDuration}ms`,
    );

    // ERROR: App not found (shouldn't happen for valid requests)
    if (!app) {
      const totalDuration = Date.now() - startTime;
      routeLogger.error(
        {
          totalDuration,
        },
        `App ${packageName} not found in database`,
      );

      return res.status(404).json({
        success: false,
        message: "App not found",
      });
    }

    // WARN: App not running (weird but we handle gracefully)
    if (
      !userSession.runningApps.has(packageName) &&
      !userSession.loadingApps.has(packageName)
    ) {
      routeLogger.warn(
        "App not in runningApps or loadingApps but stop requested",
      );
    }

    // DEBUG: AppManager stop call
    routeLogger.debug("Calling userSession.appManager.stopApp()");
    const stopStartTime = Date.now();

    await userSession.appManager.stopApp(packageName);
    const stopDuration = Date.now() - stopStartTime;

    // DEBUG: Stop result
    routeLogger.debug(
      {
        stopDuration,
        postStopState: {
          isStillRunning: userSession.runningApps.has(packageName),
          isStillLoading: userSession.loadingApps.has(packageName),
          stillHasWebsocket: userSession.appWebsockets.has(packageName),
        },
      },
      `AppManager.stopApp completed in ${stopDuration}ms`,
    );

    // DEBUG: Broadcast call
    routeLogger.debug("Calling userSession.appManager.broadcastAppState()");
    const broadcastStartTime = Date.now();

    const appStateChange = userSession.appManager.broadcastAppState();
    const broadcastDuration = Date.now() - broadcastStartTime;

    // DEBUG: Broadcast result
    routeLogger.debug(
      {
        broadcastDuration,
        appStateChangeGenerated: !!appStateChange,
      },
      `App state broadcast completed in ${broadcastDuration}ms`,
    );

    // ERROR: Broadcast failed (shouldn't happen)
    if (!appStateChange) {
      const totalDuration = Date.now() - startTime;
      routeLogger.error(
        {
          totalDuration,
        },
        "Failed to generate app state change - this should not happen",
      );

      return res.status(500).json({
        success: false,
        message: "Error generating app state change",
      });
    }

    const totalDuration = Date.now() - startTime;

    // INFO: Successful completion
    routeLogger.info(
      {
        totalDuration,
      },
      `App stop completed in ${totalDuration}ms`,
    );

    // DEBUG: Timing breakdown
    routeLogger.debug(
      {
        appLookupDuration,
        stopDuration,
        broadcastDuration,
      },
      "Route timing breakdown",
    );

    // Send app stopped notification to WebSocket
    if (userSession.websocket) {
      webSocketService.sendAppStopped(userSession, packageName);
    }

    res.json({
      success: true,
      data: {
        status: "stopped",
        packageName,
        appState: appStateChange,
      },
    });
  } catch (error) {
    const totalDuration = Date.now() - startTime;

    // ERROR: Route execution failed
    routeLogger.error(
      {
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : error,
        totalDuration,
      },
      `Route failed after ${totalDuration}ms`,
    );

    // DEBUG: Error context
    routeLogger.debug(
      {
        sessionStateOnError: {
          runningApps: Array.from(userSession.runningApps),
          loadingApps: Array.from(userSession.loadingApps),
          appWebsockets: Array.from(userSession.appWebsockets.keys()),
        },
      },
      "Error context details",
    );

    res.status(500).json({
      success: false,
      message: "Error stopping app",
    });
  }
}

/**
 * Install app for user
 */
async function installApp(req: Request, res: Response) {
  const request = req as RequestWithOptionalUserSession;

  const { packageName } = req.params;
  const userSession = request.userSession; // Get optional userSession from middleware
  const email = request.email; // Get email from request
  const user = request.user; // Get user from middleware

  try {
    if (!email || !packageName) {
      return res.status(400).json({
        success: false,
        message: "User session and package name are required",
      });
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Get app details
    const app = await appService.getApp(packageName);
    if (!app) {
      return res.status(404).json({
        success: false,
        message: "App not found",
      });
    }

    // Check if app is already installed
    if (user.installedApps?.some((app) => app.packageName === packageName)) {
      return res.status(400).json({
        success: false,
        message: "App is already installed",
      });
    }

    // Log hardware compatibility information if user has active session with connected glasses
    const caps = userSession?.deviceManager.getCapabilities();
    if (userSession && caps) {
      const compatibilityResult =
        HardwareCompatibilityService.checkCompatibility(app, caps);

      if (!compatibilityResult.isCompatible) {
        logger.info(
          {
            packageName,
            email,
            missingHardware: compatibilityResult.missingRequired,
            capabilities: caps,
          },
          "Installing app with missing required hardware",
        );
      }
    }

    // Add to installed apps
    await user.installApp(packageName);

    res.json({
      success: true,
      message: `App ${packageName} installed successfully`,
    });

    // If there's an active userSession, update the session with the new app.
    try {
      // sessionService.triggerAppStateChange(email);
      if (userSession) {
        userSession.appManager.broadcastAppState();
      }
    } catch (error) {
      logger.warn(
        { error, email, packageName },
        "Error sending app state notification",
      );
      // Non-critical error, installation succeeded
    }
  } catch (error) {
    logger.error({ error, email, packageName }, "Error installing app");
    res.status(500).json({
      success: false,
      message: "Error installing app",
    });
  }
}

/**
 * Uninstall app for user
 */
async function uninstallApp(req: Request, res: Response) {
  const request = req as RequestWithOptionalUserSession;
  const { packageName } = req.params;

  try {
    // Find user
    const userSession = request.userSession; // Get userSession from middleware
    const user = request.user; // Get user from middleware
    const email = request.email; // Get email from request

    if (!email || !packageName) {
      return res.status(400).json({
        success: false,
        message: "User session and package name are required",
      });
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Remove from installed apps
    if (!user.installedApps) {
      return res.status(400).json({
        success: false,
        message: "App is not installed",
      });
    }

    user.installedApps = user.installedApps.filter(
      (app) => app.packageName !== packageName,
    );

    await user.save();

    res.json({
      success: true,
      message: `App ${packageName} uninstalled successfully`,
    });

    // Attempt to stop the app session before uninstalling.
    try {
      if (userSession) {
        // TODO(isaiah): Ensure this automatically triggers appstate change sent to client.
        await userSession.appManager.stopApp(packageName);
        await userSession.appManager.broadcastAppState();
      } else {
        logger.warn(
          { email, packageName },
          "Unable to ensure app is stopped before uninstalling, no active session",
        );
      }
    } catch (error) {
      logger.warn(error, "Error stopping app during uninstall:");
    }
  } catch (error) {
    logger.error(
      { error, userId: request.email, packageName },
      "Error uninstalling app",
    );
    res.status(500).json({
      success: false,
      message: "Error uninstalling app",
    });
  }
}

/**
 * Get installed apps for user
 */
async function getInstalledApps(req: Request, res: Response) {
  const request = req as RequestWithOptionalUserSession;

  try {
    const user = request.user;
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // TODO(isaiah): There's a better way to get list of all apps from MongoDB that doesn't spam DB with fetching one at a time.
    // Get details for all installed apps
    const installedApps = await Promise.all(
      (user.installedApps || []).map(async (installedApp) => {
        const appDetails = await appService.getApp(installedApp.packageName);
        if (!appDetails) return null;

        // Check hardware compatibility for each app
        let compatibilityInfo = null;
        const caps = request.userSession?.deviceManager.getCapabilities();
        if (request.userSession && caps) {
          const compatibilityResult =
            HardwareCompatibilityService.checkCompatibility(appDetails, caps);

          compatibilityInfo = {
            isCompatible: compatibilityResult.isCompatible,
            missingRequired: compatibilityResult.missingRequired.map((req) => ({
              type: req.type,
              description: req.description,
            })),
            missingOptional: compatibilityResult.missingOptional.map((req) => ({
              type: req.type,
              description: req.description,
            })),
            message:
              HardwareCompatibilityService.getCompatibilityMessage(
                compatibilityResult,
              ),
          };
        }

        return {
          ...appDetails,
          installedDate: installedApp.installedDate,
          compatibility: compatibilityInfo,
        };
      }),
    );

    // Filter out null entries (in case an app was deleted)
    const validApps = installedApps.filter((app) => app !== null);

    res.json({
      success: true,
      data: validApps,
    });
  } catch (error) {
    logger.error(error, "Error fetching installed apps:");
    res.status(500).json({
      success: false,
      message: "Error fetching installed apps",
    });
  }
}

async function getAvailableApps(req: Request, res: Response) {
  const request = req as RequestWithOptionalUserSession;

  try {
    const organizationId = req.query.organizationId as string;
    let apps = await appService.getAvailableApps();

    // Filter by organization if specified
    if (organizationId) {
      apps = apps.filter(
        (app) =>
          app.organizationId &&
          app.organizationId.toString() === organizationId,
      );

      logger.debug(
        `Filtered available apps by organizationId: ${organizationId}, found ${apps.length} apps`,
      );
    }

    // Filter apps by hardware compatibility if user has connected glasses
    const caps = request.userSession?.deviceManager.getCapabilities();
    if (request.userSession && caps) {
      apps = HardwareCompatibilityService.filterCompatibleApps(
        apps,
        caps,
        true, // Include apps with missing optional hardware
      );
    }

    // Attach latest online status and hide offline published apps for users who haven't installed them
    try {
      const packageNames = apps.map((a) => a.packageName);
      const latestStatuses =
        await AppUptimeService.getLatestStatusesForPackages(packageNames);
      const statusMap = new Map<string, boolean>(
        latestStatuses.map((s) => [s.packageName, Boolean(s.onlineStatus)]),
      );

      // Determine installed apps for authenticated users
      const installedSet = new Set<string>();
      try {
        const user =
          request.user ||
          (request.email ? await User.findByEmail(request.email) : null);
        if (user?.installedApps) {
          for (const inst of user.installedApps) {
            installedSet.add(inst.packageName);
          }
        }
      } catch {
        // ignore
      }

      // Filter and annotate
      apps = apps.filter((app) => {
        const isOnline = statusMap.get(app.packageName);
        (app as any).isOnline = isOnline !== false; // default true if unknown
        if (app.appStoreStatus === "PUBLISHED" && isOnline === false) {
          // Keep if user already installed, else hide from store
          return installedSet.has(app.packageName);
        }
        return true;
      });
    } catch (e) {
      logger.warn({ e }, "Failed to determine latest app online statuses");
    }

    // Enhance apps with organization profiles in batch
    const enhancedApps = await batchEnrichAppsWithProfiles(apps as any[]);

    // Return the enhanced apps with success flag
    res.json({
      success: true,
      data: enhancedApps,
    });
  } catch (error) {
    logger.error(error, "Error fetching available apps:");
    res.status(500).json({
      success: false,
      message: "Failed to fetch available apps",
    });
  }
}

// Route Definitions
router.get("/", unifiedAuthMiddleware, getAllApps);
router.get("/public", authWithOptionalSession, getPublicApps);
router.get("/search", authWithOptionalSession, searchApps);

// TODO(isaiah): move appstore only
// App store operations - use client-auth-middleware.ts
router.get("/installed", authWithOptionalSession, getInstalledApps);
router.post("/install/:packageName", authWithOptionalSession, installApp);
router.post("/uninstall/:packageName", authWithOptionalSession, uninstallApp);

router.get("/version", async (req, res) => {
  res.json({ version: CLOUD_VERSION });
});

router.get("/available", optionalAuthWithOptionalSession, getAvailableApps);
router.get("/:packageName", getAppByPackage);

// Device-specific operations - use unified auth
router.post("/:packageName/start", unifiedAuthMiddleware, startApp);
router.post("/:packageName/stop", unifiedAuthMiddleware, stopApp);

// Helper to batch-enrich apps with organization/developer profile and display name
/**
 * Batch-enriches a list of apps with organization profile or legacy developer profile.
 * Minimizes database calls by:
 *  - Collecting unique organizationIds and developer emails
 *  - Performing bulk queries to Organizations and Users
 *  - Mapping results back to each app
 *
 * Returns plain objects with added fields: developerProfile, orgName, developerName.
 */
async function batchEnrichAppsWithProfiles(
  appsInput: Array<any>,
): Promise<Array<any>> {
  // Normalize to plain objects to avoid mutating Mongoose docs
  const apps = appsInput.map((a: any) => (a as any).toObject?.() || a);

  // Collect unique organization ids and developer emails
  const orgIdSet = new Set<string>();
  const developerEmailSet = new Set<string>();

  for (const app of apps) {
    if (app.organizationId) {
      try {
        orgIdSet.add(String(app.organizationId));
      } catch {
        // ignore malformed ids
      }
    } else if (app.developerId) {
      developerEmailSet.add(String(app.developerId).toLowerCase());
    }
  }

  // Bulk fetch organizations and users
  let orgMap = new Map<string, any>();
  let userMap = new Map<string, any>();

  try {
    if (orgIdSet.size > 0) {
      const orgs = await Organization.find({
        _id: { $in: Array.from(orgIdSet) },
      }).lean();
      orgMap = new Map(orgs.map((o: any) => [String(o._id), o]));
    }
  } catch (e) {
    logger.warn({ e }, "Failed to batch-load organizations for app enrichment");
  }

  try {
    if (developerEmailSet.size > 0) {
      const users = await User.find({
        email: { $in: Array.from(developerEmailSet) },
      }).lean();
      userMap = new Map(
        users.map((u: any) => [String(u.email).toLowerCase(), u]),
      );
    }
  } catch (e) {
    logger.warn({ e }, "Failed to batch-load users for app enrichment");
  }

  // Apply enrichment
  return apps.map((app: any) => {
    const enriched = { ...app } as any;

    if (app.organizationId) {
      const key = String(app.organizationId);
      const org = orgMap.get(key);
      if (org) {
        enriched.developerProfile = org.profile || {};
        enriched.orgName = org.name;
        enriched.developerName = org.name;
      }
    } else if (app.developerId) {
      const user = userMap.get(String(app.developerId).toLowerCase());
      if (user && user.profile) {
        const displayName =
          user.profile.company || String(user.email).split("@")[0];
        enriched.developerProfile = user.profile;
        enriched.orgName = displayName;
        enriched.developerName = displayName;
      }
    }

    return enriched;
  });
}

// Helper to enhance apps with running/foreground state and activity data
/**
 * Enhances a list of apps (SDK AppI or local AppI) with running/foreground state and last active timestamp.
 * Accepts AppI[] from either @mentra/sdk or local model.
 */
function enhanceAppsWithSessionState(
  apps: AppI[],
  userSession: UserSession,
  user?: any,
): EnhancedAppI[] {
  const plainApps = apps.map((app) => {
    return (app as any).toObject?.() || app;
  });

  return plainApps.map((app) => {
    const enhancedApp: EnhancedAppI = {
      ...app,
      is_running: false,
      is_foreground: false,
    };

    enhancedApp.is_running = userSession.runningApps.has(app.packageName);
    // This is deprecated, will be removed in future versions.
    if (enhancedApp.is_running) {
      enhancedApp.is_foreground = app.appType === AppType.STANDARD;
    }

    // Add last active timestamp if user data is available
    if (user && user.installedApps) {
      const installedApp = user.installedApps.find(
        (installed: any) => installed.packageName === app.packageName,
      );
      if (installedApp && installedApp.lastActiveAt) {
        enhancedApp.lastActiveAt = installedApp.lastActiveAt;
      }
    }

    return enhancedApp;
  });
}

export default router;
