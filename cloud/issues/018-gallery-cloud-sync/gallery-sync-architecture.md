# Gallery Cloud Sync Architecture

## System Overview

```
┌─────────────┐     auth token       ┌─────────────┐
│   Mobile    │◄────────────────────►│   Glasses   │
│    App      │    (BLE/local)       │    (ASG)    │
└──────┬──────┘                      └──────┬──────┘
       │                                    │
       │ JWT auth                           │ Same JWT auth
       │                                    │
       ▼                                    ▼
┌───────────────────────────────────────────────────┐
│                    Cloud API                       │
│           /api/client/asg/gallery/*                │
│     (unified endpoints for glasses + mobile)       │
└───────────────────────────────────────────────────┘
       │                                    │
       ▼                                    ▼
┌─────────────┐                    ┌─────────────────┐
│   MongoDB   │                    │ Storage Provider │
│  (metadata) │                    │ (R2 or Alibaba) │
└─────────────┘                    └─────────────────┘
```

## Authentication

Both glasses and mobile use the same JWT auth. Mobile passes its auth token to glasses during pairing. From cloud's perspective, all requests look the same.

```
Mobile                    Cloud                     Glasses
   │                        │                          │
   │        ─────── BLE/local ───────                  │
   │        send auth token to glasses                 │
   ├──────────────────────────────────────────────────►│
   │                        │                          │
   │                        │  POST /api/client/asg/gallery/upload
   │                        │  Authorization: Bearer <jwt>
   │                        │◄─────────────────────────┤
   │                        │                          │
   │                        │  (same auth middleware)  │
   │                        │                          │
```

Uses existing `clientAuthWithEmail` middleware - no changes needed.

## File Structure

```
packages/cloud/src/
├── api/hono/client/asg/
│   └── gallery.api.ts               # All endpoints (glasses + mobile)
├── services/client/gallery/
│   ├── gallery.provider.ts              # GalleryProvider interface
│   ├── cloudflare.gallery.provider.ts   # Cloudflare R2 implementation
│   ├── alibaba.gallery.provider.ts      # Alibaba OSS implementation
│   └── gallery.service.ts               # Business logic + provider factory
├── models/
│   └── gallery-item.model.ts        # MongoDB schema
└── jobs/
    └── gallery-cleanup.job.ts       # Stale upload cleanup (TODO)
```

## Storage Layer

### Provider Interface

File: `packages/cloud/src/services/client/gallery/gallery.provider.ts`

```typescript
export type StorageProviderType = 'cloudflare-r2' | 'alibaba-oss';

export interface GalleryProvider {
  readonly providerType: StorageProviderType;
  
  /**
   * Generate a unique storage key for a file
   * Format: {userId}/{year}/{month}/{uuid}.{ext}
   */
  generateKey(userId: string, filename: string): string;
  
  /**
   * Upload an object directly (for images)
   */
  uploadObject(key: string, data: Buffer, contentType: string): Promise<void>;
  
  /**
   * Get a presigned URL for uploading (for videos)
   */
  getPresignedUploadUrl(key: string, contentType: string, expiresIn?: number): Promise<string>;
  
  /**
   * Get a presigned URL for downloading
   */
  getPresignedDownloadUrl(key: string, expiresIn?: number): Promise<string>;
  
  /**
   * Delete a single object
   */
  deleteObject(key: string): Promise<void>;
  
  /**
   * Delete multiple objects
   */
  deleteObjects(keys: string[]): Promise<void>;
  
  /**
   * Check if an object exists (for video upload confirmation)
   */
  objectExists(key: string): Promise<boolean>;
}
```

### Cloudflare R2 Provider

File: `packages/cloud/src/services/client/gallery/cloudflare.gallery.provider.ts`

