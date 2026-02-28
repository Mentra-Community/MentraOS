// routes/developer.routes.ts
import { Router, Request, Response, NextFunction } from "express";
import appService from "../services/core/app.service";
import { User } from "../models/user.model";
import { Types } from "mongoose";
import { OrganizationService } from "../services/core/organization.service";
import { logger as rootLogger } from "../services/logging/pino-logger";
import multer from "multer";

const logger = rootLogger.child({ service: "developer.routes" });
// TODO(isaiah): refactor this code to use this logger instead of console.log, console.error, etc.

// Configure multer for memory storage (files stored in memory as Buffer)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept only image files
    const allowedMimeTypes = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only PNG, JPEG, GIF, and WebP images are allowed."));
    }
  },
});

// Define request with user and organization info
interface DevPortalRequest extends Request {
  developerEmail: string;
  currentOrgId?: Types.ObjectId;
}

const router = Router();

// ------------- MIDDLEWARE -------------

/**
 * Middleware to validate Core token - similar to how apps.routes.ts works
 */
import jwt from "jsonwebtoken";
import UserSession from "../services/session/UserSession";
import { StorageService } from "../services/storage/storage.service";
const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

// TODO(isaiah): This is called validateSupabaseToken, but i'm pretty sure this is using an AugmentOS JWT(coreToken), not a Supabase token.
// TODO(isaiah): Investigate how currentOrgId is used, the DevPortalRequest claims it's optional yet this middleware fails if it's not provided.
// Also the middleware doesn't validate the currentOrgId, only injects it into the request object, maybe it should just be a query param instead of a header?
const validateSupabaseToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization;
  const baseLogger = logger.child({
    service: "developer.routes",
    function: "validateSupabaseToken",
    endpoint: req.originalUrl,
    method: req.method,
    userAgent: req.headers["user-agent"],
  });

  baseLogger.debug(
    {
      hasAuthHeader: !!authHeader,
      authHeaderPrefix: authHeader?.substring(0, 20),
      allHeaders: Object.keys(req.headers),
    },
    "Starting token validation",
  );

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    baseLogger.warn("Missing or invalid Authorization header");
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.substring(7); // Remove 'Bearer ' prefix
  baseLogger.debug({ tokenLength: token.length }, "Extracted bearer token");

  try {
    // Verify using our AUGMENTOS_AUTH_JWT_SECRET instead of Supabase directly
    // This matches the token format used by the apps.routes.ts
    const userData = jwt.verify(token, AUGMENTOS_AUTH_JWT_SECRET);

    if (!userData || !(userData as jwt.JwtPayload).email) {
      baseLogger.error({ hasUserData: !!userData, tokenPayload: userData }, "No user or email in token payload");
      res.status(401).json({ error: "Invalid token data" });
      return;
    }

    const userEmail = ((userData as jwt.JwtPayload).email as string).toLowerCase();
    const userLogger = baseLogger.child({ userId: userEmail });

    userLogger.info({ tokenIssued: (userData as jwt.JwtPayload).iat }, "User authenticated successfully");

    // Add developer email to request object
    (req as DevPortalRequest).developerEmail = userEmail;

    // Check for organization context in headers
    const orgIdHeader = req.headers["x-org-id"];
    userLogger.debug(
      {
        orgIdHeader,
        hasOrgIdHeader: !!orgIdHeader,
        orgIdHeaderType: typeof orgIdHeader,
        orgIdHeaderValue: orgIdHeader?.toString(),
        allRelevantHeaders: {
          "x-org-id": req.headers["x-org-id"],
          "x-organization-id": req.headers["x-organization-id"],
          "organization-id": req.headers["organization-id"],
        },
      },
      "Checking organization ID header",
    );

    if (orgIdHeader && typeof orgIdHeader === "string") {
      try {
        const orgObjectId = new Types.ObjectId(orgIdHeader);
        (req as DevPortalRequest).currentOrgId = orgObjectId;
        userLogger.info(
          {
            orgIdFromHeader: orgIdHeader,
            orgObjectId: orgObjectId.toString(),
          },
          "Using organization ID from x-org-id header",
        );
      } catch (parseError) {
        userLogger.error(
          {
            orgIdHeader,
            parseError: parseError instanceof Error ? parseError.message : String(parseError),
          },
          "Failed to parse organization ID from header",
        );
      }
    } else {
      userLogger.debug("No valid x-org-id header, checking user defaultOrg from database");

      const user = await User.findOne({ email: userEmail });
      userLogger.debug(
        {
          userFound: !!user,
          userDefaultOrg: user?.defaultOrg?.toString(),
          userOrganizations: user?.organizations?.map((org) => org.toString()),
          organizationCount: user?.organizations?.length || 0,
          hasDefaultOrg: !!user?.defaultOrg,
        },
        "User organization data from database",
      );

      if (user && user.defaultOrg) {
        (req as DevPortalRequest).currentOrgId = user.defaultOrg;
        userLogger.info(
          {
            defaultOrgId: user.defaultOrg.toString(),
            totalUserOrgs: user.organizations?.length || 0,
          },
          "Using user default organization from database",
        );
      } else {
        userLogger.warn(
          {
            hasUser: !!user,
            hasDefaultOrg: !!user?.defaultOrg,
            availableOrgs: user?.organizations?.length || 0,
            userOrganizations: user?.organizations?.map((org) => org.toString()) || [],
          },
          "No default organization found for user",
        );

        // Find any org for the user and set the first as default if any exist
        if (user && user.organizations && user.organizations.length > 0) {
          const firstOrgId = user.organizations[0];
          user.defaultOrg = firstOrgId;

          await user.save();
          (req as DevPortalRequest).currentOrgId = firstOrgId;

          userLogger.info(
            {
              newDefaultOrgId: firstOrgId.toString(),
              totalUserOrgs: user.organizations.length,
              source: "auto-assigned-first-org",
            },
            "Set first available organization as default and using it",
          );
        } else if (user && (!user.organizations || user.organizations.length === 0)) {
          // Check if there are any orgs that have this user as an admin member
          userLogger.info("User has no organizations in their array - checking for orphaned memberships");

          try {
            const { Organization } = require("../models/organization.model");
            const orgsWithUserAsMember = await Organization.find({
              "members.user": user._id,
            }).select("_id name members");

            if (orgsWithUserAsMember && orgsWithUserAsMember.length > 0) {
              userLogger.info(
                {
                  foundOrganizations: orgsWithUserAsMember.length,
                  orgIds: orgsWithUserAsMember.map((org: any) => org._id.toString()),
                },
                "Found organizations where user is a member - syncing user data",
              );

              // Update user's organizations array with found organizations
              user.organizations = orgsWithUserAsMember.map((org: any) => org._id);

              // Set the first organization as default
              user.defaultOrg = orgsWithUserAsMember[0]._id;

              await user.save();
              (req as DevPortalRequest).currentOrgId = orgsWithUserAsMember[0]._id;

              userLogger.info(
                {
                  syncedOrganizations: user.organizations?.length || 0,
                  newDefaultOrg: user.defaultOrg?.toString(),
                  source: "synced-from-memberships",
                },
                "Successfully synced user organizations from existing memberships",
              );
            } else {
              userLogger.info("No existing organization memberships found - will create new personal org");
              // Fall through to create personal org
            }
          } catch (syncError) {
            userLogger.error(
              {
                error: syncError instanceof Error ? syncError.message : String(syncError),
                userEmail: user.email,
              },
              "Error checking for existing organization memberships",
            );
            // Fall through to create personal org as fallback
          }
        }

        // Only create new org if user still has no organizations after sync attempt
        if (user && (!user.organizations || user.organizations.length === 0)) {
          userLogger.warn("No organizations found for user - creating personal organization");

          // Create a personal organization for the user
          try {
            const personalOrgId = await OrganizationService.createPersonalOrg(user);

            // Add to user's organizations array
            if (!user.organizations) {
              user.organizations = [];
            }
            user.organizations.push(personalOrgId);
            user.defaultOrg = personalOrgId;

            await user.save();
            (req as DevPortalRequest).currentOrgId = personalOrgId;

            userLogger.info(
              {
                newOrgId: personalOrgId.toString(),
                orgName: `${user.profile?.company || user.email.split("@")[0]}'s Org`,
                source: "auto-created-personal-org",
              },
              "Created new personal organization for user and set as default",
            );
          } catch (orgCreationError) {
            userLogger.error(
              {
                error: orgCreationError instanceof Error ? orgCreationError.message : String(orgCreationError),
                userEmail: user.email,
              },
              "Failed to create personal organization for user",
            );

            // This is a critical error - user has no organizations and we can't create one
            res.status(500).json({
              error: "Failed to create organization context for user",
            });
            return;
          }
        }
      }
    }

    const finalOrgId = (req as DevPortalRequest).currentOrgId;
    if (!finalOrgId) {
      const user = await User.findOne({ email: userEmail });
      userLogger.error(
        {
          orgIdHeader,
          orgIdHeaderType: typeof orgIdHeader,
          userHasDefaultOrg: !!user?.defaultOrg,
          userOrganizations: user?.organizations?.map((org) => org.toString()) || [],
          userDefaultOrgValue: user?.defaultOrg?.toString(),
          reason: "No organization context available from header or user default",
          endpoint: req.originalUrl,
          method: req.method,
        },
        "🚨 ORGANIZATION CONTEXT FAILURE - returning 400 error",
      );

      res.status(400).json({ error: "No organization context provided" });
      return;
    }

    userLogger.info(
      {
        organizationId: finalOrgId.toString(),
        source: orgIdHeader ? "x-org-id-header" : "user-defaultOrg",
        endpoint: req.originalUrl,
      },
      "✅ Organization context resolved successfully",
    );

    next();
  } catch (error) {
    baseLogger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        tokenLength: token?.length,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      },
      "Token verification error",
    );
    res.status(500).json({ error: "Authentication failed" });
    return;
  }
};

