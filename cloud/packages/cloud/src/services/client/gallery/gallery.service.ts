// services/client/gallery/gallery.service.ts
// Gallery sync service - handles uploads from glasses and syncing to mobile

import sharp from "sharp";
import { GalleryProvider } from "./gallery.provider";
import { CloudflareGalleryProvider } from "./cloudflare.gallery.provider";
import { AlibabaGalleryProvider } from "./alibaba.gallery.provider";
import { GalleryItem, GalleryItemI } from "../../../models/gallery-item.model";
import { logger as rootLogger } from "../../logging";
import { UserSession } from "../../session/UserSession";

// Thumbnail settings
const THUMBNAIL_WIDTH = 400;
const THUMBNAIL_QUALITY = 70;

const logger = rootLogger.child({ service: "gallery" });

// ============================================================================
// Upload Session Tracking
// ============================================================================

interface UploadSession {
  userId: string;
  sessionId: string;
  totalFiles: number;
  startedAt: Date;
  lastProgressAt: Date;
  currentFile?: string;
}

// In-memory storage for upload sessions (per user)
// In production, consider using Redis for multi-instance deployments
const uploadSessions = new Map<string, UploadSession>();

/**
 * Start a new upload session
 */
export function startUploadSession(userId: string, totalFiles: number): string {
  const sessionId = `${userId}-${Date.now()}`;
  const session: UploadSession = {
    userId,
    sessionId,
    totalFiles,
    startedAt: new Date(),
    lastProgressAt: new Date(),
  };
  uploadSessions.set(userId, session);
  logger.info({ userId, sessionId, totalFiles }, "Upload session started");
  return sessionId;
}

/**
 * Update upload progress
 */
export function updateUploadProgress(userId: string, currentFile?: string): void {
  const session = uploadSessions.get(userId);
  if (!session) {
    logger.warn({ userId }, "Attempted to update progress for non-existent session");
    return;
  }
  session.lastProgressAt = new Date();
  if (currentFile) {
    session.currentFile = currentFile;
  }
}

/**
 * End an upload session
 */
export function endUploadSession(userId: string): void {
  const session = uploadSessions.get(userId);
  if (session) {
    logger.info({ userId, sessionId: session.sessionId }, "Upload session ended");
    uploadSessions.delete(userId);
  }
}

/**
 * Mark upload session as failed
 */
export function markUploadSessionFailed(userId: string): void {
  const session = uploadSessions.get(userId);
  if (session) {
    logger.warn({ userId, sessionId: session.sessionId }, "Upload session marked as failed");
    uploadSessions.delete(userId);
  }
}

/**
 * Cancel an active upload session
 */
export function cancelUploadSession(userId: string): boolean {
  const session = uploadSessions.get(userId);
  if (session) {
    logger.info({ userId, sessionId: session.sessionId }, "Upload session cancelled");
    uploadSessions.delete(userId);

    // Send cancellation event to phone
    sendGalleryEventToPhone(userId, {
      type: "gallery_upload_cancelled",
      timestamp: Date.now(),
    }).catch((err) => {
      logger.error({ error: err }, "Failed to send upload cancellation event to phone");
    });

    return true;
  }
  return false;
}

/**
 * Get current upload session for a user
 */
export function getUploadSession(userId: string): UploadSession | undefined {
  return uploadSessions.get(userId);
}

/**
 * Send gallery event to phone via WebSocket
 */
