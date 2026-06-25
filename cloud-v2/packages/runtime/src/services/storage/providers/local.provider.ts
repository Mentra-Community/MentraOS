/**
 * @fileoverview Local-fs storage provider.
 *
 * Stores blobs in a temp directory and lets the runtime serve them itself: the
 * presigned upload/download URLs point back at the runtime's own
 * `/api/camera/blob/:key` endpoints (see api/camera.api.ts). Because the runtime
 * is the upload endpoint, it knows the instant an upload lands, so there is no
 * polling or webhook for completion.
 *
 * This is the default provider: local dev, CI, and a worked example of a custom
 * implementation, with no third-party dependency. Production points
 * `STORAGE_PROVIDER` at r2/s3 instead.
 */

import { mkdir, readFile, writeFile, unlink, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type {
  PresignedUpload,
  PresignOptions,
  StorageProvider,
  StoredObject,
} from "../storage.service";

/** Where blobs live on disk. Override with CAMERA_LOCAL_DIR. */
const BLOB_DIR = process.env.CAMERA_LOCAL_DIR ?? join(tmpdir(), "mentra-camera-blobs");

/** The runtime path that serves local blobs. Kept in sync with camera.api.ts. */
const BLOB_ROUTE = "/api/camera/blob";

/** A tiny per-key content-type sidecar so `get` can return the right type. */
function paths(key: string): { blob: string; meta: string } {
  const safe = key.replace(/\.\.(\/|\\)/g, ""); // defense-in-depth against traversal
  const blob = join(BLOB_DIR, safe);
  return { blob, meta: `${blob}.type` };
}

export function createLocalProvider(): StorageProvider {
  return {
    name: "local",
    servesBytes: true,

    async presignUpload(key: string, opts: PresignOptions): Promise<PresignedUpload> {
      // No real signature: the local endpoints are unauthenticated dev URLs.
      // The origin makes the URL absolute so a device (or a test) can PUT to it.
      const base = opts.origin ?? "";
      return {
        url: `${base}${BLOB_ROUTE}/${key}`,
        method: "PUT",
        headers: opts.contentType ? { "Content-Type": opts.contentType } : undefined,
      };
    },

    async presignDownload(key: string, opts?: PresignOptions): Promise<string> {
      const base = opts?.origin ?? "";
      return `${base}${BLOB_ROUTE}/${key}`;
    },

    async exists(key: string): Promise<boolean> {
      try {
        await stat(paths(key).blob);
        return true;
      } catch {
        return false;
      }
    },

    async delete(key: string): Promise<void> {
      const { blob, meta } = paths(key);
      await unlink(blob).catch(() => undefined);
      await unlink(meta).catch(() => undefined);
    },

    async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
      const { blob, meta } = paths(key);
      await mkdir(dirname(blob), { recursive: true });
      await writeFile(blob, bytes);
      await writeFile(meta, contentType);
    },

    async get(key: string): Promise<StoredObject | null> {
      const { blob, meta } = paths(key);
      try {
        const bytes = await readFile(blob);
        const contentType = await readFile(meta, "utf8").catch(
          () => "application/octet-stream",
        );
        return { bytes: new Uint8Array(bytes), contentType };
      } catch {
        return null;
      }
    },
  };
}
