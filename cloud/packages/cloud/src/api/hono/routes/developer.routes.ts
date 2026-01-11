/**
 * @fileoverview Hono developer routes.
 * Developer portal API endpoints for app management.
 * Mounted at: /api/dev
 */

import { Hono } from "hono";
import jwt from "jsonwebtoken";
import { Types } from "mongoose";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import appService from "../../../services/core/app.service";
import { User, UserI } from "../../../models/user.model";
import { OrganizationService } from "../../../services/core/organization.service";
import App from "../../../models/app.model";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "developer.routes" });

const app = new Hono<AppEnv>();

const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

// ============================================================================
// Routes
// ============================================================================

// Auth routes
app.get("/auth/me", validateDeveloperToken, getAuthenticatedUser);
app.put("/auth/profile", validateDeveloperToken, updateDeveloperProfile);

// Debug route (no auth for testing)
app.get("/debug/apps", debugApps);

// App management routes
app.get("/apps", validateDeveloperToken, getDeveloperApps);
app.post("/apps/register", validateDeveloperToken, createApp);
app.get("/apps/:packageName", validateDeveloperToken, getAppByPackageName);
app.put("/apps/:packageName", validateDeveloperToken, updateApp);
app.delete("/apps/:packageName", validateDeveloperToken, deleteApp);
app.post("/apps/:packageName/api-key", validateDeveloperToken, regenerateApiKey);
app.get("/apps/:packageName/share", validateDeveloperToken, getShareableLink);
app.post("/apps/:packageName/share", validateDeveloperToken, trackSharing);
app.post("/apps/:packageName/publish", validateDeveloperToken, publishApp);
app.patch("/apps/:packageName/visibility", validateDeveloperToken, updateAppVisibility);
app.patch("/apps/:packageName/share-emails", validateDeveloperToken, updateSharedEmails);
app.post("/apps/:packageName/move-org", validateDeveloperToken, moveToOrg);

// Image upload routes
app.post("/images/upload", validateDeveloperToken, uploadImage);
app.delete("/images/:imageId", validateDeveloperToken, deleteImage);

// ============================================================================
// Middleware
// ============================================================================

/**
 * Middleware to validate developer token and extract user/org context.
 */