// ------------- HANDLER FUNCTIONS -------------

/**
 * Helper function to automatically install an app for the developer who created it
 * @param packageName - The package name of the app to install
 * @param developerEmail - The email of the developer who created the app
 */
const autoInstallAppForDeveloper = async (packageName: string, developerEmail: string): Promise<void> => {
  try {
    logger.info(`Auto-installing app ${packageName} for developer ${developerEmail}`);

    // Find the user (do not create if not found)
    const user = await User.findOne({ email: developerEmail.toLowerCase() });
    if (!user) {
      logger.error(`User not found for auto-install: ${developerEmail}`);
      return;
    }

    // Check if app is already installed (safety check)
    if (user.isAppInstalled(packageName)) {
      logger.info(`App ${packageName} is already installed for developer ${developerEmail}`);
      return;
    }

    // Install the app using the user model method
    await user.installApp(packageName);

    logger.info(`Successfully auto-installed app ${packageName} for developer ${developerEmail}`);

    // Trigger app state change notification for any active sessions
    try {
      // sessionService.triggerAppStateChange(developerEmail);
      const userSession = UserSession.getById(user.email);
      if (userSession) {
        userSession.appManager.broadcastAppState();
      } else {
        logger.warn(`No active session found for developer ${developerEmail} to trigger app state change`);
      }
    } catch (error) {
      logger.warn(
        { error, email: developerEmail, packageName },
        "Error sending app state notification after auto-install",
      );
      // Non-critical error, installation succeeded
    }
  } catch (error) {
    logger.error({ error, packageName, developerEmail }, "Error auto-installing app for developer");
    // Don't throw the error - we don't want app creation to fail if auto-install fails
  }
};

