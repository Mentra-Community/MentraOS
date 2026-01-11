import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Logger } from "pino";
import { Types } from "mongoose";

export class R2StorageService {
  private s3Client: S3Client;
  private bucketName: string;
  private publicUrlBase: string;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;

    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    this.bucketName = process.env.R2_BUCKET_NAME || "mentra-store";
    this.publicUrlBase = process.env.R2_PUBLIC_URL || "https://mentra-store-cdn.mentraglass.com";

    if (!accountId || !accessKeyId || !secretAccessKey) {
      this.logger.error(
        {
          hasAccountId: !!accountId,
          hasAccessKeyId: !!accessKeyId,
          hasSecretAccessKey: !!secretAccessKey,
        },
        "R2 credentials not configured",
      );
      throw new Error("R2 account ID, access key ID, or secret access key not found");
    }

    // Initialize S3 client with R2 endpoint
    this.s3Client = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    this.logger.info(
      {
        bucketName: this.bucketName,
        publicUrlBase: this.publicUrlBase,
      },
      "R2StorageService initialized",
    );
  }

  async uploadImageAndReplace({
    image,
    filename,
    appPackageName,
    mimetype,
    email,
    orgId,
    replaceImageId,
  }: {
    image: Buffer;
    filename: string;
    appPackageName?: string;
    mimetype: string;
    email: string;
    orgId?: Types.ObjectId;
    replaceImageId: string;
  }): Promise<{ url?: string; imageId: string }> {
    this.logger.info(
      {
        fileSize: image.length,
        filename,
        appPackageName,
        orgId: orgId?.toString(),
      },
      "Uploading image to R2",
    );

    // Build object key following the pattern: mini_app_assets/orgs/{orgId}/{appPackageName}/{timestamp}-{filename}
    const timestamp = Date.now();
    const sanitizedFilename = this.sanitizeFilename(filename);
    const objectKey = this.buildObjectKey({
      orgId,
      appPackageName,
      timestamp,
      filename: sanitizedFilename,
    });

    // Prepare metadata
    const metadata: Record<string, string> = {
      uploadedby: email,
      uploadedat: new Date().toISOString(),
    };

    if (orgId) {
      metadata.organizationid = orgId.toString();
    }
    if (appPackageName) {
      metadata.apppackagename = appPackageName;
    }
    if (replaceImageId) {
      metadata.replacedimageid = replaceImageId;
    }

    try {
      // Upload to R2
      const putCommand = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: objectKey,
        Body: image,
        ContentType: mimetype,
        Metadata: metadata,
      });

      await this.s3Client.send(putCommand);

      this.logger.info(
        {
          objectKey,
          fileSize: image.length,
          mimetype,
        },
        "Image uploaded successfully to R2",
      );

      // If replacing, delete the old image after upload succeeds
      if (replaceImageId) {
        try {
          await this.deleteImage(replaceImageId);
          this.logger.info({ deletedImageId: replaceImageId }, "Successfully deleted old image");
        } catch (deleteErr) {
          this.logger.warn(
            {
              replaceImageId,
              error: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
            },
            "Failed to delete replaced image - continuing anyway",
          );
        }
      }

      // Construct public URL
      const publicUrl = this.constructPublicUrl(objectKey);

      this.logger.info(
        {
          objectKey,
          publicUrl,
          publicUrlBase: this.publicUrlBase,
          bucketName: this.bucketName,
        },
        "Constructed public URL for uploaded image",
      );

      return {
        url: publicUrl,
        imageId: objectKey, // Using R2 object key as unique ID
      };
    } catch (err: any) {
      this.logger.error(
        {
          error: err.message,
          objectKey,
          fileSize: image.length,
        },
        "Failed to upload image to R2",
      );
      throw new Error("Failed to upload image to R2");
    }
  }

  async deleteImage(imageId: string): Promise<void> {
    try {
      this.logger.info({ imageId }, "Deleting image from R2");

      const deleteCommand = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: imageId,
      });

      await this.s3Client.send(deleteCommand);

      this.logger.info({ imageId }, "Image deleted successfully from R2");
    } catch (err: any) {
      // S3 DeleteObject doesn't return 404 errors, it succeeds even if object doesn't exist
      // But we'll log it anyway
      this.logger.error(
        {
          error: err.message,
          imageId,
        },
        "Error deleting image from R2",
      );
      throw new Error("Failed to delete image from R2");
    }
  }

  private buildObjectKey({
    orgId,
    appPackageName,
    timestamp,
    filename,
  }: {
    orgId?: Types.ObjectId;
    appPackageName?: string;
    timestamp: number;
    filename: string;
  }): string {
    // Build path: mini_app_assets/{appPackageName}/{timestamp}-{filename}
    // Package names are globally unique, so no need for orgId in path
    const parts = ["mini_app_assets", appPackageName || "default", `${timestamp}-${filename}`];

    return parts.join("/");
  }

  private sanitizeFilename(filename: string): string {
    // Remove or replace characters that might cause issues in URLs or file systems
    // Keep alphanumeric, dots, hyphens, and underscores
    return filename
      .replace(/[^a-zA-Z0-9._-]/g, "-") // Replace invalid chars with hyphen
      .replace(/--+/g, "-") // Replace multiple hyphens with single hyphen
      .toLowerCase();
  }

  private constructPublicUrl(objectKey: string): string {
    // Construct URL: https://mentra-store-cdn.mentraglass.com/mini_app_assets/...
    // publicUrlBase = https://mentra-store-cdn.mentraglass.com
    // objectKey = mini_app_assets/orgs/.../file.jpg
    // Note: Custom domain is already configured to point to the bucket, so we don't include bucket name in URL
    return `${this.publicUrlBase}/${objectKey}`;
  }
}
