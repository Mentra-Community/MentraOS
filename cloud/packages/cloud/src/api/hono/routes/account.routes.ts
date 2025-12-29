/**
 * @fileoverview Hono account routes.
 * User profile and account management endpoints.
 * Mounted at: /api/account
 */

import { Hono } from "hono";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import { User } from "../../../models/user.model";
import { GalleryPhoto } from "../../../models/gallery-photo.model";
import UserSession from "../../../services/session/UserSession";
import appService from "../../../services/core/app.service";
import { tokenService } from "../../../services/core/temp-token.service";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "account.routes" });

const app = new Hono<AppEnv>();

const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || "";

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// In-memory store for export requests
interface ExportRequest {
  id: string;
  userId: string;
  email: string;
  format: "json" | "csv";
  status: "pending" | "processing" | "completed" | "failed";
  createdAt: Date;
  completedAt?: Date;
  downloadUrl?: string;
  filePath?: string;
}

const exportRequests = new Map<string, ExportRequest>();

// Directory for storing exports
const EXPORTS_DIR = path.join(process.cwd(), "exports");

// Create exports directory if it doesn't exist
if (!fs.existsSync(EXPORTS_DIR)) {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
}

// Clean up old export files periodically
const cleanupExpiredExports = () => {
  const now = new Date();
  for (const [id, request] of exportRequests.entries()) {
    if (request.createdAt.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
      if (request.filePath && fs.existsSync(request.filePath)) {
        fs.unlinkSync(request.filePath);
      }
      exportRequests.delete(id);
    }
  }
};

// Run cleanup every hour
setInterval(cleanupExpiredExports, 60 * 60 * 1000);

// ============================================================================
// Routes
// ============================================================================

app.get("/me", validateCoreToken, getProfile);
app.put("/profile", validateCoreToken, updateProfile);
app.post("/request-deletion", validateCoreToken, requestDeletion);
app.post("/request-export", validateCoreToken, requestExport);
app.get("/export-status", validateCoreToken, getExportStatus);
app.get("/download-export/:id", validateCoreToken, downloadExport);
app.get("/privacy", validateCoreToken, getPrivacySettings);
app.put("/privacy", validateCoreToken, updatePrivacySettings);
app.get("/oauth/app/:packageName", validateCoreToken, getAppInfo);
app.post("/oauth/token", validateCoreToken, generateOAuthToken);

// ============================================================================
// Middleware
// ============================================================================

/**
 * Middleware to validate core token.
 */
