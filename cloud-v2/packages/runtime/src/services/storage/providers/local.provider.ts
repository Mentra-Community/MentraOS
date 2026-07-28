/**
 * @fileoverview Local-fs storage provider.
 *
 * Stores blobs in a temp directory and lets the runtime serve them itself: the
 * presigned upload/download URLs point back at the runtime's own
 * `/api/camera/blob/:key` endpoints (see api/camera.api.ts). Because the runtime
 * is the upload endpoint, it knows the instant an upload lands, so there is no
 * polling or webhook for completion.
 *
 * Blobs are short-lived capture hand-offs (the device uploads, the requester
 * fetches within seconds), so they carry a deliberate TTL: `get`/`exists` treat
 * an expired blob as gone, and uploads opportunistically sweep expired files
 * from disk. The TTL matches the ~30-minute presigned read-URL lifetime the
 * remote providers give, so a `readUrl` means the same thing on every provider.
 *
 * This is the default provider: local dev, CI, and a worked example of a custom
 * implementation, with no third-party dependency. Production points
 * `STORAGE_PROVIDER` at r2/s3 instead.
 */

import { mkdir, readdir, readFile, writeFile, unlink, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type {
  PresignedUpload,
  PresignOptions,
  StorageProvider,
  StoredObject,
} from "../storage.service";

/** Where blobs live on disk. Override with CAMERA_LOCAL_DIR. Read lazily so
 *  tests (and boot scripts) can point it somewhere after modules load. */
function blobDir(): string {
  return process.env.CAMERA_LOCAL_DIR ?? join(tmpdir(), "mentra-camera-blobs");
}

/** The runtime path that serves local blobs. Kept in sync with camera.api.ts. */
const BLOB_ROUTE = "/api/camera/blob";

/**
 * How long a stored blob stays readable. Override (seconds) with
 * CAMERA_LOCAL_TTL_SEC. Documented alongside the miniapp SDK's takePhoto:
 * fetch (or copy) the photo within this window.
 */
const BLOB_TTL_MS = (Number(process.env.CAMERA_LOCAL_TTL_SEC) || 30 * 60) * 1000;

/** Don't rescan the blob dir on every upload; once a minute is plenty. */
const SWEEP_MIN_INTERVAL_MS = 60_000;
let lastSweepAt = 0;

/** A tiny per-key content-type sidecar so `get` can return the right type. */
function paths(key: string): { blob: string; meta: string } {
  const safe = key.replace(/\.\.(\/|\\)/g, ""); // defense-in-depth against traversal
  const blob = join(blobDir(), safe);
  return { blob, meta: `${blob}.type` };
}

/** mtime-based expiry: the file's age IS its TTL clock (survives restarts). */
function isExpired(mtimeMs: number): boolean {
  return Date.now() - mtimeMs > BLOB_TTL_MS;
}

/** Delete every expired file under the blob dir (blobs and `.type` sidecars alike). */
async function sweepExpired(): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(blobDir(), { recursive: true, withFileTypes: true });
  } catch {
    return; // nothing stored yet
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    try {
      const s = await stat(path);
      if (isExpired(s.mtimeMs)) await unlink(path);
    } catch {
      /* raced with another delete — fine */
    }
  }
}

/** Fire a background sweep, rate-limited so hot upload paths stay cheap. */
function maybeSweep(): void {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
  lastSweepAt = now;
  void sweepExpired();
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
        const s = await stat(paths(key).blob);
        return !isExpired(s.mtimeMs);
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
      maybeSweep();
    },

    async get(key: string): Promise<StoredObject | null> {
      const { blob, meta } = paths(key);
      try {
        const s = await stat(blob);
        if (isExpired(s.mtimeMs)) {
          await unlink(blob).catch(() => undefined);
          await unlink(meta).catch(() => undefined);
          return null;
        }
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
