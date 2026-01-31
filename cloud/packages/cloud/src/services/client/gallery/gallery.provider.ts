// services/client/gallery/gallery.provider.ts
// Interface for gallery storage providers (Cloudflare R2, Alibaba OSS)

export type StorageProviderType = "cloudflare-r2" | "alibaba-oss";

export interface GalleryProvider {
  /**
   * The type of storage provider
   */
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