async function sendGalleryEventToPhone(userId: string, event: any): Promise<void> {
  try {
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

/**
 * Cleanup stale upload sessions (no progress for 60s)
 */
export function cleanupStaleSessions(): number {
  const now = new Date();
  const staleThreshold = 60 * 1000; // 60 seconds
  let cleaned = 0;

  for (const [userId, session] of uploadSessions.entries()) {
    const timeSinceProgress = now.getTime() - session.lastProgressAt.getTime();
    if (timeSinceProgress > staleThreshold) {
      logger.warn({ userId, sessionId: session.sessionId, timeSinceProgress }, "Cleaning up stale upload session");
      uploadSessions.delete(userId);
      cleaned++;
    }
  }

  return cleaned;
}

// ============================================================================
// Download Session Tracking
// ============================================================================

interface DownloadSession {
  userId: string;
  sessionId: string;
  startedAt: Date;
}

// In-memory storage for download sessions (per user)
// In production, consider using Redis for multi-instance deployments
const downloadSessions = new Map<string, DownloadSession>();

/**
 * Start a new download session
 */
export function startDownloadSession(userId: string): string {
  const sessionId = `${userId}-${Date.now()}`;
  const session: DownloadSession = {
    userId,
    sessionId,
    startedAt: new Date(),
  };
  downloadSessions.set(userId, session);
  logger.info({ userId, sessionId }, "Download session started");
  return sessionId;
}

/**
 * End a download session
 */
export function endDownloadSession(userId: string): void {
  const session = downloadSessions.get(userId);
  if (session) {
    logger.info({ userId, sessionId: session.sessionId }, "Download session ended");
    downloadSessions.delete(userId);
  }
}

/**
 * Get current download session for a user
 */
export function getDownloadSession(userId: string): DownloadSession | undefined {
  return downloadSessions.get(userId);
}

/**
 * Cancel an active download session
 */
export function cancelDownloadSession(userId: string): boolean {
  const session = downloadSessions.get(userId);
  if (session) {
    logger.info({ userId, sessionId: session.sessionId }, "Download session cancelled");
    downloadSessions.delete(userId);
    return true;
  }
  return false;
}

// ============================================================================
// Provider Factory
// ============================================================================

let providerInstance: GalleryProvider | null = null;

/**
 * Get the gallery storage provider based on available env vars.
 * Initializes on first call and returns cached instance thereafter.
 */
export function getProvider(): GalleryProvider {
  if (providerInstance) {
    return providerInstance;
  }

  // Check which provider's env vars are available
  const hasCloudflare = !!(
    process.env.CLOUDFLARE_ACCOUNT_ID &&
    process.env.CLOUDFLARE_R2_ACCESS_KEY_ID &&
    process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY
  );

  const hasAlibaba = !!(
    process.env.ALIBABA_OSS_ENDPOINT &&
    process.env.ALIBABA_ACCESS_KEY_ID &&
    process.env.ALIBABA_SECRET_ACCESS_KEY
  );

  if (hasCloudflare) {
    logger.info("Initializing Cloudflare R2 gallery provider");
    providerInstance = new CloudflareGalleryProvider();
  } else if (hasAlibaba) {
    logger.info("Initializing Alibaba OSS gallery provider");
    providerInstance = new AlibabaGalleryProvider();
  } else {
    throw new Error("No gallery storage provider configured. Set R2_* or ALIBABA_* env vars.");
  }

  return providerInstance;
}

/**
 * Check if gallery storage is configured (without throwing)
 */
export function isGalleryConfigured(): boolean {
  const hasCloudflare = !!(
    process.env.CLOUDFLARE_ACCOUNT_ID &&
    process.env.CLOUDFLARE_R2_ACCESS_KEY_ID &&
    process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY
  );

  const hasAlibaba = !!(
    process.env.ALIBABA_OSS_ENDPOINT &&
    process.env.ALIBABA_ACCESS_KEY_ID &&
    process.env.ALIBABA_SECRET_ACCESS_KEY
  );

  return hasCloudflare || hasAlibaba;
}

// ============================================================================
// Thumbnail Generation
// ============================================================================

/**
 * Generate a thumbnail from an image buffer.
 * Returns null if thumbnail generation fails (non-fatal).
 */
async function generateThumbnail(imageBuffer: Buffer): Promise<Buffer | null> {
  try {
    const thumbnail = await sharp(imageBuffer)
      .resize(THUMBNAIL_WIDTH, null, {
        withoutEnlargement: true,
        fit: "inside",
      })
      .jpeg({ quality: THUMBNAIL_QUALITY })
      .toBuffer();

    logger.debug({ originalSize: imageBuffer.length, thumbnailSize: thumbnail.length }, "Thumbnail generated");
    return thumbnail;
  } catch (error) {
    logger.warn({ error }, "Failed to generate thumbnail - continuing without");
    return null;
  }
}

/**
 * Generate thumbnail storage key from original key.
 */
function getThumbnailKey(storageKey: string): string {
  // Insert "thumbs/" prefix after user ID
  // e.g., "gallery/user@email.com/IMG_123.jpg" -> "gallery/user@email.com/thumbs/IMG_123.jpg"
  const parts = storageKey.split("/");
  if (parts.length >= 3) {
    parts.splice(2, 0, "thumbs");
    return parts.join("/");
  }
  // Fallback: just add "_thumb" suffix
  return storageKey.replace(/(\.[^.]+)$/, "_thumb$1");
}

// ============================================================================
// Image Upload (Direct)
// ============================================================================

export interface UploadImageParams {
  userId: string;
  file: Buffer;
  filename: string;
  mimeType: string;
  capturedAt: Date;
  deviceId?: string;
  metadata?: {
    width?: number;
    height?: number;
    gps?: { lat: number; lng: number };
  };
}

export async function uploadImage(params: UploadImageParams): Promise<GalleryItemI> {
  const provider = getProvider();
  const storageKey = provider.generateKey(params.userId, params.filename);
  const thumbnailKey = getThumbnailKey(storageKey);

  // Create DB record first (status: uploading)
  const item = new GalleryItem({
    userId: params.userId,
    type: "image",
    filename: params.filename,
    mimeType: params.mimeType,
    sizeBytes: params.file.length,
    storageProvider: provider.providerType,
    storageKey,
    thumbnailKey, // Will be set even if thumbnail upload fails
    status: "uploading",
    capturedAt: params.capturedAt,
    deviceId: params.deviceId,
    metadata: params.metadata,
  });
  await item.save();

  try {
    // Upload original to storage
    await provider.uploadObject(storageKey, params.file, params.mimeType);

    // Generate and upload thumbnail (non-blocking, non-fatal)
    const thumbnail = await generateThumbnail(params.file);
    if (thumbnail) {
      try {
        await provider.uploadObject(thumbnailKey, thumbnail, "image/jpeg");
        logger.debug({ thumbnailKey }, "Thumbnail uploaded");
      } catch (thumbError) {
        // Thumbnail upload failed - clear the key but continue
        logger.warn({ error: thumbError }, "Failed to upload thumbnail - continuing without");
        item.thumbnailKey = undefined;
      }
    } else {
      // No thumbnail generated - clear the key
      item.thumbnailKey = undefined;
    }

    // Update status to pending
    item.status = "pending";
    item.uploadedAt = new Date();
    await item.save();

    // Update upload progress and send WebSocket event
    updateUploadProgress(params.userId, params.filename);
    const session = getUploadSession(params.userId);
    if (session) {
      // Calculate current progress by counting pending items in this session
      const pendingItemsInSession = await GalleryItem.countDocuments({
        userId: params.userId,
        status: "pending",
        uploadedAt: { $gte: session.startedAt },
      });

      // Send WebSocket event to phone
      await sendGalleryEventToPhone(params.userId, {
        type: "gallery_upload_progress",
        current: pendingItemsInSession,
        total: session.totalFiles,
        currentFile: params.filename,
      });
    }

    logger.info(
      { itemId: item._id, userId: params.userId, hasThumbnail: !!item.thumbnailKey },
      "Image uploaded successfully",
    );
    return item;
  } catch (error) {
    // Rollback DB record on failure
    await item.deleteOne();
    logger.error({ error, userId: params.userId }, "Image upload failed");
    throw error;
  }
}

// ============================================================================
// Video Upload (Presigned URL)
// ============================================================================

export interface CreateVideoUploadParams {
  userId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  capturedAt: Date;
  deviceId?: string;
  metadata?: {
    width?: number;
    height?: number;
    duration?: number;
    gps?: { lat: number; lng: number };
  };
}

export interface VideoUploadResult {
  id: string;
  uploadUrl: string;
  expiresAt: Date;
}

export async function createVideoUpload(params: CreateVideoUploadParams): Promise<VideoUploadResult> {
  const provider = getProvider();
  const storageKey = provider.generateKey(params.userId, params.filename);

  // Create DB record (status: uploading)
  const item = new GalleryItem({
    userId: params.userId,
    type: "video",
    filename: params.filename,
    mimeType: params.mimeType,
    sizeBytes: params.sizeBytes,
    storageProvider: provider.providerType,
    storageKey,
    status: "uploading",
    capturedAt: params.capturedAt,
    deviceId: params.deviceId,
    metadata: params.metadata,
  });
  await item.save();

  // Generate presigned upload URL (1 hour expiry)
  const expiresIn = 3600;
  const uploadUrl = await provider.getPresignedUploadUrl(storageKey, params.mimeType, expiresIn);
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  logger.info({ itemId: item._id, userId: params.userId }, "Video upload URL created");

  return {
    id: item._id.toString(),
    uploadUrl,
    expiresAt,
  };
}

export async function completeVideoUpload(userId: string, itemId: string): Promise<GalleryItemI> {
  const provider = getProvider();

  const item = await GalleryItem.findOne({
    _id: itemId,
    userId,
    status: "uploading",
    type: "video",
  });

  if (!item) {
    throw new Error("Upload not found or already completed");
  }

  // Verify the object exists in storage
  const exists = await provider.objectExists(item.storageKey);
  if (!exists) {
    throw new Error("Video not found in storage. Upload may have failed.");
  }

  // Update status to pending
  item.status = "pending";
  item.uploadedAt = new Date();
  await item.save();

  // Update upload progress and send WebSocket event
  updateUploadProgress(userId, item.filename);
  const session = getUploadSession(userId);
  if (session) {
    // Calculate current progress by counting pending items in this session
    const pendingItemsInSession = await GalleryItem.countDocuments({
      userId,
      status: "pending",
      uploadedAt: { $gte: session.startedAt },
    });

    // Send WebSocket event to phone
    await sendGalleryEventToPhone(userId, {
      type: "gallery_upload_progress",
      current: pendingItemsInSession,
      total: session.totalFiles,
      currentFile: item.filename,
    });
  }

  logger.info({ itemId: item._id, userId }, "Video upload completed");
  return item;
}

/**
 * Upload a thumbnail for a video that was already uploaded.
 * Called by glasses after video upload is confirmed.
 */
export async function uploadVideoThumbnail(
  userId: string,
  itemId: string,
  thumbnailBuffer: Buffer,
): Promise<GalleryItemI> {
  const provider = getProvider();

  // Find the video item
  const item = await GalleryItem.findOne({
    _id: itemId,
    userId,
    type: "video",
  });

  if (!item) {
    throw new Error("Video not found");
  }

  // Generate thumbnail key based on video storage key
  const thumbnailKey = getThumbnailKey(item.storageKey);

  try {
    // Upload thumbnail to storage
    await provider.uploadObject(thumbnailKey, thumbnailBuffer, "image/jpeg");

    // Update item with thumbnail key
    item.thumbnailKey = thumbnailKey;
    await item.save();

    logger.info({ itemId: item._id, userId, thumbnailKey }, "Video thumbnail uploaded");
    return item;
  } catch (error) {
    logger.error({ error, itemId, userId }, "Failed to upload video thumbnail");
    throw error;
  }
}

// ============================================================================
// Pending Items (for Mobile)
// ============================================================================

export interface PendingItem {
  id: string;
  type: "image" | "video";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  capturedAt: Date;
  uploadedAt: Date;
  downloadUrl: string;
  thumbnailUrl?: string; // Presigned URL for thumbnail (images auto-generated, videos uploaded from glasses)
  metadata?: {
    width?: number;
    height?: number;
    duration?: number;
  };
}

export interface GetPendingResult {
  pendingCount: number;
  pendingTotalBytes: number;
  items: PendingItem[];
  cursor?: string;
}

export async function getPending(
  userId: string,
  options: { limit?: number; cursor?: string; type?: "image" | "video" } = {},
): Promise<GetPendingResult> {
  const provider = getProvider();
  const limit = Math.min(options.limit || 50, 100);

  // Build query
  const query: any = { userId, status: "pending" };
  if (options.type) {
    query.type = options.type;
  }
  if (options.cursor) {
    query._id = { $lt: options.cursor };
  }

  // Get total stats
  const [totalStats] = await GalleryItem.aggregate([
    { $match: { userId, status: "pending" } },
    { $group: { _id: null, count: { $sum: 1 }, totalBytes: { $sum: "$sizeBytes" } } },
  ]);

  const pendingCount = totalStats?.count || 0;
  const pendingTotalBytes = totalStats?.totalBytes || 0;

  // Get items
  const items = await GalleryItem.find(query)
    .sort({ _id: -1 })
    .limit(limit + 1); // +1 to check if there's more

  const hasMore = items.length > limit;
  if (hasMore) {
    items.pop();
  }

  // Generate download URLs for each item (including thumbnails if available)
  const pendingItems: PendingItem[] = await Promise.all(
    items.map(async (item) => {
      const downloadUrl = await provider.getPresignedDownloadUrl(item.storageKey);

      // Get thumbnail URL if available (images & videos with thumbnails)
      let thumbnailUrl: string | undefined;
      if (item.thumbnailKey) {
        try {
          thumbnailUrl = await provider.getPresignedDownloadUrl(item.thumbnailKey);
        } catch (error) {
          logger.warn({ error, itemId: item._id }, "Failed to get thumbnail URL");
        }
      }

      return {
        id: item._id.toString(),
        type: item.type,
        filename: item.filename,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        capturedAt: item.capturedAt,
        uploadedAt: item.uploadedAt!,
        downloadUrl,
        thumbnailUrl,
        metadata: item.metadata
          ? {
              width: item.metadata.width,
              height: item.metadata.height,
              duration: item.metadata.duration,
            }
          : undefined,
      };
    }),
  );

  return {
    pendingCount,
    pendingTotalBytes,
    items: pendingItems,
    cursor: hasMore ? items[items.length - 1]._id.toString() : undefined,
  };
}

// ============================================================================
// Mark Synced (Delete from Storage)
// ============================================================================

export interface MarkSyncedResult {
  synced: number;
  deleted: number;
}

export async function markSynced(userId: string, itemIds: string[]): Promise<MarkSyncedResult> {
  const provider = getProvider();

  // Find items belonging to this user that are pending
  const items = await GalleryItem.find({
    _id: { $in: itemIds },
    userId,
    status: "pending",
  });

  if (items.length === 0) {
    return { synced: 0, deleted: 0 };
  }

  // Delete from storage
  const keys = items.map((item) => item.storageKey);
  await provider.deleteObjects(keys);

  // Update status to synced
  const now = new Date();
  await GalleryItem.updateMany(
    { _id: { $in: items.map((i) => i._id) } },
    { $set: { status: "synced", syncedAt: now } },
  );

  logger.info({ userId, count: items.length }, "Items marked as synced");

  return {
    synced: items.length,
    deleted: keys.length,
  };
}

// ============================================================================
// Delete Item (Without Downloading)
// ============================================================================

export async function deleteItem(userId: string, itemId: string): Promise<void> {
  const provider = getProvider();

  const item = await GalleryItem.findOne({
    _id: itemId,
    userId,
    status: { $in: ["uploading", "pending"] },
  });

  if (!item) {
    throw new Error("Item not found");
  }

  // Delete from storage (ignore errors - might not exist yet)
  try {
    await provider.deleteObject(item.storageKey);
  } catch {
    // Ignore
  }

  // Update status to deleted
  item.status = "deleted";
  item.deletedAt = new Date();
  await item.save();

  logger.info({ itemId, userId }, "Item deleted");
}

// ============================================================================
// Gallery Status
// ============================================================================

export interface GalleryStatus {
  isUploading: boolean;
  isDownloading: boolean;
  uploadProgress?: {
    current: number;
    total: number;
    currentFile?: string;
  };
  pendingCount: number;
}

/**
 * Get current gallery status for a user
 */
export async function getGalleryStatus(userId: string): Promise<GalleryStatus> {
  // Get upload session
  const uploadSession = getUploadSession(userId);

  // Get download session
  const downloadSession = getDownloadSession(userId);

  // Count pending items
  const pendingCount = await GalleryItem.countDocuments({
    userId,
    status: "pending",
  });

  // Calculate upload progress if session exists
  let uploadProgress: { current: number; total: number; currentFile?: string } | undefined;
  if (uploadSession) {
    // Count items with status "pending" that were created during this upload session
    // Items transition from "uploading" -> "pending" when upload completes
    const sessionStartTime = uploadSession.startedAt;
    const pendingItemsInSession = await GalleryItem.countDocuments({
      userId,
      status: "pending",
      uploadedAt: { $gte: sessionStartTime },
    });

    uploadProgress = {
      current: pendingItemsInSession,
      total: uploadSession.totalFiles,
      currentFile: uploadSession.currentFile,
    };
  }

  return {
    isUploading: !!uploadSession,
    isDownloading: !!downloadSession,
    uploadProgress,
    pendingCount,
  };
}

// ============================================================================
// Cleanup Job
// ============================================================================

export async function cleanupStaleUploads(): Promise<number> {
  if (!isGalleryConfigured()) {
    return 0;
  }

  const provider = getProvider();
  const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours

  const staleItems = await GalleryItem.find({
    status: "uploading",
    createdAt: { $lt: staleThreshold },
  });

  for (const item of staleItems) {
    try {
      await provider.deleteObject(item.storageKey);
    } catch {
      // Ignore - object might not exist
    }
    await item.deleteOne();
  }

  if (staleItems.length > 0) {
    logger.info({ count: staleItems.length }, "Cleaned up stale uploads");
  }

  return staleItems.length;
}