/**
 * Get authenticated developer user
 */
const getAuthenticatedUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const user = await User.findOrCreateUser(email);

    res.json({
      id: user._id,
      email: user.email,
      profile: user.profile || {
        company: "",
        website: "",
        contactEmail: "",
        description: "",
        logo: "",
      },
      organizations: user.organizations || [],
      defaultOrg: user.defaultOrg,
    });
  } catch (error) {
    const email = (req as DevPortalRequest).developerEmail;
    const userLogger = logger.child({
      userId: email,
      service: "developer.routes",
      function: "getAuthenticatedUser",
    });
    userLogger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      },
      "Error fetching user data",
    );
    res.status(500).json({ error: "Failed to fetch user data" });
  }
};

/**
 * Get developer's Apps
 */
const getDeveloperApps = async (req: Request, res: Response): Promise<void> => {
  try {
    // const email = (req as DevPortalRequest).developerEmail;
    const orgId = (req as DevPortalRequest).currentOrgId;

    // Fetch all apps owned by the organization
    const apps = await appService.getAppsByOrgId(orgId!);

    res.json(apps);
  } catch (error) {
    const email = (req as DevPortalRequest).developerEmail;
    const orgId = (req as DevPortalRequest).currentOrgId;
    const userLogger = logger.child({
      userId: email,
      organizationId: orgId?.toString(),
      service: "developer.routes",
      function: "getDeveloperApps",
    });
    userLogger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      },
      "Error fetching developer Apps",
    );
    res.status(500).json({ error: "Failed to fetch Apps" });
  }
};