```typescript
import { 
  S3Client, 
  PutObjectCommand, 
  GetObjectCommand, 
  DeleteObjectCommand, 
  HeadObjectCommand 
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GalleryProvider, StorageProviderType } from "./gallery.provider";

export class CloudflareGalleryProvider implements GalleryProvider {
  readonly providerType: StorageProviderType = 'cloudflare-r2';
  private client: S3Client;
  private bucket: string;
  
  constructor() {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    
    if (!accountId || !accessKeyId || !secretAccessKey) {
      throw new Error("Missing Cloudflare R2 credentials");
    }
    
    this.bucket = process.env.R2_GALLERY_BUCKET || "mentra-gallery";
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  
  generateKey(userId: string, filename: string): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const uuid = crypto.randomUUID();
    const ext = filename.split('.').pop() || 'bin';
    return `${userId}/${year}/${month}/${uuid}.${ext}`;
  }
  
  async uploadObject(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: data,
      ContentType: contentType,
    }));
  }
  
  async getPresignedUploadUrl(key: string, contentType: string, expiresIn = 3600): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(this.client, command, { expiresIn });
  }
  
  async getPresignedDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return getSignedUrl(this.client, command, { expiresIn });
  }
  
  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
  }
  
  async deleteObjects(keys: string[]): Promise<void> {
    await Promise.all(keys.map(key => this.deleteObject(key)));
  }
  
  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      return true;
    } catch {
      return false;
    }
  }
}
```

### Alibaba OSS Provider

File: `packages/cloud/src/services/client/gallery/alibaba.gallery.provider.ts`

```typescript
import { 
  S3Client, 
  PutObjectCommand, 
  GetObjectCommand, 
  DeleteObjectCommand, 
  HeadObjectCommand 
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GalleryProvider, StorageProviderType } from "./gallery.provider";

export class AlibabaGalleryProvider implements GalleryProvider {
  readonly providerType: StorageProviderType = 'alibaba-oss';
  private client: S3Client;
  private bucket: string;
  
  constructor() {
    const endpoint = process.env.ALIBABA_OSS_ENDPOINT;
    const accessKeyId = process.env.ALIBABA_ACCESS_KEY_ID;
    const secretAccessKey = process.env.ALIBABA_SECRET_ACCESS_KEY;
    
    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new Error("Missing Alibaba OSS credentials");
    }
    
    this.bucket = process.env.ALIBABA_GALLERY_BUCKET || "mentra-gallery";
    this.client = new S3Client({
      region: process.env.ALIBABA_OSS_REGION || "cn-hangzhou",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  
  generateKey(userId: string, filename: string): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const uuid = crypto.randomUUID();
    const ext = filename.split('.').pop() || 'bin';
    return `${userId}/${year}/${month}/${uuid}.${ext}`;
  }
  
  async uploadObject(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: data,
      ContentType: contentType,
    }));
  }
  
  async getPresignedUploadUrl(key: string, contentType: string, expiresIn = 3600): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(this.client, command, { expiresIn });
  }
  
  async getPresignedDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return getSignedUrl(this.client, command, { expiresIn });
  }
  
  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
  }
  
  async deleteObjects(keys: string[]): Promise<void> {
    await Promise.all(keys.map(key => this.deleteObject(key)));
  }
  
  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      return true;
    } catch {
      return false;
    }
  }
}
```

### Gallery Service

File: `packages/cloud/src/services/client/gallery/gallery.service.ts`