async function validateCoreToken(c: AppContext, next: () => Promise<void>) {
  const authHeader = c.req.header("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;

    if (!decoded || !decoded.email) {
      return c.json({ error: "Invalid token data" }, 401);
    }

    c.set("email", decoded.email.toLowerCase());
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
 * Performs comprehensive cleanup of all user data across the system.
 */
async function performCompleteUserDataCleanup(userEmail: string, supabaseUserId: string): Promise<void> {
  logger.info({ userEmail, supabaseUserId }, "Starting comprehensive user data cleanup");

  try {
    // 1. Terminate all active sessions
    try {
      const activeSession = UserSession.getById(userEmail);
      activeSession?.dispose();
      logger.info({ userEmail }, "Active session terminated during cleanup");
    } catch (error) {
      logger.warn({ error, userEmail }, "Error terminating active sessions during cleanup");
    }

    // 2. Delete gallery photos and associated files
    try {
      const deleteResult = await GalleryPhoto.deleteMany({ userEmail });
      logger.info({ userEmail, deleteResult }, "Gallery photos cleaned up");
    } catch (error) {
      logger.error({ error, userEmail }, "Error cleaning up gallery photos");
    }

    // 3. Delete user document from MongoDB
    try {
      const user = await User.findByEmail(userEmail);
      if (user) {
        await User.deleteOne({ email: userEmail });
        logger.info({ userEmail }, "User document deleted from MongoDB");
      }
    } catch (error) {
      logger.error({ error, userEmail }, "Error deleting user from MongoDB");
    }

    // 4. Clean up any organization memberships
    try {
      const Organization = require("../../../models/organization.model").Organization;
      await Organization.updateMany({ "members.userId": userEmail }, { $pull: { members: { userId: userEmail } } });
      logger.info({ userEmail }, "Organization memberships cleaned up");
    } catch (error) {
      logger.warn({ error, userEmail }, "Error cleaning up organization memberships");
    }

    logger.info({ userEmail, supabaseUserId }, "Comprehensive user data cleanup completed successfully");
  } catch (error) {
    logger.error({ error, userEmail, supabaseUserId }, "Error during comprehensive user data cleanup");
  }
}

/**
 * Generate export data for a user.
 */
async function generateExport(request: ExportRequest): Promise<void> {
  try {
    request.status = "processing";

    // Get user data from Supabase
    const { data: userData, error: userError } = await supabase
      .from("auth.users")
      .select("*")
      .eq("email", request.email)
      .single();

    const exportData = {
      user: {
        id: userData?.id,
        email: userData?.email,
        created_at: userData?.created_at,
        metadata: userData?.user_metadata,
      },
      apps: [], // TODO: Add installed apps
      devices: [], // TODO: Add registered devices
      settings: {}, // TODO: Add user settings
    };

    const filename = `${request.id}.${request.format}`;
    const filePath = path.join(EXPORTS_DIR, filename);

    if (request.format === "json") {
      fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2));
    } else {
      // CSV format - simplified
      const csvContent = `email,created_at\n${userData?.email},${userData?.created_at}`;
      fs.writeFileSync(filePath, csvContent);
    }

    request.status = "completed";
    request.completedAt = new Date();
    request.filePath = filePath;
    request.downloadUrl = `/api/account/export-download/${request.id}`;
  } catch (error) {
    logger.error(error, "Error generating export");
    request.status = "failed";
  }
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/account/me
 * Get user profile information.
 */
async function getProfile(c: AppContext) {
  try {
    const userEmail = c.get("email");

    if (!userEmail) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const { data: user, error } = await supabase.from("auth.users").select("*").eq("email", userEmail).single();

    if (error) {
      logger.error(error, "Error fetching user data:");
      return c.json({ error: "Failed to fetch user data" }, 500);
    }

    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    return c.json({
      id: user.id,
      email: user.email,
      name: user.user_metadata?.name,
      profile: user.user_metadata?.profile,
      createdAt: user.created_at,
    });
  } catch (error) {
    logger.error(error, "Error in /account/me:");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * PUT /api/account/profile
 * Update user profile.
 */
async function updateProfile(c: AppContext) {
  try {
    const userEmail = c.get("email");

    if (!userEmail) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const body = await c.req.json().catch(() => ({}));
    const { name, displayName, phoneNumber, ...otherFields } = body;

    const { data: user, error } = await supabase.from("auth.users").select("*").eq("email", userEmail).single();

    if (error) {
      logger.error(error, "Error fetching user data:");
      return c.json({ error: "Failed to fetch user data" }, 500);
    }

    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: {
        ...user.user_metadata,
        name,
        profile: {
          ...user.user_metadata?.profile,
          displayName,
          phoneNumber,
          ...otherFields,
        },
      },
    });

    if (updateError) {
      logger.error(updateError, "Error updating user:");
      return c.json({ error: "Failed to update user profile" }, 500);
    }

    return c.json({
      id: user.id,
      email: user.email,
      name,
      profile: {
        displayName,
        phoneNumber,
        ...otherFields,
      },
    });
  } catch (error) {
    logger.error(error, "Error in /account/profile:");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * POST /api/account/request-deletion
 * Delete account immediately.
 */
async function requestDeletion(c: AppContext) {
  try {
    const userEmail = c.get("email");

    if (!userEmail) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const body = await c.req.json().catch(() => ({}));
    const { reason } = body;

    logger.info({ userEmail, reason }, "Account deletion requested");

    const { data: user, error } = await supabase.from("auth.users").select("*").eq("email", userEmail).single();

    if (error) {
      logger.error(error, "Error fetching user data:");
      return c.json({ error: "Failed to fetch user data" }, 500);
    }

    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    const { error: deleteError } = await supabase.auth.admin.deleteUser(user.id);

    if (deleteError) {
      logger.error(deleteError, "Error deleting user:");
      return c.json({ error: "Failed to delete user account" }, 500);
    }

    await performCompleteUserDataCleanup(userEmail, user.id);

    logger.info({ userEmail }, "Account deleted successfully");

    return c.json({
      success: true,
      message: "Account deleted successfully",
    });
  } catch (error) {
    logger.error(error, "Error in /account/request-deletion:");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * POST /api/account/request-export
 * Request data export.
 */
async function requestExport(c: AppContext) {
  try {
    const userEmail = c.get("email");

    if (!userEmail) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const body = await c.req.json().catch(() => ({}));
    const { format = "json" } = body as { format?: "json" | "csv" };

    const { data: user, error } = await supabase.from("auth.users").select("*").eq("email", userEmail).single();

    if (error) {
      logger.error(error, "Error fetching user data:");
      return c.json({ error: "Failed to fetch user data" }, 500);
    }

    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    const exportId = `export_${crypto.randomBytes(8).toString("hex")}`;
    const now = new Date();
    const exportRequest: ExportRequest = {
      id: exportId,
      userId: user.id,
      email: userEmail,
      format,
      status: "pending",
      createdAt: now,
    };

    exportRequests.set(exportId, exportRequest);

    // Start generating export in the background
    generateExport(exportRequest);

    return c.json({
      id: exportId,
      status: "pending",
      message: "Export request submitted. You can check the status using the export-status endpoint.",
    });
  } catch (error) {
    logger.error(error, "Error in /account/request-export:");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * GET /api/account/export-status/:id
 * Check export status.
 */
async function getExportStatus(c: AppContext) {
  try {
    const userEmail = c.get("email");
    const id = c.req.query("id");

    if (!userEmail) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    if (!id) {
      return c.json({ error: "Export ID is required" }, 400);
    }

    const exportRequest = exportRequests.get(id);

    if (!exportRequest) {
      return c.json({ error: "Export request not found" }, 404);
    }

    if (exportRequest.email !== userEmail) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    return c.json({
      id: exportRequest.id,
      status: exportRequest.status,
      format: exportRequest.format,
      createdAt: exportRequest.createdAt,
      completedAt: exportRequest.completedAt,
      downloadUrl: exportRequest.status === "completed" ? exportRequest.downloadUrl : undefined,
    });
  } catch (error) {
    logger.error(error, "Error in /account/export-status:");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * GET /api/account/export-download/:id
 * Download export file.
 */
async function downloadExport(c: AppContext) {
  try {
    const userEmail = c.get("email");
    const id = c.req.param("id");

    if (!userEmail) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const exportRequest = exportRequests.get(id);

    if (!exportRequest) {
      return c.json({ error: "Export request not found" }, 404);
    }

    if (exportRequest.email !== userEmail) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    if (exportRequest.status !== "completed" || !exportRequest.filePath) {
      return c.json({ error: "Export not ready" }, 400);
    }

    if (!fs.existsSync(exportRequest.filePath)) {
      return c.json({ error: "Export file not found" }, 404);
    }

    const filename = `mentra-export-${exportRequest.id}.${exportRequest.format}`;
    const file = Bun.file(exportRequest.filePath);

    return new Response(file, {
      headers: {
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Type": exportRequest.format === "json" ? "application/json" : "text/csv",
      },
    });
  } catch (error) {
    logger.error(error, "Error in /account/export-download:");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * GET /api/account/privacy-settings
 * Get privacy settings.
 */
async function getPrivacySettings(c: AppContext) {
  try {
    const userEmail = c.get("email");

    if (!userEmail) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const { data: user, error } = await supabase.from("auth.users").select("*").eq("email", userEmail).single();

    if (error) {
      logger.error(error, "Error fetching user data:");
      return c.json({ error: "Failed to fetch user data" }, 500);
    }

    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    const privacySettings = {
      shareUsageData: user.user_metadata?.privacy?.shareUsageData ?? true,
      receiveNotifications: user.user_metadata?.privacy?.receiveNotifications ?? true,
      allowDataCollection: user.user_metadata?.privacy?.allowDataCollection ?? true,
    };

    return c.json(privacySettings);
  } catch (error) {
    logger.error(error, "Error in /account/privacy-settings:");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * PUT /api/account/privacy-settings
 * Update privacy settings.
 */
async function updatePrivacySettings(c: AppContext) {
  try {
    const userEmail = c.get("email");

    if (!userEmail) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const settings = await c.req.json().catch(() => ({}));

    const { data: user, error } = await supabase.from("auth.users").select("*").eq("email", userEmail).single();

    if (error) {
      logger.error(error, "Error fetching user data:");
      return c.json({ error: "Failed to fetch user data" }, 500);
    }

    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: {
        ...user.user_metadata,
        privacy: settings,
      },
    });

    if (updateError) {
      logger.error(updateError, "Error updating privacy settings:");
      return c.json({ error: "Failed to update privacy settings" }, 500);
    }

    return c.json(settings);
  } catch (error) {
    logger.error(error, "Error in /account/privacy-settings:");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * GET /api/account/app/:packageName
 * Get app info for a user.
 */
async function getAppInfo(c: AppContext) {
  try {
    const packageName = c.req.param("packageName");
    const userEmail = c.get("email");

    if (!userEmail) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    if (!packageName) {
      return c.json({ error: "Package name is required" }, 400);
    }

    const appDoc = await appService.getApp(packageName);

    if (!appDoc) {
      return c.json({ error: "App not found" }, 404);
    }

    // Check if user has the app installed
    const user = await User.findOne({ email: userEmail });
    const isInstalled = user?.installedApps?.some((app) => app.packageName === packageName) ?? false;

    if (!isInstalled && appDoc.appStoreStatus !== "PUBLISHED") {
      return c.json({ error: "App not found" }, 404);
    }

    return c.json({
      success: true,
      app: {
        name: appDoc.name,
        packageName: appDoc.packageName,
        webviewURL: appDoc.webviewURL,
        description: appDoc.description,
        icon: appDoc.logoURL,
      },
    });
  } catch (error) {
    logger.error(error, "Error in /account/app/:packageName:");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * GET /api/account/app/:packageName/webview-token
 * Get a signed token for webview authentication.
 */
/**
 * POST /api/account/oauth/token
 * Generate signed user token for OAuth flow.
 */
async function generateOAuthToken(c: AppContext) {
  try {
    const userEmail = c.get("email");
    const body = await c.req.json().catch(() => ({}));
    const { packageName } = body;

    if (!userEmail) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    if (!packageName) {
      return c.json({ error: "Package name is required" }, 400);
    }

    const signedToken = await tokenService.issueUserToken(userEmail, packageName);

    logger.info(`Generated OAuth token for user ${userEmail} and app ${packageName}`);

    return c.json({
      success: true,
      token: signedToken,
      expiresIn: "10m",
    });
  } catch (error) {
    logger.error(error, "Error in /account/oauth/token:");
    return c.json({ error: "Failed to generate authentication token" }, 500);
  }
}

export default app;