/**
 * Get a specific App by package name
 */
const getAppByPackageName = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const orgId = (req as DevPortalRequest).currentOrgId;
    const { packageName } = req.params;

    const app = await appService.getAppByPackageName(packageName, email, orgId);

    if (!app) {
      return res.status(404).json({ error: "App not found" });
    }

    res.json(app);
  } catch (error) {
    const email = (req as DevPortalRequest).developerEmail;
    const orgId = (req as DevPortalRequest).currentOrgId;
    const { packageName } = req.params;
    const userLogger = logger.child({
      userId: email,
      organizationId: orgId?.toString(),
      packageName,
      service: "developer.routes",
      function: "getAppByPackageName",
    });
    userLogger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      },
      "Error fetching App",
    );
    return res.status(500).json({ error: "Failed to fetch App" });
  }
};

/**
 * Create a new App
 */
const createApp = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const orgId = (req as DevPortalRequest).currentOrgId;
    const appData = req.body;

    // Check if App with this package name already exists
    const existingApp = await appService.getAppByPackageName(appData.packageName);
    if (existingApp) {
      return res.status(409).json({
        error: `App with package name '${appData.packageName}' already exists`,
      });
    }

    // Create app with organization ownership
    const result = await appService.createApp(
      {
        ...appData,
        organizationId: orgId,
      },
      email,
    );

    // Auto-install the app for the developer who created it
    autoInstallAppForDeveloper(appData.packageName, email);

    res.status(201).json(result);
  } catch (error: any) {
    const email = (req as DevPortalRequest).developerEmail;
    const orgId = (req as DevPortalRequest).currentOrgId;
    const appData = req.body;
    const userLogger = logger.child({
      userId: email,
      organizationId: orgId?.toString(),
      packageName: appData?.packageName,
      service: "developer.routes",
      function: "createApp",
    });

    userLogger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        errorCode: error.code,
        errorStack: error instanceof Error ? error.stack : undefined,
        isDuplicateKey: error.code === 11000,
      },
      "Error creating App",
    );

    // Handle duplicate key error specifically
    if (error.code === 11000 && error.keyPattern?.packageName) {
      return res.status(409).json({
        error: `App with package name '${error.keyValue.packageName}' already exists`,
      });
    }

    return res.status(500).json({ error: error.message || "Failed to create app" });
  }
};

/**
 * Update an existing App
 */
const updateApp = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const orgId = (req as DevPortalRequest).currentOrgId;
    const { packageName } = req.params;
    const appData = req.body;

    const updatedApp = await appService.updateApp(packageName, appData, email, orgId);

    res.json(updatedApp);
  } catch (error: any) {
    console.error("Error updating App:", error);

    // Check for specific error types
    if (error.message.includes("not found")) {
      return res.status(404).json({ error: error.message });
    }

    if (error.message.includes("permission")) {
      return res.status(403).json({ error: error.message });
    }

    // For validation errors (like tool/setting validation), return the specific error message
    if (error.message.includes("Invalid tool definitions") || error.message.includes("Invalid setting definitions")) {
      return res.status(400).json({ error: error.message });
    }

    // Return the actual error message instead of a generic one
    res.status(500).json({ error: error.message || "Failed to update App" });
  }
};

/**
 * Delete a App
 */
