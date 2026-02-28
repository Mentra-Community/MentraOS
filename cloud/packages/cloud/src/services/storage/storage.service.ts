import { AlibabaStorageService } from "./alibaba-storage.service";
import { CloudflareStorageService } from "./cloudflare-storage.service";
import { R2StorageService } from "./r2-storage.service";
import { Types } from "mongoose";
import { Logger } from "pino";

export class StorageService {
  private storageService: AlibabaStorageService | R2StorageService;
  constructor(logger: Logger) {
    // check region is china then use alibaba storage else use R2 storage
    const region = process.env.DEPLOYMENT_REGION || "global";
    this.storageService = region === "china" ? new AlibabaStorageService(logger) : new R2StorageService(logger); // CHANGED: Use R2 instead of Cloudflare Images
    // : new CloudflareStorageService(logger);  // OLD (kept for reference/rollback)
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
    return this.storageService.uploadImageAndReplace({
      image,
      filename,
      appPackageName,
      mimetype,
      email,
      orgId,
      replaceImageId,
    });
  }

  async deleteImage(imageId: string): Promise<void> {
    return this.storageService.deleteImage(imageId);
  }
}