```typescript
import { Logger } from "pino";
import { GalleryProvider, StorageProviderType } from "./gallery.provider";
import { CloudflareGalleryProvider } from "./cloudflare.gallery.provider";
import { AlibabaGalleryProvider } from "./alibaba.gallery.provider";
import { GalleryItem, GalleryItemI } from "../../../models/gallery-item.model";
import { logger as rootLogger } from "../../logging";

const logger = rootLogger.child({ service: "gallery" });

// Singleton provider instance
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
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY
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
    throw new Error(
      "No gallery storage provider configured. Set R2_* or ALIBABA_* env vars."
    );
  }
  
  return providerInstance;
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
  
  // Create DB record first (status: uploading)
  const item = new GalleryItem({
    userId: params.userId,
    type: 'image',
    filename: params.filename,
    mimeType: params.mimeType,
    sizeBytes: params.file.length,
    storageProvider: provider.providerType,
    storageKey,
    status: 'uploading',
    capturedAt: params.capturedAt,
    deviceId: params.deviceId,
    metadata: params.metadata,
  });
  await item.save();
  
  try {
    // Upload to storage
    await provider.uploadObject(storageKey, params.file, params.mimeType);
    
    // Update status to pending
    item.status = 'pending';
    item.uploadedAt = new Date();
    await item.save();
    
    logger.info({ itemId: item._id, userId: params.userId }, "Image uploaded successfully");
    return item;
  } catch (error) {
    // Rollback DB record on failure
    await item.deleteOne();
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
    type: 'video',
    filename: params.filename,
    mimeType: params.mimeType,
    sizeBytes: params.sizeBytes,
    storageProvider: provider.providerType,
    storageKey,
    status: 'uploading',
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
    status: 'uploading',
    type: 'video',
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
  item.status = 'pending';
  item.uploadedAt = new Date();
  await item.save();
  
  logger.info({ itemId: item._id, userId }, "Video upload completed");
  return item;
}

// ============================================================================
// Pending Items (for Mobile)
// ============================================================================

export interface PendingItem {
  id: string;
  type: 'image' | 'video';
  filename: string;
  mimeType: string;
  sizeBytes: number;
  capturedAt: Date;
  uploadedAt: Date;
  downloadUrl: string;
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
  options: { limit?: number; cursor?: string; type?: 'image' | 'video' } = {}
): Promise<GetPendingResult> {
  const provider = getProvider();
  const limit = Math.min(options.limit || 50, 100);
  
  // Build query
  const query: any = { userId, status: 'pending' };
  if (options.type) {
    query.type = options.type;
  }
  if (options.cursor) {
    query._id = { $lt: options.cursor };
  }
  
  // Get total stats
  const [totalStats] = await GalleryItem.aggregate([
    { $match: { userId, status: 'pending' } },
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
  
  // Generate download URLs for each item
  const pendingItems: PendingItem[] = await Promise.all(
    items.map(async (item) => ({
      id: item._id.toString(),
      type: item.type,
      filename: item.filename,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      capturedAt: item.capturedAt,
      uploadedAt: item.uploadedAt!,
      downloadUrl: await provider.getPresignedDownloadUrl(item.storageKey),
      metadata: item.metadata ? {
        width: item.metadata.width,
        height: item.metadata.height,
        duration: item.metadata.duration,
      } : undefined,
    }))
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
    status: 'pending',
  });
  
  if (items.length === 0) {
    return { synced: 0, deleted: 0 };
  }
  
  // Delete from storage
  const keys = items.map(item => item.storageKey);
  await provider.deleteObjects(keys);
  
  // Update status to synced
  const now = new Date();
  await GalleryItem.updateMany(
    { _id: { $in: items.map(i => i._id) } },
    { $set: { status: 'synced', syncedAt: now } }
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
    status: { $in: ['uploading', 'pending'] },
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
  item.status = 'deleted';
  item.deletedAt = new Date();
  await item.save();
  
  logger.info({ itemId, userId }, "Item deleted");
}

// ============================================================================
// Cleanup Job
// ============================================================================

export async function cleanupStaleUploads(): Promise<number> {
  const provider = getProvider();
  const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours
  
  const staleItems = await GalleryItem.find({
    status: 'uploading',
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
```

## Data Model

File: `packages/cloud/src/models/gallery-item.model.ts`

```typescript
import mongoose, { Schema, Document } from "mongoose";
import { StorageProviderType } from "../services/client/gallery/gallery.provider";

export interface GalleryItemI extends Document {
  _id: mongoose.Types.ObjectId;
  userId: string;
  type: 'image' | 'video';
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storageProvider: StorageProviderType;
  storageKey: string;
  status: 'uploading' | 'pending' | 'synced' | 'deleted';
  capturedAt: Date;
  uploadedAt?: Date;
  syncedAt?: Date;
  deletedAt?: Date;
  deviceId?: string;
  metadata?: {
    width?: number;
    height?: number;
    duration?: number;
    gps?: { lat: number; lng: number };
  };
  createdAt: Date;
  updatedAt: Date;
}

const GalleryItemSchema = new Schema<GalleryItemI>(
  {
    userId: { type: String, required: true, index: true },
    type: { type: String, enum: ['image', 'video'], required: true },
    filename: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    storageProvider: { type: String, enum: ['cloudflare-r2', 'alibaba-oss'], required: true },
    storageKey: { type: String, required: true, unique: true },
    status: { 
      type: String, 
      enum: ['uploading', 'pending', 'synced', 'deleted'],
      default: 'uploading',
      index: true,
    },
    capturedAt: { type: Date, required: true },
    uploadedAt: { type: Date },
    syncedAt: { type: Date },
    deletedAt: { type: Date },
    deviceId: { type: String },
    metadata: {
      width: Number,
      height: Number,
      duration: Number,
      gps: {
        lat: Number,
        lng: Number,
      },
    },
  },
  { timestamps: true }
);

// Compound index for listing pending items
GalleryItemSchema.index({ userId: 1, status: 1, _id: -1 });

// TTL index: auto-delete synced/deleted records after 7 days
GalleryItemSchema.index(
  { syncedAt: 1 }, 
  { expireAfterSeconds: 7 * 24 * 60 * 60, partialFilterExpression: { status: 'synced' } }
);

export const GalleryItem = mongoose.model<GalleryItemI>("GalleryItem", GalleryItemSchema);
```