const deleteApp = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const orgId = (req as DevPortalRequest).currentOrgId;
    const { packageName } = req.params;

    await appService.deleteApp(packageName, email, orgId);

    return res.status(200).json({ message: `App ${packageName} deleted successfully` });
  } catch (error: any) {
    console.error("Error deleting App:", error);

    // Check for specific error types
    if (error.message.includes("not found")) {
      return res.status(404).json({ error: error.message });
    }

    if (error.message.includes("permission")) {
      return res.status(403).json({ error: error.message });
    }

    return res.status(500).json({ error: "Failed to delete App" });
  }
};

/**
 * Regenerate API Key for a App
 */
const regenerateApiKey = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const orgId = (req as DevPortalRequest).currentOrgId;
    const { packageName } = req.params;

    const apiKey = await appService.regenerateApiKey(packageName, email, orgId);

    res.json({
      apiKey,
      createdAt: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Error regenerating API key:", error);

    // Check for specific error types
    if (error.message.includes("not found")) {
      return res.status(404).json({ error: error.message });
    }

    if (error.message.includes("permission")) {
      return res.status(403).json({ error: error.message });
    }

    res.status(500).json({ error: "Failed to regenerate API key" });
  }
};

/**
 * Get shareable installation link
 */
const getShareableLink = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const orgId = (req as DevPortalRequest).currentOrgId;
    const { packageName } = req.params;

    // Verify that organization owns this app
    const app = await appService.getAppByPackageName(packageName, email, orgId);
    if (!app) {
      return res.status(404).json({ error: "App not found" });
    }

    // Generate a shareable URL directly to the app's page on the app store
    const installUrl = `${process.env.APP_STORE_URL || "https://apps.mentra.glass"}/package/${packageName}`;

    res.json({ installUrl });
  } catch (error) {
    console.error("Error generating shareable link:", error);
    res.status(500).json({ error: "Failed to generate shareable link" });
  }
};

/**
 * Track app sharing
 */
const trackSharing = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const orgId = (req as DevPortalRequest).currentOrgId;
    const { packageName } = req.params;
    const { emails } = req.body;

    if (!Array.isArray(emails)) {
      return res.status(400).json({ error: "Emails must be an array" });
    }

    // Verify that organization owns this app
    const app = await appService.getAppByPackageName(packageName, email, orgId);
    if (!app) {
      return res.status(404).json({ error: "App not found" });
    }

    // In a real implementation, you would track who the app was shared with
    // For MVP, just acknowledge the request

    return res.json({ success: true, sharedWith: emails.length });
  } catch (error) {
    console.error("Error tracking app sharing:", error);
    return res.status(500).json({ error: "Failed to track app sharing" });
  }
};

/**
 * Publish app to the app store
 */
const publishApp = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const orgId = (req as DevPortalRequest).currentOrgId;
    const { packageName } = req.params;

    // Call service to publish app
    const updatedApp = await appService.publishApp(packageName, email, orgId);

    return res.json(updatedApp);
  } catch (error: any) {
    console.error("Error publishing app:", error);

    // Check for specific error types
    if (error.message.includes("not found")) {
      return res.status(404).json({ error: error.message });
    }

    if (error.message.includes("permission")) {
      return res.status(403).json({ error: error.message });
    }

    if (error.message.includes("PROFILE_INCOMPLETE")) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(500).json({ error: "Failed to publish app" });
  }
};

/**
 * Update developer profile - redirects to organization profile update
 */
const updateDeveloperProfile = async (req: Request, res: Response) => {
  try {
    return res.status(410).json({
      error: "This endpoint is deprecated",
      message: "Please use the organization profile update endpoint: PUT /api/orgs/:orgId",
    });
  } catch (error) {
    console.error("Error updating developer profile:", error);
    return res.status(500).json({ error: "Failed to update profile" });
  }
};

// No longer needed - visibility is now based on organization membership
const updateAppVisibility = async (req: Request, res: Response) => {
  return res.status(410).json({
    error: "This endpoint is deprecated",
    message: "App visibility is now managed through organization membership",
  });
};

/**
 * Update sharedWithEmails - deprecated
 */
