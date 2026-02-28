/**
 * @fileoverview Hono photos routes.
 * Handle photo uploads from smart glasses.
 * Mounted at: /api/photos
 */

import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import jwt from "jsonwebtoken";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import photoTakenService from "../../../services/core/photo-taken.service";
import UserSession from "../../../services/session/UserSession";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "photos.routes" });

const app = new Hono<AppEnv>();

const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

// ============================================================================
// Routes
// ============================================================================

app.post("/upload", validateGlassesAuth, uploadPhoto);
app.get("/test", testEndpoint);

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Clean up old photos from the upload directory.
 * Removes photos older than 5 minutes.
 */
async function cleanupOldPhotos(uploadDir: string) {
  try {
    const files = await fs.promises.readdir(uploadDir);
    const now = Date.now();
    const fiveMinutesAgo = now - 5 * 60 * 1000;

    for (const file of files) {
      const filePath = path.join(uploadDir, file);
      const stats = await fs.promises.stat(filePath);

      // Check if file is older than 5 minutes
      if (stats.mtimeMs < fiveMinutesAgo) {
        await fs.promises.unlink(filePath);
        logger.info(`Deleted old photo: ${file}`);
      }
    }
  } catch (error) {
    logger.error(error, "Error cleaning up old photos:");
  }
}

// ============================================================================
// Middleware
// ============================================================================

/**
 * Middleware to validate glasses authentication.
 * Checks JWT token from Authorization header.
 */
async function validateGlassesAuth(c: AppContext, next: () => Promise<void>) {
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
    // Store decoded token for access in handlers
    (c as any).decodedToken = decoded;

    await next();
  } catch (error) {
    logger.debug({ error }, "Token verification failed");
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /api/photos/upload
 * Upload a photo from smart glasses.
 * Requires glasses authentication.
 */
async function uploadPhoto(c: AppContext) {
  try {
    const userEmail = c.get("email");

    // Parse multipart form data
    const body = await c.req.parseBody();
    const file = body["file"] as File | undefined;
    const metadataRaw = body["metadata"] as string | undefined;

    // Parse metadata
    let metadata: { requestId?: string } = {};
    try {
      metadata = JSON.parse(metadataRaw || "{}");
    } catch (error) {
      logger.error(error, "Failed to parse metadata:");
      return c.json({ error: "Invalid metadata format" }, 400);
    }

    const { requestId } = metadata;

    logger.info(`Processing upload for requestId: ${requestId}`);

    if (!requestId) {
      return c.json({ error: "Request ID is required" }, 400);
    }

    // Validate file
    if (!file) {
      return c.json({ error: "No photo uploaded" }, 400);
    }

    // Check mimetype
    if (!file.type || !file.type.startsWith("image/")) {
      return c.json({ error: `Invalid file type: ${file.type}` }, 400);
    }

    // Check file size (10MB limit)
    if (file.size > 10 * 1024 * 1024) {
      return c.json({ error: "File too large. Maximum size is 10MB" }, 400);
    }

    // Get file buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (!buffer || buffer.length === 0) {
      logger.error(
        {
          file: {
            name: file.name,
            type: file.type,
            size: file.size,
          },
        },
        "File buffer is missing:",
      );
      return c.json({ error: "Invalid file data - no buffer" }, 400);
    }

    // Get the user session
    // Note: Using hardcoded email for backwards compatibility with original implementation
    const userSession = UserSession.getById(userEmail || "loriamistadi75@gmail.com");
    if (!userSession) {
      logger.error(`User session not found for ${userEmail}`);
      return c.json({ error: "User session not found" }, 404);
    }

    // Save the file to disk
    const uploadDir = path.join(__dirname, "../../../../uploads/photos");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Clean up old photos before saving new one
    await cleanupOldPhotos(uploadDir);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const ext = path.extname(file.name) || ".jpg";
    const filename = `${timestamp}_${uuidv4()}${ext}`;
    const filepath = path.join(uploadDir, filename);

    try {
      await fs.promises.writeFile(filepath, buffer);
      logger.info(`Photo saved to ${filepath}`);
    } catch (error) {
      logger.error(error, "Failed to save photo:");
      return c.json({ error: "Failed to save photo" }, 500);
    }

    // Broadcast to Apps subscribed to PHOTO_TAKEN
    try {
      photoTakenService.broadcastPhotoTaken(userSession, Buffer.from(buffer), file.type);
    } catch (error) {
      logger.error(error, "Failed to broadcast photo:");
      // Continue processing even if broadcast fails
    }

    // Generate URL for response
    const baseUrl = process.env.CLOUD_PUBLIC_URL;
    const photoUrl = `${baseUrl}/uploads/${filename}`;

    // Return success response
    return c.json({
      success: true,
      photoUrl,
      requestId,
    });
  } catch (error) {
    logger.error(error, "Error handling photo upload:");
    return c.json({ error: "Failed to process photo upload" }, 500);
  }
}

/**
 * GET /api/photos/test
 * Test endpoint for photo routes.
 */
async function testEndpoint(c: AppContext) {
  return c.json({ message: "Photo routes are working" });
}

export default app;