## API Endpoints

### ASG APIs (Glasses)

File: `packages/cloud/src/api/client/asg/gallery.api.ts`

Uses existing `clientAuthWithEmail` middleware.

#### POST /api/client/asg/gallery/upload

Direct image upload from glasses.

```typescript
// Request
// Content-Type: multipart/form-data
// Authorization: Bearer <jwt>
{
  file: File,                    // Image file (max 20MB)
  filename: string,
  capturedAt: string,            // ISO timestamp
  deviceId?: string,
  metadata?: string,             // JSON string
}

// Response 200
{
  success: true,
  data: {
    id: string,
    uploadedAt: string,
  }
}

// Response 413
{ error: "File too large", maxSize: "20MB" }

// Response 415
{ error: "Unsupported media type", allowed: ["image/jpeg", "image/png", "image/heic"] }
```

#### POST /api/client/asg/gallery/video-upload-url

Get presigned URL for video upload.

```typescript
// Request
// Authorization: Bearer <jwt>
{
  filename: string,
  mimeType: string,
  sizeBytes: number,
  capturedAt: string,
  deviceId?: string,
  metadata?: object,
}

// Response 200
{
  success: true,
  data: {
    id: string,
    uploadUrl: string,
    expiresAt: string,
  }
}

// Response 413
{ error: "File too large", maxSize: "2GB" }
```

#### POST /api/client/asg/gallery/video-upload-complete

Confirm video upload finished.

```typescript
// Request
// Authorization: Bearer <jwt>
{
  id: string,
}

// Response 200
{
  success: true,
  data: {
    id: string,
    status: "pending",
  }
}

// Response 404
{ error: "Upload not found or expired" }
```

### Client APIs (Mobile)

File: `packages/cloud/src/api/client/gallery.api.ts`

#### GET /api/client/gallery/pending

Get stats and list of pending items with download URLs.

```typescript
// Request
// Authorization: Bearer <jwt>
// Query params:
//   limit?: number (default 50, max 100)
//   cursor?: string (pagination cursor)
//   type?: 'image' | 'video' (filter)

// Response 200
{
  success: true,
  data: {
    pendingCount: number,
    pendingTotalBytes: number,
    items: [
      {
        id: string,
        type: "image" | "video",
        filename: string,
        mimeType: string,
        sizeBytes: number,
        capturedAt: string,
        uploadedAt: string,
        downloadUrl: string,       // Presigned URL (1 hour expiry)
        metadata?: {
          width?: number,
          height?: number,
          duration?: number,
        }
      }
    ],
    cursor?: string,
  }
}
```

#### POST /api/client/gallery/mark-synced

Mark items as synced (triggers storage deletion).

```typescript
// Request
// Authorization: Bearer <jwt>
{
  ids: string[],                 // Max 100
}

// Response 200
{
  success: true,
  data: {
    synced: number,
    deleted: number,
  }
}
```

#### DELETE /api/client/gallery/:id

Delete pending item without downloading.

```typescript
// Request
// Authorization: Bearer <jwt>

// Response 200
{
  success: true,
  message: "Item deleted",
}

// Response 404
{ error: "Item not found" }
```

## Upload Flows

### Image Upload (Direct)

```
Glasses                         Cloud                         Storage
   │                              │                              │
   │ POST /api/client/asg/gallery/upload                         │
   │ [multipart: file + metadata]                                │
   ├─────────────────────────────►│                              │
   │                              │                              │
   │                              │  Validate (size, type)       │
   │                              │  Get provider                │
   │                              │  Generate storage key        │
   │                              │  Create GalleryItem (uploading)
   │                              │                              │
   │                              │  PUT object                  │
   │                              ├─────────────────────────────►│
   │                              │                              │
   │                              │◄─────────────────────────────┤
   │                              │                              │
   │                              │  Update status → pending     │
   │                              │                              │
   │  { success, id }             │                              │
   │◄─────────────────────────────┤                              │
```

### Video Upload (Presigned URL)

```
Glasses                         Cloud                         Storage
   │                              │                              │
   │ POST /api/client/asg/gallery/video-upload-url               │
   │ { filename, size, ... }      │                              │
   ├─────────────────────────────►│                              │
   │                              │                              │