const updateSharedEmails = async (req: Request, res: Response) => {
  return res.status(410).json({
    error: "This endpoint is deprecated",
    message: "App sharing is now managed through organization membership",
  });
};

/**
 * Move a App to a different organization
 */
const moveToOrg = async (req: Request, res: Response) => {
  const email = (req as DevPortalRequest).developerEmail;
  const sourceOrgId = (req as DevPortalRequest).currentOrgId;
  const { packageName } = req.params;
  const { targetOrgId } = req.body;

  const userLogger = logger.child({
    userId: email,
    organizationId: sourceOrgId?.toString(),
    packageName,
    service: "developer.routes",
    function: "moveToOrg",
  });

  userLogger.info(
    {
      packageName,
      targetOrgId,
      sourceOrgId: sourceOrgId?.toString(),
      url: req.originalUrl,
      method: req.method,
    },
    "moveToOrg handler called",
  );

  try {
    if (!sourceOrgId || !targetOrgId) {
      return res.status(400).json({ error: "Source and target organization IDs are required" });
    }

    // Get the user document
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check if source org exists and user has admin access
    const hasSourceAdminAccess = await OrganizationService.isOrgAdmin(user, sourceOrgId);
    if (!hasSourceAdminAccess) {
      return res.status(403).json({ error: "Insufficient permissions in source organization" });
    }

    // Check if target org exists and user has admin access
    const hasTargetAdminAccess = await OrganizationService.isOrgAdmin(user, targetOrgId);
    if (!hasTargetAdminAccess) {
      return res.status(403).json({ error: "Insufficient permissions in target organization" });
    }

    // Use app service to move the app
    const updatedApp = await appService.moveApp(
      packageName,
      sourceOrgId,
      new Types.ObjectId(targetOrgId.toString()),
      email,
    );

    // Return updated app
    return res.json(updatedApp);
  } catch (error: any) {
    userLogger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        targetOrgId,
        sourceOrgId: sourceOrgId?.toString(),
      },
      "Error moving App to new organization",
    );

    // Check for specific error types
    if (error.message.includes("not found")) {
      return res.status(404).json({ error: error.message });
    }

    if (error.message.includes("permission")) {
      return res.status(403).json({ error: error.message });
    }

    return res.status(500).json({ error: "Failed to move App to new organization" });
  }
};

/**
 * Upload an image to Cloudflare Images
 */
const uploadImage = async (req: Request, res: Response) => {
  const email = (req as DevPortalRequest).developerEmail;
  const orgId = (req as DevPortalRequest).currentOrgId;

  const userLogger = logger.child({
    userId: email,
    organizationId: orgId?.toString(),
    service: "developer.routes",
    function: "uploadImage",
    endpoint: req.originalUrl,
  });

  userLogger.info(
    {
      hasFile: !!req.file,
      fileName: req.file?.originalname,
      fileSize: req.file?.size,
      fileMimeType: req.file?.mimetype,
      hasMetadata: !!req.body.metadata,
      replaceImageId: req.body.replaceImageId,
      bodyKeys: Object.keys(req.body),
      organizationContextUsed: !!orgId,
      organizationContextSource: orgId ? "middleware-provided" : "none",
    },
    "Starting image upload process",
  );

  try {
    if (!req.file) {
      userLogger.warn("No file provided in upload request");
      return res.status(400).json({ error: "No file uploaded" });
    }

    let storageService: StorageService | null = null;
    try {
      storageService = new StorageService(userLogger);
    } catch (error) {
      userLogger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to initialize storage service",
      );
      return res.status(500).json({ error: "Failed to initialize storage service" });
    }

    // Parse metadata if provided
    let metadata: any = {};
    if (req.body.metadata) {
      try {
        metadata = JSON.parse(req.body.metadata);
        userLogger.debug({ metadata }, "Parsed upload metadata successfully");
      } catch (e) {
        userLogger.warn(
          {
            metadataRaw: req.body.metadata,
            parseError: e instanceof Error ? e.message : String(e),
          },
          "Failed to parse metadata - continuing with empty metadata",
        );
      }
    }

    // Check if we're replacing an existing image
    const replaceImageId = req.body.replaceImageId;
    if (replaceImageId) {
      userLogger.info({ replaceImageId }, "Will replace existing image after successful upload");
    }

    const response = await storageService.uploadImageAndReplace({
      image: req.file.buffer,
      filename: req.file.originalname,
      appPackageName: metadata.appPackageName,
      mimetype: req.file.mimetype,
      email,
      orgId,
      replaceImageId,
    });

    if (!response.url) {
      userLogger.error("No delivery URL found");
      return res.status(500).json({ error: "Failed to upload image to Cloudflare" });
    }

    // Return the image URL and ID
    const responseData = {
      url: response.url,
      imageId: response.imageId,
    };

    userLogger.info(responseData, "Image upload completed successfully");
    res.json(responseData);
  } catch (error) {
    userLogger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      },
      "Error in image upload handler",
    );
    return res.status(500).json({ error: "Internal server error during image upload" });
  }
};

