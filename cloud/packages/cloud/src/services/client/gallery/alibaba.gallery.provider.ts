// services/client/gallery/alibaba.gallery.provider.ts
// Alibaba OSS implementation of GalleryProvider using native ali-oss SDK

import OSS from "ali-oss";
import { GalleryProvider, StorageProviderType } from "./gallery.provider";

export class AlibabaGalleryProvider implements GalleryProvider {
  readonly providerType: StorageProviderType = "alibaba-oss";
  private client: OSS;
  private bucket: string;

  constructor() {
    const endpoint = process.env.ALIBABA_OSS_ENDPOINT;
    const accessKeyId = process.env.ALIBABA_ACCESS_KEY_ID;
    const accessKeySecret = process.env.ALIBABA_ACCESS_KEY_SECRET;
    const region = process.env.ALIBABA_OSS_REGION || "oss-cn-shenzhen";

    if (!accessKeyId || !accessKeySecret) {
      throw new Error("Missing Alibaba OSS credentials");
    }

    this.bucket = process.env.ALIBABA_GALLERY_BUCKET || "mentra-gallery";

    this.client = new OSS({
      region,
      accessKeyId,
      accessKeySecret,
      bucket: this.bucket,
      ...(endpoint && { endpoint, cname: true }),
    });
  }

  generateKey(userId: string, filename: string): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const uuid = crypto.randomUUID();
    const ext = filename.split(".").pop() || "bin";
    return `gallery/${userId}/${year}/${month}/${uuid}.${ext}`;
  }

  async uploadObject(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.client.put(key, data, {
      headers: {
        "Content-Type": contentType,
      },
    });
  }

  async getPresignedUploadUrl(key: string, contentType: string, expiresIn = 3600): Promise<string> {
    // ali-oss signatureUrl with PUT method for uploads
    const url = this.client.signatureUrl(key, {
      expires: expiresIn,
      method: "PUT",
      "Content-Type": contentType,
    });
    return url;
  }

  async getPresignedDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
    // ali-oss signatureUrl with GET method for downloads
    const url = this.client.signatureUrl(key, {
      expires: expiresIn,
      method: "GET",
    });
    return url;
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.delete(key);
  }

  async deleteObjects(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    // ali-oss supports batch delete
    await this.client.deleteMulti(keys, { quiet: true });
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.head(key);
      return true;
    } catch (error: any) {
      if (error.name === "NoSuchKeyError" || error.code === "NoSuchKey") {
        return false;
      }
      throw error;
    }
  }
}
