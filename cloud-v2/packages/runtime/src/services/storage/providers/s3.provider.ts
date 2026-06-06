/**
 * @fileoverview S3-compatible storage provider (Cloudflare R2 and friends).
 *
 * Backed by Bun's native S3 client, so it needs no third-party SDK. The same
 * client targets any S3-compatible store by endpoint + credentials: Cloudflare
 * R2 (the default target), AWS S3, MinIO, and Alibaba OSS's S3-compatible
 * endpoint (config-only, not separately validated yet).
 *
 * The byte path does NOT pass through the runtime: the device PUTs straight to
 * the presigned upload URL and reads from the presigned download URL. The
 * runtime learns an upload completed from the provider's object-created event,
 * delivered to the camera storage webhook (see api/camera.api.ts); this provider
 * only mints presigned URLs and does object existence/delete.
 *
 * Config (env), with R2_* fallbacks for the common case:
 *   STORAGE_S3_ENDPOINT       (e.g. https://<account>.r2.cloudflarestorage.com)
 *   STORAGE_S3_BUCKET
 *   STORAGE_S3_ACCESS_KEY_ID
 *   STORAGE_S3_SECRET_ACCESS_KEY
 *   STORAGE_S3_REGION         (default "auto", which R2 expects)
 */

import type {
  PresignedUpload,
  PresignOptions,
  StorageProvider,
} from "../storage.service";

/** Presigned URL lifetime. Long enough for a glasses upload, short enough to limit replay. */
const PRESIGN_EXPIRES_SEC = 600;

/** First defined value among the given env var names. */
function env(...names: string[]): string | undefined {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  return undefined;
}

export function createS3Provider(): StorageProvider {
  // Accept the v2 STORAGE_S3_* names, plus R2_* and the v1 CLOUDFLARE_R2_*
  // names, so existing Cloudflare R2 credentials work without re-keying.
  const endpoint = env("STORAGE_S3_ENDPOINT", "R2_ENDPOINT", "CLOUDFLARE_R2_S3_ENDPOINT");
  const bucket = env("STORAGE_S3_BUCKET", "R2_BUCKET", "CLOUDFLARE_R2_GALLERY_BUCKET");
  const accessKeyId = env("STORAGE_S3_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID", "CLOUDFLARE_R2_ACCESS_KEY_ID");
  const secretAccessKey = env(
    "STORAGE_S3_SECRET_ACCESS_KEY",
    "R2_SECRET_ACCESS_KEY",
    "CLOUDFLARE_R2_SECRET_ACCESS_KEY",
  );
  const region = env("STORAGE_S3_REGION") ?? "auto";

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "STORAGE_PROVIDER=r2/s3 requires STORAGE_S3_ENDPOINT, STORAGE_S3_BUCKET, " +
        "STORAGE_S3_ACCESS_KEY_ID, and STORAGE_S3_SECRET_ACCESS_KEY (R2_* fallbacks accepted).",
    );
  }

  const client = new Bun.S3Client({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region,
  });

  return {
    name: "s3",
    servesBytes: false,

    async presignUpload(key: string, opts: PresignOptions): Promise<PresignedUpload> {
      const url = client.presign(key, {
        method: "PUT",
        expiresIn: PRESIGN_EXPIRES_SEC,
        type: opts.contentType,
      });
      return {
        url,
        method: "PUT",
        headers: opts.contentType ? { "Content-Type": opts.contentType } : undefined,
      };
    },

    async presignDownload(key: string): Promise<string> {
      return client.presign(key, { method: "GET", expiresIn: PRESIGN_EXPIRES_SEC });
    },

    async exists(key: string): Promise<boolean> {
      return await client.exists(key);
    },

    async delete(key: string): Promise<void> {
      await client.delete(key);
    },
  };
}
