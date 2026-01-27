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

/**
 * POST /api/client/asg/gallery/video-thumbnail
 * Upload thumbnail for a video (multipart/form-data)
 */
app.post("/video-thumbnail", clientAuth, handleUploadVideoThumbnail);

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

/**
 * GET /api/client/asg/gallery/status
 * Get current gallery sync status (upload progress, pending count)
 */
app.get("/status", clientAuth, getGalleryStatus);

/**
 * POST /api/client/asg/gallery/upload-started
 * Glasses notify that upload batch has started
 */
app.post("/upload-started", clientAuth, handleUploadStarted);

/**
 * POST /api/client/asg/gallery/upload-complete
 * Glasses notify that upload batch has completed
 */
app.post("/upload-complete", clientAuth, handleUploadComplete);

/**
 * POST /api/client/asg/gallery/upload-failed
 * Phone reports that glasses upload failed (BLE fallback)
 */
app.post("/upload-failed", clientAuth, handleUploadFailed);

/**
 * POST /api/client/asg/gallery/download-started
 * Phone notifies that download batch has started
 */
app.post("/download-started", clientAuth, handleDownloadStarted);

/**
 * POST /api/client/asg/gallery/download-complete
 * Phone notifies that download batch has completed
 */
app.post("/download-complete", clientAuth, handleDownloadComplete);

/**
 * POST /api/client/asg/gallery/cancel-upload
 * Cancel active upload session (can be called by phone or glasses)
 */
app.post("/cancel-upload", clientAuth, handleCancelUpload);

/**
 * POST /api/client/asg/gallery/cancel-download
 * Cancel active download session (called by phone)
 */
app.post("/cancel-download", clientAuth, handleCancelDownload);

// ============================================================================
// Handler Functions
// ============================================================================

