/**
 * @fileoverview Hono gallery API routes.
 * Handles uploads from glasses (ASG) and syncing to mobile.
 * All endpoints use clientAuth middleware.
 * Mounted at: /api/client/asg/gallery
 */

import { Hono } from "hono";
import { clientAuth } from "../../middleware/client.middleware";
import { logger as rootLogger } from "../../../../services/logging/pino-logger";
import * as GalleryService from "../../../../services/client/gallery/gallery.service";
import type { AppEnv, AppContext } from "../../../../types/hono";

const logger = rootLogger.child({ service: "gallery.api" });

const app = new Hono<AppEnv>();

// Allowed MIME types
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/heic", "image/heif"];
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/mov"];
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_VIDEO_SIZE = 2 * 1024 * 1024 * 1024; // 2GB

// ============================================================================
// ASG (Glasses) Endpoints
// ============================================================================

/**
 * POST /api/client/asg/gallery/upload
 * Direct image upload from glasses (multipart/form-data)
 */
app.post("/upload", clientAuth, uploadImage);

/**
 * POST /api/client/asg/gallery/video-upload-url
 * Get presigned URL for video upload
 */
app.post("/video-upload-url", clientAuth, createVideoUploadUrl);

/**
 * POST /api/client/asg/gallery/video-upload-complete
 * Confirm video upload finished
 */
app.post("/video-upload-complete", clientAuth, completeVideoUpload);

// ============================================================================
// Mobile Sync Endpoints
// ============================================================================

/**
 * GET /api/client/asg/gallery/pending
 * Get stats and list of pending items with download URLs
 */
app.get("/pending", clientAuth, getPending);

/**
 * POST /api/client/asg/gallery/mark-synced
 * Mark items as synced (triggers storage deletion)
 */
app.post("/mark-synced", clientAuth, markSynced);

/**
 * DELETE /api/client/asg/gallery/:id
 * Delete pending item without downloading
 */
app.delete("/:id", clientAuth, deleteItem);

// ============================================================================
// Handler Functions
// ============================================================================

async function uploadImage(c: AppContext) {
  const email = c.get("email")!;
  const reqLogger = c.get("logger") || logger;

  try {
    // Parse multipart form data
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    const filename = formData.get("filename") as string | null;
    const capturedAt = formData.get("capturedAt") as string | null;
    const deviceId = formData.get("deviceId") as string | null;
    const metadataStr = formData.get("metadata") as string | null;

    // Validate file exists
    if (!file) {
      return c.json(
        {
          success: false,
          error: "No file provided",
          timestamp: new Date(),
        },
        400,
      );
    }

    // Validate MIME type
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      return c.json(
        {
          success: false,
          error: "Unsupported media type",
          allowed: ALLOWED_IMAGE_TYPES,
          timestamp: new Date(),
        },
        415,
      );
    }

    // Validate size
    if (file.size > MAX_IMAGE_SIZE) {
      return c.json(
        {
          success: false,
          error: "File too large",
          maxSize: "20MB",
          timestamp: new Date(),
        },
        413,
      );
    }

    // Validate required fields
    if (!filename || !capturedAt) {
      return c.json(
        {
          success: false,
          error: "Missing required fields: filename, capturedAt",
          timestamp: new Date(),
        },
        400,
      );
    }

    // Parse metadata if provided
    let parsedMetadata;
    if (metadataStr) {
      try {
        parsedMetadata = JSON.parse(metadataStr);
      } catch {
        parsedMetadata = undefined;
      }
    }

    // Parse capturedAt timestamp
    // Glasses send it as milliseconds since epoch (string or number)
    let parsedCapturedAt: Date;
    try {
      // Try parsing as number (milliseconds since epoch)
      const timestamp = typeof capturedAt === "string" ? parseInt(capturedAt, 10) : capturedAt;
      if (isNaN(timestamp)) {
        // If not a number, try parsing as ISO date string
        parsedCapturedAt = new Date(capturedAt);
      } else {
        // Valid timestamp - create date from milliseconds
        parsedCapturedAt = new Date(timestamp);
      }

      // Validate the date is valid
      if (isNaN(parsedCapturedAt.getTime())) {
        reqLogger.warn({ capturedAt, timestamp }, "Invalid capturedAt timestamp, using current time as fallback");
        parsedCapturedAt = new Date();
      }
    } catch (error) {
      reqLogger.warn({ capturedAt, error }, "Error parsing capturedAt, using current time as fallback");
      parsedCapturedAt = new Date();
    }

    // Convert File to Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const item = await GalleryService.uploadImage({
      userId: email,
      file: buffer,
      filename,
      mimeType: file.type,
      capturedAt: parsedCapturedAt,
      deviceId: deviceId || undefined,
      metadata: parsedMetadata,
    });

    return c.json({
      success: true,
      data: {
        id: item._id.toString(),
        uploadedAt: item.uploadedAt,
      },
      timestamp: new Date(),
    });
  } catch (error) {
    reqLogger.error(error, "Failed to upload image");
    return c.json(
      {
        success: false,
        error: "Failed to upload image",
        timestamp: new Date(),
      },
      500,
    );
  }
}

