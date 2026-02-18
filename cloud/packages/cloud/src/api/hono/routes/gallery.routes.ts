/**
 * @fileoverview Hono gallery routes.
 * Access and manage user photo galleries.
 * Mounted at: /api/gallery
 */

import { Hono } from "hono";
import jwt from "jsonwebtoken";
import path from "path";
import fs from "fs";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import { GalleryPhoto } from "../../../models/gallery-photo.model";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "gallery.routes" });

const app = new Hono<AppEnv>();

const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

// ============================================================================
// Routes
// ============================================================================

app.get("/", validateGlassesAuth, getGalleryPhotos);
app.delete("/:photoId", validateGlassesAuth, deletePhoto);

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
 * GET /api/gallery
 * Get all photos in the user's gallery.
 * Requires authentication.
 */
async function getGalleryPhotos(c: AppContext) {
  try {
    const decodedToken = (c as any).decodedToken;
    const userId = decodedToken?.email;

    logger.debug({ userId }, "Requesting gallery photos for user");

    if (!userId) {
      return c.json({ error: "User ID not found in token" }, 401);
    }

    // Get all photos for this user
    const photos = await GalleryPhoto.findByUserId(userId);

    return c.json({
      success: true,
      photos,
    });
  } catch (error) {
    logger.error(error, "Error fetching gallery photos:");
    return c.json({ error: "Failed to fetch gallery photos" }, 500);
  }
}

/**
 * DELETE /api/gallery/:photoId
 * Delete a photo from the user's gallery.
 * Requires authentication.
 */
async function deletePhoto(c: AppContext) {
  try {
    const decodedToken = (c as any).decodedToken;
    const userId = decodedToken?.userId || decodedToken?.email;
    const photoId = c.req.param("photoId");

    if (!userId) {
      return c.json({ error: "User ID not found in token" }, 401);
    }

    if (!photoId) {
      return c.json({ error: "Photo ID is required" }, 400);
    }

    // Get the photo to find its filename
    const photo = await GalleryPhoto.findById(photoId);

    if (!photo) {
      return c.json({ error: "Photo not found" }, 404);
    }

    // Check if this user owns the photo
    if (photo.userId !== userId) {
      return c.json({ error: "Not authorized to delete this photo" }, 403);
    }

    // Delete from database
    const deleted = await GalleryPhoto.findAndDeleteById(photoId, userId);

    if (!deleted) {
      return c.json({ error: "Failed to delete photo" }, 404);
    }

    // Try to delete the file (but don't fail if we can't)
    try {
      const filePath = path.join(__dirname, "../../../../uploads", photo.filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logger.info(`Deleted file ${filePath}`);
      }
    } catch (fileError) {
      // Just log this error but don't fail the request
      logger.warn({ fileError }, `Could not delete file for photo ${photoId}:`);
    }

    return c.json({
      success: true,
      message: "Photo deleted successfully",
    });
  } catch (error) {
    logger.error(error, "Error deleting gallery photo:");
    return c.json({ error: "Failed to delete photo" }, 500);
  }
}

export default app;
