// services/storage/miniapp-sdk-photo-storage.service.ts
// Private R2 storage for miniapp SDK camera photos (from takePhoto()).
// No public access — miniapps receive short-TTL signed download URLs.

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { logger as rootLogger } from "../logging/pino-logger";

const logger = rootLogger.child({ service: "miniapp-sdk-photo-storage" });

const DEFAULT_DOWNLOAD_TTL_SECONDS = 15 * 60; // 15 minutes

/**
 * Service for storing and fetching miniapp SDK camera photos.
 * Uses a private R2 bucket with a lifecycle rule that auto-expires objects
 * after 1 day (configured on the bucket itself, not in code).
 */
class MiniappSdkPhotoStorageService {
  private s3Client: S3Client | null = null;
  private bucketName: string;
  private initialized = false;

  constructor() {
    this.bucketName = process.env.R2_MINIAPP_SDK_PHOTOS_BUCKET || "mentra-miniapp-sdk-photos";
  }

  /**
   * Lazy init so the service can be imported even if R2 creds are missing.
   * Without creds, all operations no-op or throw — matches IncidentStorageService pattern.
   */
  private ensureInitialized(): void {
    if (this.initialized) return;

    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

    if (!accountId || !accessKeyId || !secretAccessKey) {
      logger.warn(
        {
          hasAccountId: !!accountId,
          hasAccessKeyId: !!accessKeyId,
          hasSecretAccessKey: !!secretAccessKey,
        },
        "R2 credentials not configured — miniapp SDK photo storage disabled",
      );
      this.initialized = true;
      return;
    }

    this.s3Client = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    this.initialized = true;
    logger.info({ bucketName: this.bucketName }, "MiniappSdkPhotoStorageService initialized");
  }

  /**
   * Store a photo captured via miniapp SDK `takePhoto()` into the private bucket.
   * Returns the object key for later signed-URL generation.
   */
  async putPhoto(params: {
    userId: string;
    requestId: string;
    buffer: Buffer;
    mimeType: string;
  }): Promise<{ key: string; sizeBytes: number }> {
    this.ensureInitialized();

    if (!this.s3Client) {
      throw new Error("R2 not configured — miniapp SDK photo storage unavailable");
    }

    const { userId, requestId, buffer, mimeType } = params;
    const timestamp = Date.now();
    const ext = mimeType === "image/png" ? "png" : "jpg";
    const key = `sdk_photos/${userId}/${requestId}-${timestamp}.${ext}`;

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
        Metadata: {
          userid: userId,
          requestid: requestId,
          uploadedat: new Date().toISOString(),
        },
      }),
    );

    logger.info({ key, sizeBytes: buffer.length, mimeType }, "Miniapp SDK photo uploaded to R2");

    return { key, sizeBytes: buffer.length };
  }

  /**
   * Mint a short-TTL signed download URL for a stored photo.
   * Default TTL is 15 minutes — miniapps must fetch within that window.
   */
  async getSignedDownloadUrl(key: string, ttlSeconds: number = DEFAULT_DOWNLOAD_TTL_SECONDS): Promise<string> {
    this.ensureInitialized();

    if (!this.s3Client) {
      throw new Error("R2 not configured — miniapp SDK photo storage unavailable");
    }

    // Cast around a known TS type mismatch between `@aws-sdk/client-s3` and
    // `@aws-sdk/s3-request-presigner` when they resolve different `@smithy/types`
    // minor versions (structurally equivalent at runtime). Safe to cast.
    const signer = getSignedUrl as unknown as (
      client: unknown,
      command: unknown,
      options: { expiresIn: number },
    ) => Promise<string>;
    return signer(
      this.s3Client,
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  async deletePhoto(key: string): Promise<void> {
    this.ensureInitialized();

    if (!this.s3Client) return;

    try {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        }),
      );
      logger.info({ key }, "Miniapp SDK photo deleted from R2");
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err), key },
        "Failed to delete miniapp SDK photo from R2",
      );
    }
  }
}

export const miniappSdkPhotoStorage = new MiniappSdkPhotoStorageService();
export { MiniappSdkPhotoStorageService };