async function validateDeveloperToken(c: AppContext, next: () => Promise<void>) {
  const authHeader = c.req.header("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const userData = jwt.verify(token, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;

    if (!userData || !userData.email) {
      return c.json({ error: "Invalid token data" }, 401);
    }

    const userEmail = userData.email.toLowerCase();
    c.set("email", userEmail);

    // Check for organization context in headers
    const orgIdHeader = c.req.header("x-org-id");
    if (orgIdHeader && typeof orgIdHeader === "string") {
      try {
        (c as any).currentOrgId = new Types.ObjectId(orgIdHeader);
      } catch (e) {
        logger.debug({ orgIdHeader }, "Invalid org ID in header");
      }
    }

    // If no org ID provided, try to get from user's organizations
    if (!(c as any).currentOrgId) {
      const user = await User.findOne({ email: userEmail });
      if (user && user.organizations && user.organizations.length > 0) {
        // Use the first organization as default (organizations is an array of ObjectIds)
        (c as any).currentOrgId = user.organizations[0];
      } else if (user && user.defaultOrg) {
        // Fallback to defaultOrg if available
        (c as any).currentOrgId = user.defaultOrg;
      }
    }

    await next();
  } catch (error) {
    logger.debug({ error }, "Token verification failed");
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Auto-install app for the developer when they create or update it.
 */
async function autoInstallAppForDeveloper(email: string, packageName: string): Promise<void> {
  try {
    const user = await User.findOne({ email });
    if (!user) return;

    const alreadyInstalled = user.installedApps?.some((app) => app.packageName === packageName);
    if (!alreadyInstalled) {
      if (!user.installedApps) {
        user.installedApps = [];
      }
      user.installedApps.push({
        packageName,
        installedDate: new Date(),
      });
      await user.save();
      logger.info({ email, packageName }, "Auto-installed app for developer");
    }
  } catch (error) {
    logger.error(error, "Error auto-installing app for developer");
  }
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/dev/auth/me
 * Get authenticated developer info.
 */
async function getAuthenticatedUser(c: AppContext) {
  try {
    const email = c.get("email");

    if (!email) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const user = await User.findOne({ email });

    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    return c.json({
      id: user._id,
      email: user.email,
      profile: {
        company: user.profile?.company,
        website: user.profile?.website,
        contactEmail: user.profile?.contactEmail,
        description: user.profile?.description,
        logo: user.profile?.logo,
      },
      organizations: user.organizations,
    });
  } catch (error) {
    logger.error(error, "Error getting authenticated user");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * PUT /api/dev/auth/profile
 * Update developer profile.
 */
async function updateDeveloperProfile(c: AppContext) {
  try {
    // Profile updates are handled via the account routes
    return c.json({ error: "Use /api/account/profile endpoint" }, 400);
  } catch (error) {
    logger.error(error, "Error updating developer profile");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * GET /api/dev/debug/apps
 * Debug route - returns mock data without auth.
 */
async function debugApps(c: AppContext) {
  logger.warn("Debug route hit - bypassing auth");
  return c.json([
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
}

/**
 * GET /api/dev/apps
 * Get all apps for the developer's organization.
 */
async function getDeveloperApps(c: AppContext) {
  try {
    const email = c.get("email");
    const orgId = (c as any).currentOrgId;

    if (!orgId) {
      return c.json({ error: "Organization context required" }, 400);
    }

    // Get apps by organization ID directly from the App model
    const apps = await App.find({ organizationId: orgId }).lean();

    return c.json(apps);
  } catch (error) {
    logger.error(error, "Error getting developer apps");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * POST /api/dev/apps/register
 * Create a new app.
 */
async function createApp(c: AppContext) {
  try {
    const email = c.get("email");
    const orgId = (c as any).currentOrgId;

    if (!email) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    if (!orgId) {
      return c.json({ error: "Organization context required" }, 400);
    }

    const appData = await c.req.json().catch(() => ({}));

    // Check if app already exists
    const existingApp = await appService.getApp(appData.packageName);
    if (existingApp) {
      return c.json({ error: "App with this package name already exists" }, 409);
    }

    // Create the app with developerId (required by service)
    const result = await appService.createApp(
      {
        ...appData,
        organizationId: orgId,
      },
      email,
    );

    // Auto-install for developer
    await autoInstallAppForDeveloper(email, appData.packageName);

    return c.json(result, 201);
  } catch (error) {
    logger.error(error, "Error creating app");

    // Check for duplicate key error
    if ((error as any)?.code === 11000) {
      return c.json({ error: "App with this package name already exists" }, 409);
    }

    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * GET /api/dev/apps/:packageName
 * Get a specific app by package name.
 */
async function getAppByPackageName(c: AppContext) {
  try {
    const email = c.get("email");
    const orgId = (c as any).currentOrgId;
    const packageName = c.req.param("packageName");

    if (!packageName) {
      return c.json({ error: "Package name is required" }, 400);
    }

    const appDoc = await appService.getApp(packageName);

    if (!appDoc) {
      return c.json({ error: "App not found" }, 404);
    }

    // Check if user's org owns this app
    if (orgId && appDoc.organizationId?.toString() !== orgId.toString()) {
      // Check if user is a member of the app's organization
      const user = await User.findOne({ email });
      if (user && appDoc.organizationId) {
        const isMember = await OrganizationService.isOrgMember(user, appDoc.organizationId);
        if (!isMember) {
          return c.json({ error: "Unauthorized to access this app" }, 403);
        }
      } else {
        return c.json({ error: "Unauthorized to access this app" }, 403);
      }
    }

    return c.json(appDoc);
  } catch (error) {
    logger.error(error, "Error getting app by package name");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * PUT /api/dev/apps/:packageName
 * Update an app.
 */
async function updateApp(c: AppContext) {
  try {
    const email = c.get("email");
    const orgId = (c as any).currentOrgId;
    const packageName = c.req.param("packageName");
    const appData = await c.req.json().catch(() => ({}));

    if (!packageName) {
      return c.json({ error: "Package name is required" }, 400);
    }

    if (!email) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const updatedApp = await appService.updateApp(packageName, appData, email, orgId);

    if (!updatedApp) {
      return c.json({ error: "App not found" }, 404);
    }

    return c.json(updatedApp);
  } catch (error) {
    logger.error(error, "Error updating app");
    return c.json({ error: (error as Error).message || "Internal server error" }, 500);
  }
}

/**
 * DELETE /api/dev/apps/:packageName
 * Delete an app.
 */
async function deleteApp(c: AppContext) {
  try {
    const email = c.get("email");
    const orgId = (c as any).currentOrgId;
    const packageName = c.req.param("packageName");

    if (!packageName) {
      return c.json({ error: "Package name is required" }, 400);
    }

    if (!email) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    await appService.deleteApp(packageName, email);

    return c.json({ message: "App deleted successfully" });
  } catch (error) {
    logger.error(error, "Error deleting app");
    return c.json({ error: (error as Error).message || "Internal server error" }, 500);
  }
}

/**
 * POST /api/dev/apps/:packageName/api-key
 * Regenerate API key for an app.
 */
async function regenerateApiKey(c: AppContext) {
  try {
    const email = c.get("email");
    const orgId = (c as any).currentOrgId;
    const packageName = c.req.param("packageName");

    if (!packageName) {
      return c.json({ error: "Package name is required" }, 400);
    }

    if (!email) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const apiKey = await appService.regenerateApiKey(packageName, email);

    return c.json({
      apiKey,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(error, "Error regenerating API key");
    return c.json({ error: (error as Error).message || "Internal server error" }, 500);
  }
}

/**
 * GET /api/dev/apps/:packageName/share
 * Get shareable link for an app.
 */
async function getShareableLink(c: AppContext) {
  try {
    const email = c.get("email");
    const orgId = (c as any).currentOrgId;
    const packageName = c.req.param("packageName");

    if (!packageName) {
      return c.json({ error: "Package name is required" }, 400);
    }

    const appDoc = await appService.getApp(packageName);
    if (!appDoc) {
      return c.json({ error: "App not found" }, 404);
    }

    const baseUrl = process.env.STORE_PUBLIC_URL || "https://store.mentra.glass";
    const installUrl = `${baseUrl}/app/${packageName}`;

    return c.json({ installUrl });
  } catch (error) {
    logger.error(error, "Error getting shareable link");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * POST /api/dev/apps/:packageName/share
 * Track app sharing.
 */
async function trackSharing(c: AppContext) {
  try {
    const email = c.get("email");
    const orgId = (c as any).currentOrgId;
    const packageName = c.req.param("packageName");
    const body = await c.req.json().catch(() => ({}));
    const { emails } = body as { emails?: string[] };

    if (!packageName) {
      return c.json({ error: "Package name is required" }, 400);
    }

    const appDoc = await appService.getApp(packageName);
    if (!appDoc) {
      return c.json({ error: "App not found" }, 404);
    }

    // Track sharing (could be stored in analytics or the app document)
    logger.info({ packageName, sharedWith: emails }, "App shared");

    return c.json({ success: true, sharedWith: emails });
  } catch (error) {
    logger.error(error, "Error tracking sharing");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * POST /api/dev/apps/:packageName/publish
 * Submit app for publishing.
 */
async function publishApp(c: AppContext) {
  try {
    const email = c.get("email");
    const orgId = (c as any).currentOrgId;
    const packageName = c.req.param("packageName");

    if (!packageName) {
      return c.json({ error: "Package name is required" }, 400);
    }

    // Update the app status to SUBMITTED
    const updatedApp = await App.findOneAndUpdate(
      { packageName },
      { $set: { appStoreStatus: "SUBMITTED", updatedAt: new Date() } },
      { new: true },
    );

    if (!updatedApp) {
      return c.json({ error: "App not found" }, 404);
    }

    return c.json(updatedApp);
  } catch (error) {
    logger.error(error, "Error publishing app");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * PATCH /api/dev/apps/:packageName/visibility
 * Update app visibility.
 */
async function updateAppVisibility(c: AppContext) {
  try {
    const email = c.get("email");
    const packageName = c.req.param("packageName");
    const body = await c.req.json().catch(() => ({}));

    if (!packageName) {
      return c.json({ error: "Package name is required" }, 400);
    }

    if (!email) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const updatedApp = await appService.updateAppVisibility(packageName, email, body.isPublic);

    return c.json(updatedApp);
  } catch (error) {
    logger.error(error, "Error updating app visibility");
    return c.json({ error: (error as Error).message || "Internal server error" }, 500);
  }
}

/**
 * PATCH /api/dev/apps/:packageName/share-emails
 * Update shared emails for an app.
 */
async function updateSharedEmails(c: AppContext) {
  try {
    const email = c.get("email");
    const packageName = c.req.param("packageName");
    const body = await c.req.json().catch(() => ({}));

    if (!packageName) {
      return c.json({ error: "Package name is required" }, 400);
    }

    if (!email) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Update shared emails in the app document
    const updatedApp = await App.findOneAndUpdate(
      { packageName },
      { $set: { sharedEmails: body.emails || [], updatedAt: new Date() } },
      { new: true },
    );

    if (!updatedApp) {
      return c.json({ error: "App not found" }, 404);
    }

    return c.json(updatedApp);
  } catch (error) {
    logger.error(error, "Error updating shared emails");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * POST /api/dev/apps/:packageName/move-org
 * Move app to a different organization.
 */
async function moveToOrg(c: AppContext) {
  try {
    const email = c.get("email");
    const sourceOrgId = (c as any).currentOrgId;
    const packageName = c.req.param("packageName");
    const body = await c.req.json().catch(() => ({}));
    const { targetOrgId } = body as { targetOrgId?: string };

    if (!packageName) {
      return c.json({ error: "Package name is required" }, 400);
    }

    if (!targetOrgId) {
      return c.json({ error: "Target organization ID is required" }, 400);
    }

    // Verify user has admin access to both orgs
    const user = await User.findOne({ email });
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    const hasSourceAdminAccess = await OrganizationService.isOrgAdmin(user, sourceOrgId);
    if (!hasSourceAdminAccess) {
      return c.json({ error: "Admin access required in source organization" }, 403);
    }

    const hasTargetAdminAccess = await OrganizationService.isOrgAdmin(user, targetOrgId);
    if (!hasTargetAdminAccess) {
      return c.json({ error: "Admin access required in target organization" }, 403);
    }

    // Update the app's organization
    const updatedApp = await App.findOneAndUpdate(
      { packageName },
      { $set: { organizationId: new Types.ObjectId(targetOrgId), updatedAt: new Date() } },
      { new: true },
    );

    if (!updatedApp) {
      return c.json({ error: "App not found" }, 404);
    }

    logger.info({ packageName, sourceOrgId, targetOrgId }, "App moved to new organization");

    return c.json(updatedApp);
  } catch (error) {
    logger.error(error, "Error moving app to org");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * POST /api/dev/images/upload
 * Upload an image.
 */
async function uploadImage(c: AppContext) {
  try {
    const email = c.get("email");
    const orgId = (c as any).currentOrgId;

    // Parse multipart form data
    const body = await c.req.parseBody();
    const file = body["file"] as File | undefined;
    const metadataRaw = body["metadata"] as string | undefined;
    // Console client sends replaceImageId as a separate multipart field
    const replaceImageIdField = body["replaceImageId"] as string | undefined;

    if (!file) {
      return c.json({ error: "No file provided" }, 400);
    }

    // Validate file type
    const allowedMimeTypes = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];
    if (!allowedMimeTypes.includes(file.type)) {
      return c.json(
        {
          error:
            "Invalid file type. Only PNG, JPEG, GIF, and WebP images are allowed. Please convert your image and try again.",
        },
        400,
      );
    }

    // Validate file size
    const MAX_SIZE = 10 * 1024 * 1024; // 10MB backend limit
    if (file.size > MAX_SIZE) {
      return c.json(
        {
          error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum size is 10MB. Please compress your image or use a smaller file.`,
        },
        400,
      );
    }

    // Parse metadata
    let metadata: any = {};
    if (metadataRaw) {
      try {
        metadata = JSON.parse(metadataRaw);
      } catch (e) {
        logger.warn("Failed to parse metadata");
      }
    }

    // Get storage service dynamically
    let StorageServiceClass;
    try {
      StorageServiceClass = (await import("../../../services/storage/storage.service")).StorageService;
    } catch (error) {
      logger.error(error, "Failed to import storage service");
      return c.json({ error: "Storage service not available" }, 500);
    }

    const storageService = new StorageServiceClass(logger);

    // Get file buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Upload the image using uploadImageAndReplace
    // Priority: replaceImageId from multipart field > replaceImageId from metadata > empty string
    const replaceImageId = replaceImageIdField || metadata?.replaceImageId || "";

    const result = await storageService.uploadImageAndReplace({
      image: buffer,
      filename: file.name,
      mimetype: file.type,
      email: email || "",
      orgId: orgId,
      replaceImageId,
      appPackageName: metadata?.appPackageName,
    });

    return c.json({
      url: result.url,
      imageId: result.imageId,
    });
  } catch (error) {
    logger.error(error, "Error uploading image");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * DELETE /api/dev/images/:imageId
 * Delete an image.
 */
async function deleteImage(c: AppContext) {
  try {
    const email = c.get("email");
    const orgId = (c as any).currentOrgId;
    const encodedImageId = c.req.param("imageId");

    if (!encodedImageId) {
      return c.json({ error: "Image ID is required" }, 400);
    }

    // Decode the imageId since it may contain slashes (e.g., R2 object keys like "mini_app_assets/orgs/.../file.png")
    const imageId = decodeURIComponent(encodedImageId);

    logger.info({ imageId, encodedImageId }, "Deleting image");

    // Get storage service dynamically
    let StorageServiceClass;
    try {
      StorageServiceClass = (await import("../../../services/storage/storage.service")).StorageService;
    } catch (error) {
      logger.error(error, "Failed to import storage service");
      return c.json({ error: "Storage service not available" }, 500);
    }

    const storageService = new StorageServiceClass(logger);
    await storageService.deleteImage(imageId);

    return c.json({ success: true, message: "Image deleted successfully" });
  } catch (error) {
    logger.error(error, "Error deleting image");
    return c.json({ error: "Internal server error" }, 500);
  }
}

export default app;
