import { Router, Request, Response } from "express";
import { validateCoreToken } from "../middleware/supabaseMiddleware";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { User } from "../models/user.model";
import { GalleryPhoto } from "../models/gallery-photo.model";
// Email service import removed - no longer needed for account deletion
import { logger } from "../services/logging/pino-logger";
import UserSession from "../services/session/UserSession";

const router = Router();

// Initialize Supabase client using environment variables
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || "";

if (!supabaseUrl || !supabaseServiceKey) {
  logger.error("Missing Supabase environment variables");
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// In-memory store for export requests (in a real app, use a database)
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

/**
 * Performs comprehensive cleanup of all user data across the system
 */
async function performCompleteUserDataCleanup(
  userEmail: string,
  supabaseUserId: string,
): Promise<void> {
  logger.info(
    { userEmail, supabaseUserId },
    "Starting comprehensive user data cleanup",
  );

  try {
    // 1. Terminate all active sessions
    try {
      const activeSession = UserSession.getById(userEmail);
      activeSession?.dispose();
      logger.info({ userEmail }, "Active session terminated during cleanup");
    } catch (error) {
      logger.warn(
        { error, userEmail },
        "Error terminating active sessions during cleanup",
      );
    }

    // 2. Delete gallery photos and associated files
    try {
      const deleteResult = await GalleryPhoto.deleteMany({ userEmail });
      logger.info({ userEmail, deleteResult }, "Cleaning up gallery photos");
      // TODO(isaiah): Rn these aren't saved on server or in cloud, so if we add cloud storage, we should delete the files as well.

      // Delete all gallery photo records
      await GalleryPhoto.deleteMany({ userEmail });
      logger.info({ userEmail }, "Gallery photos cleaned up");
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
      const Organization = require("../models/organization.model").Organization;
      await Organization.updateMany(
        { "members.userId": userEmail },
        { $pull: { members: { userId: userEmail } } },
      );
      logger.info({ userEmail }, "Organization memberships cleaned up");
    } catch (error) {
      logger.warn(
        { error, userEmail },
        "Error cleaning up organization memberships",
      );
    }

    logger.info(
      { userEmail, supabaseUserId },
      "Comprehensive user data cleanup completed successfully",
    );
  } catch (error) {
    logger.error(
      { error, userEmail, supabaseUserId },
      "Error during comprehensive user data cleanup",
    );
    // Don't throw - we want to complete the deletion even if some cleanup fails
  }
}

// Directory for storing exports
const EXPORTS_DIR = path.join(process.cwd(), "exports");

// Create exports directory if it doesn't exist
if (!fs.existsSync(EXPORTS_DIR)) {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
}

// Clean up old export files periodically
const cleanupExpiredExports = () => {
  const now = new Date();

  // Clean up old export files (older than 24 hours)
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

/**
 * Get user profile information
 * GET /api/account/me
 */
router.get("/me", validateCoreToken, async (req: Request, res: Response) => {
  try {
    const userEmail = (req as any).email;

    if (!userEmail) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Get user from Supabase
    // const { data: userData, error } = await supabase.auth.admin.listUsers({
    //   filter: {
    //     email: userEmail,
    //   }
    // });
    const { data: user, error } = await supabase
      .from("auth.users")
      .select("*")
      .eq("email", userEmail)
      .single();

    if (error) {
      logger.error(error as Error, "Error fetching user data:");
      return res.status(500).json({ error: "Failed to fetch user data" });
    }

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Return user profile data
    res.json({
      id: user.id,
      email: user.email,
      name: user.user_metadata?.name,
      profile: user.user_metadata?.profile,
      createdAt: user.created_at,
    });
  } catch (error) {
    logger.error(error as Error, "Error in /account/me:");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Update user profile
 * PUT /api/account/profile
 */
router.put(
  "/profile",
  validateCoreToken,
  async (req: Request, res: Response) => {
    try {
      const userEmail = (req as any).email;
      const { name, displayName, phoneNumber, ...otherFields } = req.body;

      if (!userEmail) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Find the user by email
      // const { data: userData, error: findError } = await supabase.auth.admin.listUsers({
      //   filter: {
      //     email: userEmail,
      //   }
      // });

      // if (findError) {
      //   logger.error('Error finding user:', findError);
      //   return res.status(500).json({ error: 'Failed to find user' });
      // }

      // if (!userData || userData.users.length === 0) {
      //   return res.status(404).json({ error: 'User not found' });
      // }

      // const user = userData.users[0];

      const { data: user, error } = await supabase
        .from("auth.users")
        .select("*")
        .eq("email", userEmail)
        .single();

      if (error) {
        logger.error(error as Error, "Error fetching user data:");
        return res.status(500).json({ error: "Failed to fetch user data" });
      }

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Update user metadata
      const { error: updateError } = await supabase.auth.admin.updateUserById(
        user.id,
        {
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
        },
      );

      if (updateError) {
        logger.error(updateError as Error, "Error updating user:");
        return res.status(500).json({ error: "Failed to update user profile" });
      }

      // Return updated profile
      res.json({
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
      logger.error(error as Error, "Error in /account/profile:");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * Delete account immediately
 * POST /api/account/request-deletion
 *
 * This endpoint immediately deletes the user account without email verification
 * since the mobile app already has a 3-step confirmation process
 */
router.post(
  "/request-deletion",
  validateCoreToken,
  async (req: Request, res: Response) => {
    try {
      const userEmail = (req as any).email;
      const { reason } = req.body;

      if (!userEmail) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      logger.info({ userEmail, reason }, "Account deletion requested");

      const { data: user, error } = await supabase
        .from("auth.users")
        .select("*")
        .eq("email", userEmail)
        .single();

      if (error) {
        logger.error(error as Error, "Error fetching user data:");
        return res.status(500).json({ error: "Failed to fetch user data" });
      }

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Delete the user from Supabase immediately
      const { error: deleteError } = await supabase.auth.admin.deleteUser(
        user.id,
      );

      if (deleteError) {
        logger.error(deleteError as Error, "Error deleting user:");
        return res.status(500).json({ error: "Failed to delete user account" });
      }

      // Perform comprehensive data cleanup
      await performCompleteUserDataCleanup(userEmail, user.id);

      logger.info({ userEmail }, "Account deleted successfully");

      res.json({
        success: true,
        message: "Account deleted successfully",
      });
    } catch (error) {
      logger.error(error as Error, "Error in /account/request-deletion:");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// The confirm-deletion endpoint has been removed since we now delete accounts immediately
// without email verification. The mobile app already has a 3-step confirmation process.

/**
 * Request data export
 * POST /api/account/request-export
 */
router.post(
  "/request-export",
  validateCoreToken,
  async (req: Request, res: Response) => {
    try {
      const userEmail = (req as any).email;
      const { format = "json" } = req.body;

      if (!userEmail) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Find the user by email
      // const { data: userData, error: findError } = await supabase.auth.admin.listUsers({
      //   filter: {
      //     email: userEmail,
      //   }
      // });

      // if (findError) {
      //   logger.error('Error finding user:', findError);
      //   return res.status(500).json({ error: 'Failed to find user' });
      // }

      // if (!userData || userData.users.length === 0) {
      //   return res.status(404).json({ error: 'User not found' });
      // }

      // const user = userData.users[0];

      const { data: user, error } = await supabase
        .from("auth.users")
        .select("*")
        .eq("email", userEmail)
        .single();

      if (error) {
        logger.error(error as Error, "Error fetching user data:");
        return res.status(500).json({ error: "Failed to fetch user data" });
      }

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Create export request
      const exportId = `export_${crypto.randomBytes(8).toString("hex")}`;
      const now = new Date();

      const exportRequest: ExportRequest = {
        id: exportId,
        userId: user.id,
        email: userEmail,
        format: format as "json" | "csv",
        status: "pending",
        createdAt: now,
      };

      exportRequests.set(exportId, exportRequest);

      // Start generating the export asynchronously
      generateExport(exportRequest)
        .then(() => {
          logger.info(`Export ${exportId} completed successfully`);
        })
        .catch((error) => {
          logger.error(`Error generating export ${exportId}:`, error);
          const request = exportRequests.get(exportId);
          if (request) {
            request.status = "failed";
            exportRequests.set(exportId, request);
          }
        });

      // Return immediately with the export ID
      res.json({
        id: exportId,
        status: "pending",
        message:
          "Export request submitted successfully. The export is being processed.",
      });
    } catch (error) {
      logger.error(error as Error, "Error in /account/request-export:");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * Generate export data
 */
async function generateExport(exportRequest: ExportRequest): Promise<void> {
  try {
    // Update status to processing
    exportRequest.status = "processing";
    exportRequests.set(exportRequest.id, exportRequest);

    // Simulate processing time
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Get user data from Supabase
    const { data: userData, error: userError } =
      await supabase.auth.admin.getUserById(exportRequest.userId);

    if (userError || !userData.user) {
      throw new Error(`Failed to fetch user data: ${userError?.message}`);
    }

    // Prepare export data
    const exportData = {
      user: {
        id: userData.user.id,
        email: userData.user.email,
        created_at: userData.user.created_at,
        metadata: userData.user.user_metadata,
      },
      // In a real implementation, fetch additional user data from other systems
      apps: [],
      devices: [],
      settings: {},
    };

    // Create export file
    const filename = `export-${exportRequest.userId}-${Date.now()}.${exportRequest.format}`;
    const filePath = path.join(EXPORTS_DIR, filename);

    if (exportRequest.format === "json") {
      fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2));
    } else {
      // In a real implementation, convert to CSV
      // For now, just write the JSON as a string
      fs.writeFileSync(filePath, JSON.stringify(exportData));
    }

    // Update export request
    exportRequest.status = "completed";
    exportRequest.completedAt = new Date();
    exportRequest.filePath = filePath;
    exportRequest.downloadUrl = `/api/account/download-export/${exportRequest.id}`;

    exportRequests.set(exportRequest.id, exportRequest);
  } catch (error) {
    logger.error(error as Error, "Error generating export:");
    exportRequest.status = "failed";
    exportRequests.set(exportRequest.id, exportRequest);
    throw error;
  }
}

/**
 * Get export status
 * GET /api/account/export-status
 */
router.get(
  "/export-status",
  validateCoreToken,
  async (req: Request, res: Response) => {
    try {
      const userEmail = (req as any).email;
      const { id } = req.query;

      if (!userEmail) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      if (!id) {
        return res.status(400).json({ error: "Export ID is required" });
      }

      // Check if the export request exists
      const exportRequest = exportRequests.get(id as string);

      if (!exportRequest) {
        return res.status(404).json({ error: "Export request not found" });
      }

      // Check if the request belongs to the user
      if (exportRequest.email !== userEmail) {
        return res
          .status(403)
          .json({ error: "Not authorized to access this export" });
      }

      // Return export status
      res.json({
        id: exportRequest.id,
        status: exportRequest.status,
        format: exportRequest.format,
        createdAt: exportRequest.createdAt,
        completedAt: exportRequest.completedAt,
        downloadUrl:
          exportRequest.status === "completed"
            ? exportRequest.downloadUrl
            : undefined,
      });
    } catch (error) {
      logger.error(error as Error, "Error in /account/export-status:");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * Download export
 * GET /api/account/download-export/:id
 */
router.get(
  "/download-export/:id",
  validateCoreToken,
  async (req: Request, res: Response) => {
    try {
      const userEmail = (req as any).email;
      const { id } = req.params;

      if (!userEmail) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Check if the export request exists
      const exportRequest = exportRequests.get(id);

      if (!exportRequest) {
        return res.status(404).json({ error: "Export not found" });
      }

      // Check if the request belongs to the user
      if (exportRequest.email !== userEmail) {
        return res
          .status(403)
          .json({ error: "Not authorized to access this export" });
      }

      // Check if the export is completed
      if (exportRequest.status !== "completed") {
        return res
          .status(400)
          .json({ error: "Export is not ready for download" });
      }

      // Check if the file exists
      if (!exportRequest.filePath || !fs.existsSync(exportRequest.filePath)) {
        return res.status(404).json({ error: "Export file not found" });
      }

      // Set headers for file download
      const filename = path.basename(exportRequest.filePath);
      res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

      if (exportRequest.format === "json") {
        res.setHeader("Content-Type", "application/json");
      } else {
        res.setHeader("Content-Type", "text/csv");
      }

      // Stream the file to the response
      const fileStream = fs.createReadStream(exportRequest.filePath);
      fileStream.pipe(res);
    } catch (error) {
      logger.error(error as Error, "Error in /account/download-export:");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * Get privacy settings
 * GET /api/account/privacy
 */
router.get(
  "/privacy",
  validateCoreToken,
  async (req: Request, res: Response) => {
    try {
      const userEmail = (req as any).email;

      if (!userEmail) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Find the user by email
      // const { data: userData, error: findError } = await supabase.auth.admin.listUsers({
      //   filter: {
      //     email: userEmail,
      //   }
      // });

      // if (findError) {
      //   logger.error('Error finding user:', findError);
      //   return res.status(500).json({ error: 'Failed to find user' });
      // }

      // if (!userData || userData.users.length === 0) {
      //   return res.status(404).json({ error: 'User not found' });
      // }

      // const user = userData.users[0];

      const { data: user, error } = await supabase
        .from("auth.users")
        .select("*")
        .eq("email", userEmail)
        .single();

      if (error) {
        logger.error(error as Error, "Error fetching user data:");
        return res.status(500).json({ error: "Failed to fetch user data" });
      }

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Return privacy settings or defaults if not set
      const privacySettings = user.user_metadata?.privacy || {
        shareUsageData: true,
        receiveNotifications: true,
        allowDataCollection: true,
      };

      res.json(privacySettings);
    } catch (error) {
      logger.error(error as Error, "Error in /account/privacy:");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * Update privacy settings
 * PUT /api/account/privacy
 */
router.put(
  "/privacy",
  validateCoreToken,
  async (req: Request, res: Response) => {
    try {
      const userEmail = (req as any).email;
      const settings = req.body;

      if (!userEmail) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // // Find the user by email
      // const { data: userData, error: findError } = await supabase.auth.admin.listUsers({
      //   filter: {
      //     email: userEmail,
      //   }
      // });

      // if (findError) {
      //   logger.error('Error finding user:', findError);
      //   return res.status(500).json({ error: 'Failed to find user' });
      // }

      // if (!userData || userData.users.length === 0) {
      //   return res.status(404).json({ error: 'User not found' });
      // }

      // const user = userData.users[0];

      const { data: user, error } = await supabase
        .from("auth.users")
        .select("*")
        .eq("email", userEmail)
        .single();

      if (error) {
        logger.error(error as Error, "Error fetching user data:");
        return res.status(500).json({ error: "Failed to fetch user data" });
      }

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Update privacy settings
      const { error: updateError } = await supabase.auth.admin.updateUserById(
        user.id,
        {
          user_metadata: {
            ...user.user_metadata,
            privacy: settings,
          },
        },
      );

      if (updateError) {
        logger.error(updateError as Error, "Error updating privacy settings:");
        return res
          .status(500)
          .json({ error: "Failed to update privacy settings" });
      }

      res.json(settings);
    } catch (error) {
      logger.error(error as Error, "Error in /account/privacy:");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * Get app details by package name for OAuth flow
 * GET /api/account/oauth/app/:packageName
 *
 * Returns app details including webviewURL for OAuth redirect
 */
router.get(
  "/oauth/app/:packageName",
  validateCoreToken,
  async (req: Request, res: Response) => {
    try {
      const { packageName } = req.params;
      const userEmail = (req as any).email;

      if (!userEmail) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      if (!packageName) {
        return res.status(400).json({ error: "Package name is required" });
      }

      // Import app service
      const { appService } = await import("../services/core/app.service");

      // Get app details
      const app = await appService.getApp(packageName);

      if (!app) {
        logger.error(`App not found for package: ${packageName}`);
        return res.status(404).json({ error: "App not found" });
      }

      // Check if app has a webview URL
      if (!app.webviewURL) {
        logger.error(
          `App ${packageName} does not have a webview URL configured`,
        );
        return res
          .status(400)
          .json({ error: "App does not support web authentication" });
      }

      // Return app details
      res.json({
        success: true,
        app: {
          name: app.name,
          packageName: app.packageName,
          webviewURL: app.webviewURL,
          description: app.description,
          icon: app.logoURL,
        },
      });
    } catch (error) {
      logger.error(error as Error, "Error in /account/oauth/app:");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * Generate signed user token for OAuth flow
 * POST /api/account/oauth/token
 *
 * Generates a signed JWT token for app authentication
 */
router.post(
  "/oauth/token",
  validateCoreToken,
  async (req: Request, res: Response) => {
    try {
      const { packageName } = req.body;
      const userEmail = (req as any).email;

      if (!userEmail) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      if (!packageName) {
        return res.status(400).json({ error: "Package name is required" });
      }

      // Import token service
      const { tokenService } = await import(
        "../services/core/temp-token.service"
      );

      // Generate signed user token
      const signedToken = await tokenService.issueUserToken(
        userEmail,
        packageName,
      );

      logger.info(
        `Generated OAuth token for user ${userEmail} and app ${packageName}`,
      );

      res.json({
        success: true,
        token: signedToken,
        expiresIn: "10m",
      });
    } catch (error) {
      logger.error(error as Error, "Error in /account/oauth/token:");
      res
        .status(500)
        .json({ error: "Failed to generate authentication token" });
    }
  },
);

export default router;