/**
 * Delete an image from Cloudflare Images
 */
const deleteImage = async (req: Request, res: Response) => {
  const email = (req as DevPortalRequest).developerEmail;
  const orgId = (req as DevPortalRequest).currentOrgId;
  const userLogger = logger.child({
    userId: email,
    organizationId: orgId?.toString(),
    service: "developer.routes",
    function: "deleteImage",
    endpoint: req.originalUrl,
  });

  try {
    const { imageId } = req.params;
    if (!imageId) {
      return res.status(400).json({ error: "Image ID is required" });
    }

    userLogger.info(`Attempting to delete image ${imageId}`);

    const storageService = new StorageService(userLogger);
    await storageService.deleteImage(imageId);

    userLogger.info(`Image ${imageId} deleted by ${email}`);
    res.json({ success: true, message: "Image deleted successfully" });
  } catch (error) {
    userLogger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        errorStack: error instanceof Error ? error.stack : undefined,
        errorMessage: error instanceof Error ? error.message : undefined,
      },
      "Error in image delete handler",
    );

    if (error instanceof Error && error.message.includes("Image not found")) {
      userLogger.info("Returning 404 - image not found");
      return res.status(404).json({ error: "Image not found" });
    }

    userLogger.error("Returning 500 - unexpected error");
    return res.status(500).json({ error: "Internal server error during image deletion" });
  }
};

// ------------- ROUTES REGISTRATION -------------

// Auth routes
router.get("/auth/me", validateSupabaseToken, getAuthenticatedUser);
router.put("/auth/profile", validateSupabaseToken, updateDeveloperProfile);

// TEMPORARY DEBUG ROUTE - NO AUTH CHECK
router.get("/debug/apps", (req: Request, res: Response): void => {
  const debugLogger = logger.child({
    service: "developer.routes",
    function: "debugApps",
  });
  debugLogger.warn("Debug route hit - bypassing auth");
  res.json([
    {
      name: "Debug App",
      packageName: "com.debug.app",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      appType: "STANDARD",
      description: "Debug mode app",
      publicUrl: "http://localhost:3000",
    },
  ]);
});

// Developer Portal routes
router.get("/apps", validateSupabaseToken, getDeveloperApps);
router.post("/apps/register", validateSupabaseToken, createApp);
router.get("/apps/:packageName", validateSupabaseToken, getAppByPackageName);
router.put("/apps/:packageName", validateSupabaseToken, updateApp);
router.delete("/apps/:packageName", validateSupabaseToken, deleteApp);
router.post("/apps/:packageName/api-key", validateSupabaseToken, regenerateApiKey);
router.get("/apps/:packageName/share", validateSupabaseToken, getShareableLink);
router.post("/apps/:packageName/share", validateSupabaseToken, trackSharing);
router.post("/apps/:packageName/publish", validateSupabaseToken, publishApp);
router.patch("/apps/:packageName/visibility", validateSupabaseToken, updateAppVisibility);
router.patch("/apps/:packageName/share-emails", validateSupabaseToken, updateSharedEmails);
router.post("/apps/:packageName/move-org", validateSupabaseToken, moveToOrg);

// Image upload routes
router.post("/images/upload", validateSupabaseToken, upload.single("file"), uploadImage);
router.delete("/images/:imageId", validateSupabaseToken, deleteImage);

export default router;