async function createVideoUploadUrl(c: AppContext) {
  const email = c.get("email")!;
  const reqLogger = c.get("logger") || logger;

  try {
    const body = await c.req.json().catch(() => ({}));
    const { filename, mimeType, sizeBytes, capturedAt, deviceId, metadata } = body as {
      filename?: string;
      mimeType?: string;
      sizeBytes?: number;
      capturedAt?: string;
      deviceId?: string;
      metadata?: object;
    };

    // Validate required fields
    if (!filename || !mimeType || !sizeBytes || !capturedAt) {
      return c.json(
        {
          success: false,
          error: "Missing required fields: filename, mimeType, sizeBytes, capturedAt",
          timestamp: new Date(),
        },
        400,
      );
    }

    // Validate MIME type
    if (!ALLOWED_VIDEO_TYPES.includes(mimeType)) {
      return c.json(
        {
          success: false,
          error: "Unsupported media type",
          allowed: ALLOWED_VIDEO_TYPES,
          timestamp: new Date(),
        },
        415,
      );
    }

    // Validate size
    if (sizeBytes > MAX_VIDEO_SIZE) {
      return c.json(
        {
          success: false,
          error: "File too large",
          maxSize: "2GB",
          timestamp: new Date(),
        },
        413,
      );
    }

    const result = await GalleryService.createVideoUpload({
      userId: email,
      filename,
      mimeType,
      sizeBytes,
      capturedAt: new Date(capturedAt),
      deviceId,
      metadata: metadata as any,
    });

    return c.json({
      success: true,
      data: {
        id: result.id,
        uploadUrl: result.uploadUrl,
        expiresAt: result.expiresAt,
      },
      timestamp: new Date(),
    });
  } catch (error) {
    reqLogger.error(error, "Failed to create video upload URL");
    return c.json(
      {
        success: false,
        error: "Failed to create video upload URL",
        timestamp: new Date(),
      },
      500,
    );
  }
}

async function completeVideoUpload(c: AppContext) {
  const email = c.get("email")!;
  const reqLogger = c.get("logger") || logger;

  try {
    const body = await c.req.json().catch(() => ({}));
    const { id } = body as { id?: string };

    if (!id) {
      return c.json(
        {
          success: false,
          error: "Missing required field: id",
          timestamp: new Date(),
        },
        400,
      );
    }

    const item = await GalleryService.completeVideoUpload(email, id);

    return c.json({
      success: true,
      data: {
        id: item._id.toString(),
        status: item.status,
      },
      timestamp: new Date(),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    if (errorMessage.includes("not found")) {
      return c.json(
        {
          success: false,
          error: errorMessage,
          timestamp: new Date(),
        },
        404,
      );
    }

    reqLogger.error(error, "Failed to complete video upload");
    return c.json(
      {
        success: false,
        error: "Failed to complete video upload",
        timestamp: new Date(),
      },
      500,
    );
  }
}

async function getPending(c: AppContext) {
  const email = c.get("email")!;
  const reqLogger = c.get("logger") || logger;

  try {
    const limitParam = c.req.query("limit");
    const cursor = c.req.query("cursor");
    const type = c.req.query("type") as "image" | "video" | undefined;

    const limit = limitParam ? parseInt(limitParam, 10) : undefined;

    // Validate type if provided
    if (type && type !== "image" && type !== "video") {
      return c.json(
        {
          success: false,
          error: "Invalid type. Must be 'image' or 'video'",
          timestamp: new Date(),
        },
        400,
      );
    }

    const result = await GalleryService.getPending(email, { limit, cursor, type });

    return c.json({
      success: true,
      data: result,
      timestamp: new Date(),
    });
  } catch (error) {
    reqLogger.error(error, "Failed to get pending items");
    return c.json(
      {
        success: false,
        error: "Failed to get pending items",
        timestamp: new Date(),
      },
      500,
    );
  }
}

async function markSynced(c: AppContext) {
  const email = c.get("email")!;
  const reqLogger = c.get("logger") || logger;

  try {
    const body = await c.req.json().catch(() => ({}));
    const { ids } = body as { ids?: string[] };

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return c.json(
        {
          success: false,
          error: "Missing or invalid field: ids (must be non-empty array)",
          timestamp: new Date(),
        },
        400,
      );
    }

    if (ids.length > 100) {
      return c.json(
        {
          success: false,
          error: "Too many ids. Maximum 100 per request",
          timestamp: new Date(),
        },
        400,
      );
    }

    const result = await GalleryService.markSynced(email, ids);

    return c.json({
      success: true,
      data: result,
      timestamp: new Date(),
    });
  } catch (error) {
    reqLogger.error(error, "Failed to mark items as synced");
    return c.json(
      {
        success: false,
        error: "Failed to mark items as synced",
        timestamp: new Date(),
      },
      500,
    );
  }
}

async function deleteItem(c: AppContext) {
  const email = c.get("email")!;
  const reqLogger = c.get("logger") || logger;

  try {
    const id = c.req.param("id");

    if (!id) {
      return c.json(
        {
          success: false,
          error: "Missing item id",
          timestamp: new Date(),
        },
        400,
      );
    }

    await GalleryService.deleteItem(email, id);

    return c.json({
      success: true,
      message: "Item deleted",
      timestamp: new Date(),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    if (errorMessage.includes("not found")) {
      return c.json(
        {
          success: false,
          error: errorMessage,
          timestamp: new Date(),
        },
        404,
      );
    }

    reqLogger.error(error, "Failed to delete item");
    return c.json(
      {
        success: false,
        error: "Failed to delete item",
        timestamp: new Date(),
      },
      500,
    );
  }
}

export default app;
