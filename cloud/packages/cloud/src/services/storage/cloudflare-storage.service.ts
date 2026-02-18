import FormData from "form-data";
import axios from "axios";
import { Logger } from "pino";
import { Types } from "mongoose";

export class CloudflareStorageService {
  private cloudflareAccountId: string;
  private cloudflareApiToken: string;
  private cloudflareImageUploadUrl: string;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    this.cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID || "";
    this.cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN || "";
    this.cloudflareImageUploadUrl = `https://api.cloudflare.com/client/v4/accounts/${this.cloudflareAccountId}/images/v1`;

    if (!this.cloudflareAccountId || !this.cloudflareApiToken) {
      this.logger.error(
        {
          hasAccountId: !!this.cloudflareAccountId,
          hasApiToken: !!this.cloudflareApiToken,
        },
        "Cloudflare credentials not configured",
      );
      throw new Error("Cloudflare account ID or API token not found");
    }
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
    replaceImageId: string;
    orgId?: Types.ObjectId;
  }): Promise<{ url?: string; imageId: string }> {
    const formData = new FormData();
    formData.append("file", image, {
      filename,
      contentType: mimetype,
    });

    // Add metadata to help identify the image
    const cfMetadata = {
      uploadedBy: email,
      uploadedAt: new Date().toISOString(),
      organizationId: orgId, // Add org context for tracking
      ...(appPackageName && {
        appPackageName: appPackageName,
      }),
      ...(replaceImageId && { replacedImageId: replaceImageId }),
    };

    this.logger.debug(
      {
        cloudflareMetadata: cfMetadata,
        formDataKeys: ["file", "metadata"],
      },
      "Prepared Cloudflare upload payload",
    );

    formData.append("metadata", JSON.stringify(cfMetadata));

    this.logger.info(
      {
        cloudflareUrl: this.cloudflareImageUploadUrl.replace(this.cloudflareAccountId, "[ACCOUNT_ID]"),
        fileSize: image.length,
        fileName: filename,
      },
      "Sending request to Cloudflare Images API",
    );

    const imageData = await this.uploadImage(formData);

    let deliveryUrl: string | undefined;

    if (imageData.variants && Array.isArray(imageData.variants)) {
      // For preview images, use highest quality available
      // Priority: original (uncompressed) > public (high quality) > square (thumbnail)
      let preferredVariants: string[];

      if (appPackageName) {
        // Preview images: try original first, then public
        preferredVariants = ["original", "public"];
      } else {
        // App logos: use square for smaller file size
        preferredVariants = ["square"];
      }

      // Try to find preferred variants in order
      for (const variant of preferredVariants) {
        const foundVariant = imageData.variants.find((url: string) => url.includes(`/${variant}`));

        if (foundVariant) {
          deliveryUrl = foundVariant;
          this.logger.debug(
            {
              variant,
              url: deliveryUrl,
            },
            `Using ${variant} variant`,
          );
          break;
        }
      }

      // If no preferred variant found, construct URL with first preference
      if (!deliveryUrl) {
        const firstVariant = imageData.variants[0];
        const targetVariant = preferredVariants[0];

        if (firstVariant && typeof firstVariant === "string") {
          // eslint-disable-next-line no-useless-escape
          deliveryUrl = firstVariant.replace(/\/[^\/]+$/, `/${targetVariant}`);
          this.logger.debug(
            {
              originalVariant: firstVariant,
              newUrl: deliveryUrl,
              variant: targetVariant,
            },
            `Replaced variant with ${targetVariant}`,
          );
        } else {
          this.logger.error("No cloudflare variants found");
        }
      }
    }

    this.logger.info(
      {
        imageId: imageData.id,
        deliveryUrl,
        variants: imageData.variants,
        uploaded: imageData.uploaded,
      },
      "Image uploaded successfully to Cloudflare",
    );

    if (replaceImageId) {
      try {
        await this.deleteImage(replaceImageId);
        this.logger.info({ deletedImageId: replaceImageId }, "Successfully deleted old image");
      } catch (deleteError) {
        this.logger.error(
          {
            replaceImageId,
            deleteError: deleteError instanceof Error ? deleteError.message : String(deleteError),
            deleteStatus: (deleteError as any)?.response?.status,
          },
          "Failed to delete old image - continuing anyway",
        );
      }
    }

    return {
      url: deliveryUrl,
      imageId: imageData.id,
    };
  }

  async uploadImage(formData: FormData): Promise<any> {
    const response = await axios.post(this.cloudflareImageUploadUrl, formData, {
      headers: {
        Authorization: `Bearer ${this.cloudflareApiToken}`,
        ...formData.getHeaders(),
      },
    });
    this.logger.debug(
      {
        success: response.data.success,
        hasResult: !!response.data.result,
        hasErrors: !!(response.data.errors && response.data.errors.length > 0),
      },
      "Received response from Cloudflare API",
    );
    if (!response.data.success) {
      this.logger.error(
        {
          cloudflareErrors: response.data.errors,
          responseStatus: response.status,
        },
        "Cloudflare API returned error response",
      );
      throw new Error("Failed to upload image to Cloudflare");
    }
    return response.data.result;
  }

  async deleteImage(imageId: string): Promise<void> {
    try {
      await axios.delete(
        `https://api.cloudflare.com/client/v4/accounts/${this.cloudflareAccountId}/images/v1/${imageId}`,
        {
          headers: {
            Authorization: `Bearer ${this.cloudflareApiToken}`,
          },
        },
      );
    } catch (cfError: any) {
      // if 404 throw error that image not found
      if (cfError.response?.status === 404) {
        throw new Error("Image not found");
      }
      throw new Error(cfError.response?.data?.errors?.[0]?.message || "Failed to delete image");
    }
  }
}
