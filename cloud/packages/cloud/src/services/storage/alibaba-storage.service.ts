import OSS from "ali-oss";
import { Types } from "mongoose";
import { Logger } from "pino";

export class AlibabaStorageService {
  private ossClient: OSS;
  private bucketName: string;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    const region = "oss-cn-shenzhen";
    const accessKeyId = process.env.ALIBABA_ACCESS_KEY_ID;
    const accessKeySecret = process.env.ALIBABA_ACCESS_KEY_SECRET;
    this.bucketName = "mentraos-dev-api-oss-public";

    if (!region || !accessKeyId || !accessKeySecret || !this.bucketName) {
      throw new Error("Alibaba OSS credentials or configuration missing");
    }

    this.ossClient = new OSS({
      accessKeyId,
      accessKeySecret,
      endpoint: "dev-assets.mentraglass.cn",
      cname: true,
      bucket: this.bucketName,
    });
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
    this.logger.info("Uploading image to Alibaba OSS");
    // Build file key with metadata context
    const timestamp = Date.now();
    const fileKey = [
      orgId ? `orgs/${orgId}` : "public",
      appPackageName || "default",
      `${timestamp}-${filename}`,
    ].join("/");

    // Include metadata in headers for traceability
    const metadata: any = {
      "x-oss-meta-uploadedby": email, // TODO: I think we should remove this....
      "x-oss-meta-uploadedat": new Date().toISOString(),
      "x-oss-meta-organizationid": orgId,
    };

    if (appPackageName) {
      metadata["x-oss-meta-apppackagename"] = appPackageName;
    }
    if (replaceImageId) {
      metadata["x-oss-meta-replacedimageid"] = replaceImageId;
    }

    try {
      // Upload image
      const result = await this.ossClient.put(fileKey, image, {
        headers: {
          "Content-Type": mimetype,
          ...metadata,
        },
      });

      this.logger.info("Image uploaded successfully to Alibaba OSS");

      // If replacing, delete the old one after upload succeeds
      if (replaceImageId) {
        try {
          await this.deleteImage(replaceImageId);
        } catch (deleteErr) {
          console.warn("Failed to delete replaced image:", deleteErr);
        }
      }

      return {
        url: result.url,
        imageId: fileKey, // Using OSS object key as unique ID
      };
    } catch (err: any) {
      this.logger.error(
        "AlibabaStorageService.uploadImageAndReplace error: " + err,
      );
      throw new Error("Failed to upload image to Alibaba OSS");
    }
  }

  async deleteImage(imageId: string): Promise<void> {
    try {
      await this.ossClient.delete(imageId);
    } catch (err: any) {
      if (err.name === "NoSuchKeyError") {
        throw new Error("Image not found");
      }
      console.error("AlibabaStorageService.deleteImage error:", err);
      throw new Error("Failed to delete image from Alibaba OSS");
    }
  }
}