async function uploadImage(c: AppContext) {
  const email = c.get("email")!;
  const reqLogger = c.get("logger") || logger;

  // 🔍 DEBUG: Log the upload userId
  reqLogger.info({ email }, "📸 uploadImage called - uploading for userId");

  try {
    // Parse multipart form data
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    const filename = formData.get("filename") as string | null;
    const capturedAt = formData.get("capturedAt") as string | null;
    const deviceId = formData.get("deviceId") as string | null;
    const metadataStr = formData.get("metadata") as string | null;

    // 🔍 DEBUG: Log the file info
    reqLogger.info({ email, filename, fileSize: file?.size, deviceId }, "📸 Upload file details");

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

    // 🔍 DEBUG: Log successful upload with status
    reqLogger.info(
      {
        email,
        itemId: item._id.toString(),
        filename,
        status: item.status,
        sizeBytes: item.sizeBytes,
      },
      "✅ uploadImage SUCCESS - item created with status",
    );

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

async function handleUploadVideoThumbnail(c: AppContext) {
  const email = c.get("email")!;
  const reqLogger = c.get("logger") || logger;

  try {
    // Parse multipart form data
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    const videoId = formData.get("videoId") as string | null;

    // Validate required fields
    if (!file) {
      return c.json(
        {
          success: false,
          error: "No thumbnail file provided",
          timestamp: new Date(),
        },
        400,
      );
    }

    if (!videoId) {
      return c.json(
        {
          success: false,
          error: "Missing required field: videoId",
          timestamp: new Date(),
        },
        400,
      );
    }

    // Validate MIME type (should be JPEG)
    if (!file.type.startsWith("image/")) {
      return c.json(
        {
          success: false,
          error: "Thumbnail must be an image",
          timestamp: new Date(),
        },
        415,
      );
    }

    // Validate size (thumbnails should be small, max 1MB)
    const MAX_THUMBNAIL_SIZE = 1 * 1024 * 1024;
    if (file.size > MAX_THUMBNAIL_SIZE) {
      return c.json(
        {
          success: false,
          error: "Thumbnail too large (max 1MB)",
          timestamp: new Date(),
        },
        413,
      );
    }

    // Convert File to Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const item = await GalleryService.uploadVideoThumbnail(email, videoId, buffer);

    reqLogger.info({ email, videoId, thumbnailSize: file.size }, "Video thumbnail uploaded successfully");

    return c.json({
      success: true,
      data: {
        id: item._id.toString(),
        hasThumbnail: !!item.thumbnailKey,
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

    reqLogger.error(error, "Failed to upload video thumbnail");
    return c.json(
      {
        success: false,
        error: "Failed to upload video thumbnail",
        timestamp: new Date(),
      },
      500,
    );
  }
}

async function getPending(c: AppContext) {
  const email = c.get("email")!;
  const reqLogger = c.get("logger") || logger;

  // 🔍 DEBUG: Log the query parameters
  reqLogger.info({ email, queryParams: c.req.query() }, "📥 getPending called - querying for userId");

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

    // 🔍 DEBUG: Log the results
    reqLogger.info(
      {
        email,
        pendingCount: result.pendingCount,
        pendingTotalBytes: result.pendingTotalBytes,
        itemsReturned: result.items.length,
        itemFilenames: result.items.map((i) => i.filename),
      },
      "📤 getPending result - found items for userId",
    );

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

async function getGalleryStatus(c: AppContext) {
  const email = c.get("email")!;
  const reqLogger = c.get("logger") || logger;

  try {
    const status = await GalleryService.getGalleryStatus(email);

    reqLogger.debug({ email, status }, "Gallery status requested");

    return c.json({
      success: true,
      data: status,
      timestamp: new Date(),
    });
  } catch (error) {
    reqLogger.error(error, "Failed to get gallery status");
    return c.json(
      {
        success: false,
        error: "Failed to get gallery status",
        timestamp: new Date(),
      },
      500,
    );
  }
}

async function handleUploadStarted(c: AppContext) {
  const email = c.get("email")!;
  const reqLogger = c.get("logger") || logger;

  try {
    const body = await c.req.json().catch(() => ({}));
    const { totalFiles } = body as { totalFiles?: number };

    if (!totalFiles || totalFiles <= 0) {
      return c.json(
        {
          success: false,
          error: "Missing or invalid field: totalFiles (must be > 0)",
          timestamp: new Date(),
        },
        400,
      );
    }

    const sessionId = GalleryService.startUploadSession(email, totalFiles);

    // Send WebSocket event to phone
    await sendGalleryEventToPhone(email, {
      type: "gallery_upload_started",
      totalFiles,
      timestamp: new Date(),
    });

    reqLogger.info({ email, sessionId, totalFiles }, "Upload session started");

    return c.json({
      success: true,
      data: { sessionId },
      timestamp: new Date(),
    });
  } catch (error) {
    reqLogger.error(error, "Failed to handle upload started");
    return c.json(
      {
        success: false,
        error: "Failed to handle upload started",
        timestamp: new Date(),
      },
      500,
    );
  }
}

async function handleUploadComplete(c: AppContext) {
  const email = c.get("email")!;
  const reqLogger = c.get("logger") || logger;

  try {
    GalleryService.endUploadSession(email);

    // Send WebSocket event to phone
    await sendGalleryEventToPhone(email, {
      type: "gallery_upload_complete",
      timestamp: new Date(),
    });

    reqLogger.info({ email }, "Upload session completed");

    return c.json({
      success: true,
      message: "Upload session completed",
      timestamp: new Date(),
    });
  } catch (error) {
    reqLogger.error(error, "Failed to handle upload complete");
    return c.json(
      {
        success: false,
        error: "Failed to handle upload complete",
        timestamp: new Date(),
      },
      500,
    );
  }
}

async function handleUploadFailed(c: AppContext) {
  const email = c.get("email")!;
  const reqLogger = c.get("logger") || logger;

  try {
    const body = await c.req.json().catch(() => ({}));
    const { reason } = body as { reason?: string };

    GalleryService.markUploadSessionFailed(email);

    reqLogger.warn({ email, reason }, "Upload session marked as failed (reported by phone)");

    return c.json({
      success: true,
      message: "Upload failure recorded",
      timestamp: new Date(),
    });
  } catch (error) {
    reqLogger.error(error, "Failed to handle upload failed");
    return c.json(
      {
        success: false,
        error: "Failed to handle upload failed",
        timestamp: new Date(),
      },
      500,
    );
  }
}

async function handleDownloadStarted(c: AppContext) {
  const email = c.get("email")!;
  const reqLogger = c.get("logger") || logger;

  try {
    const sessionId = GalleryService.startDownloadSession(email);

    reqLogger.info({ email, sessionId }, "Download session started");

    return c.json({
      success: true,
      data: { sessionId },
      timestamp: new Date(),
    });
  } catch (error) {
    reqLogger.error(error, "Failed to handle download started");
    return c.json(
      {
        success: false,
        error: "Failed to handle download started",
        timestamp: new Date(),
      },
      500,
    );
  }
}

async function handleDownloadComplete(c: AppContext) {
  const email = c.get("email")!;
  const reqLogger = c.get("logger") || logger;

  try {
    GalleryService.endDownloadSession(email);

    reqLogger.info({ email }, "Download session completed");

    return c.json({
      success: true,
      message: "Download session completed",
      timestamp: new Date(),
    });
  } catch (error) {
    reqLogger.error(error, "Failed to handle download complete");
    return c.json(
      {
        success: false,
        error: "Failed to handle download complete",
        timestamp: new Date(),
      },
      500,
    );
  }
}

async function handleCancelUpload(c: AppContext) {
  const email = c.get("email")!;
  const reqLogger = c.get("logger") || logger;

  try {
    const userId = email;
    const cancelled = GalleryService.cancelUploadSession(userId);

    if (cancelled) {
      reqLogger.info({ userId }, "Upload session cancelled");
      return c.json({
        success: true,
        message: "Upload session cancelled",
        timestamp: new Date(),
      });
    } else {
      reqLogger.warn({ userId }, "No active upload session to cancel");
      return c.json(
        {
          success: false,
          error: "No active upload session",
          timestamp: new Date(),
        },
        404,
      );
    }
  } catch (error) {
    reqLogger.error(error, "Failed to cancel upload");
    return c.json(
      {
        success: false,
        error: "Failed to cancel upload",
        timestamp: new Date(),
      },
      500,
    );
  }
}

async function handleCancelDownload(c: AppContext) {
  const email = c.get("email")!;
  const reqLogger = c.get("logger") || logger;

  try {
    const userId = email;
    const cancelled = GalleryService.cancelDownloadSession(userId);

    if (cancelled) {
      reqLogger.info({ userId }, "Download session cancelled");
      return c.json({
        success: true,
        message: "Download session cancelled",
        timestamp: new Date(),
      });
    } else {
      reqLogger.warn({ userId }, "No active download session to cancel");
      return c.json(
        {
          success: false,
          error: "No active download session",
          timestamp: new Date(),
        },
        404,
      );
    }
  } catch (error) {
    reqLogger.error(error, "Failed to cancel download");
    return c.json(
      {
        success: false,
        error: "Failed to cancel download",
        timestamp: new Date(),
      },
      500,
    );
  }
}

/**
 * Send gallery event to phone via WebSocket
 */
async function sendGalleryEventToPhone(userId: string, event: any): Promise<void> {
  try {
    // Import UserSession dynamically to avoid circular dependencies
    const { UserSession } = await import("../../../../services/session/UserSession");
    const userSession = UserSession.getById(userId);

    if (!userSession) {
      logger.debug({ userId }, "No user session found - cannot send gallery event to phone");
      return;
    }

    if (userSession.websocket.readyState !== 1) {
      logger.debug({ userId }, "Phone WebSocket not open - cannot send gallery event");
      return;
    }

    const message = JSON.stringify({
      type: "gallery_event",
      data: event,
      timestamp: new Date(),
    });

    userSession.websocket.send(message);
    logger.debug({ userId, eventType: event.type }, "Sent gallery event to phone");
  } catch (error) {
    logger.error({ error, userId, event }, "Failed to send gallery event to phone");
  }
}

export default app;
