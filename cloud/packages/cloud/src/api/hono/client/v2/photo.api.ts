/**
 * Stateless cloud surface for phone-orchestrated local-miniapp photo capture.
 *
 * Mounted at: /api/v2/client/photo
 *
 * Flow:
 *   - Phone POSTs /request → cloud mints a signed upload token + URL.
 *   - Phone tells glasses (over BLE) to capture & upload to that URL.
 *   - Glasses (WiFi direct) or phone (BLE fallback) POSTs multipart to /upload/:requestId.
 *   - Phone long-polls GET /:requestId; cloud resolves on upload or 30s timeout.
 *
 * State held in-process only: a single Map keyed by requestId tracking
 * pending / ready / error per slot, plus a long-poll waiter list. Lost on
 * restart — caller re-takes. Same pattern as v2 streams' liveInputOwner.
 *
 * Reuses miniappSdkPhotoStorage (R2 wrapper) verbatim. No new bucket.
 */

import { Hono } from "hono";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";

import { clientAuth } from "../../middleware/client.middleware";
import { logger as rootLogger } from "../../../../services/logging/pino-logger";
import { miniappSdkPhotoStorage } from "../../../../services/storage/miniapp-sdk-photo-storage.service";
import type { AppEnv, AppContext } from "../../../../types/hono";

const logger = rootLogger.child({ service: "v2.photo.api" });

// 180s covers worst-case slow BLE fallback (medium JPEG ~300KB at typical
// post-framing rates of 5-20 KB/s = 15-60s of transfer, plus capture/decode
// + a few seconds of BLE command latency). Tighten when we have telemetry.
const UPLOAD_TOKEN_TTL_SECONDS = 180;
const DOWNLOAD_URL_TTL_SECONDS = 30 * 60; // 30 minutes (decision #6 — ephemeral).
const LONG_POLL_TIMEOUT_MS = 30_000;
const JANITOR_INTERVAL_MS = 60_000;
const SLOT_MAX_AGE_MS = 60 * 60_000; // drop entries older than an hour

const UPLOAD_TOKEN_PURPOSE = "v2_photo_upload" as const;

type PhotoState =
  | { kind: "pending"; userId: string; createdAt: number }
  | {
      kind: "ready";
      userId: string;
      photoUrl: string;
      mimeType: string;
      size: number;
      readyAt: number;
    }
  | { kind: "error"; userId: string; code: string; message: string; at: number };

/** Slots keyed by requestId (UUID minted in /request). */
const photos: Map<string, PhotoState> = new Map();

/** Long-poll waiters keyed by requestId. */
type WaiterFn = (s: PhotoState) => void;
const waiters: Map<string, Set<WaiterFn>> = new Map();

function addWaiter(requestId: string, cb: WaiterFn): void {
  let set = waiters.get(requestId);
  if (!set) {
    set = new Set();
    waiters.set(requestId, set);
  }
  set.add(cb);
}

function removeWaiter(requestId: string, cb: WaiterFn): void {
  const set = waiters.get(requestId);
  if (!set) return;
  set.delete(cb);
  if (set.size === 0) waiters.delete(requestId);
}

function resolveWaiters(requestId: string, state: PhotoState): void {
  const set = waiters.get(requestId);
  if (!set) return;
  waiters.delete(requestId);
  for (const cb of set) {
    try {
      cb(state);
    } catch (err) {
      logger.warn({ err, requestId }, "waiter threw");
    }
  }
}

function getUploadSecret(): string | null {
  const secret = process.env.MENTRA_PHOTO_UPLOAD_SECRET;
  if (secret) return secret;
  logger.error("MENTRA_PHOTO_UPLOAD_SECRET is not configured");
  return null;
}

/**
 * Best-effort cleanup of long-stale entries. SLOT_MAX_AGE_MS is much longer
 * than any realistic upload (upload token is 120s; long-poll is 30s). In
 * practice this just sweeps slots whose miniapp aborted mid-flow.
 *
 * Don't evict a slot that still has active waiters — that would leave a
 * waiter dangling. (Unreachable today because the long-poll caps at 30s,
 * but cheap to guard against.)
 */
setInterval(() => {
  const cutoff = Date.now() - SLOT_MAX_AGE_MS;
  for (const [id, state] of photos) {
    if (waiters.has(id)) continue;
    const ts =
      state.kind === "pending"
        ? state.createdAt
        : state.kind === "ready"
          ? state.readyAt
          : state.at;
    if (ts < cutoff) photos.delete(id);
  }
}, JANITOR_INTERVAL_MS).unref?.();

const app = new Hono<AppEnv>();

app.post("/request", clientAuth, handleRequest);
app.post("/upload/:requestId", handleUpload); // bearer-token auth, not clientAuth
app.get("/:requestId", clientAuth, handlePoll);
app.delete("/:requestId", clientAuth, handleDelete);

/**
 * POST /request
 * Body: (none required; ignored for now — photo options live in the BLE
 *        command, not the cloud request)
 * Returns: {requestId, uploadUrl, uploadToken}
 *
 * The phone passes the returned uploadUrl + uploadToken straight to
 * BluetoothSdk.requestPhoto, which hands them to glasses over BLE. Glasses
 * (or phone's BLE fallback) POST multipart bytes to /upload/:requestId
 * with Authorization: Bearer <uploadToken>.
 */
async function handleRequest(c: AppContext) {
  const reqLogger = c.get("logger") || logger;
  const email = c.get("email")!;
  const uploadSecret = getUploadSecret();
  if (!uploadSecret) {
    return c.json(
      { success: false, code: "upload_secret_missing", message: "Photo upload secret is not configured" },
      503,
    );
  }

  const requestId = uuidv4();
  // Capability token: "this user may upload one photo within UPLOAD_TOKEN_TTL_SECONDS."
  // The URL path identifies the slot; the in-memory map enforces ownership.
  const uploadToken = jwt.sign(
    { userId: email, purpose: UPLOAD_TOKEN_PURPOSE },
    uploadSecret,
    { expiresIn: UPLOAD_TOKEN_TTL_SECONDS },
  );

  const cloudHost = process.env.CLOUD_PUBLIC_HOST_NAME || "localhost:8002";
  const protocol = cloudHost.includes("localhost") ? "http" : "https";
  const uploadUrl = `${protocol}://${cloudHost}/api/v2/client/photo/upload/${requestId}`;

  photos.set(requestId, { kind: "pending", userId: email, createdAt: Date.now() });

  reqLogger.info({ requestId }, "v2 photo slot minted");

  return c.json({ requestId, uploadUrl, uploadToken });
}

/**
 * POST /upload/:requestId — multipart {photo: File}, Bearer uploadToken.
 * Glasses POST here verbatim per MediaCaptureService.performDirectUpload
 * (multipart with `photo` file + Bearer auth header).
 */
async function handleUpload(c: AppContext) {
  const reqLogger = c.get("logger") || logger;
  const requestId = c.req.param("requestId");
  if (!requestId) {
    return c.json({ success: false, message: "requestId required" }, 400);
  }
  const uploadSecret = getUploadSecret();
  if (!uploadSecret) {
    return c.json(
      { success: false, code: "upload_secret_missing", message: "Photo upload secret is not configured" },
      503,
    );
  }

  // ---- auth ----
  const authHeader = c.req.header("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ success: false, message: "Missing or invalid Authorization header" }, 401);
  }
  const token = authHeader.substring(7);
  let payload: { userId: string; purpose: string };
  try {
    payload = jwt.verify(token, uploadSecret) as { userId: string; purpose: string };
  } catch (err) {
    reqLogger.warn({ err, requestId }, "upload token verify failed");
    return c.json({ success: false, message: "Invalid or expired upload token" }, 401);
  }
  if (payload.purpose !== UPLOAD_TOKEN_PURPOSE) {
    return c.json({ success: false, message: "Wrong token purpose" }, 401);
  }
  if (typeof payload.userId !== "string" || payload.userId.length === 0) {
    return c.json({ success: false, message: "Token missing userId" }, 401);
  }

  // ---- slot lookup + ownership ----
  const entry = photos.get(requestId);
  // Both checks fail with 404 (don't leak which requestIds exist):
  //   - missing slot
  //   - slot exists but belongs to a different user
  if (!entry || entry.userId !== payload.userId) {
    return c.json({ success: false, code: "not_found", message: "Photo slot not found" }, 404);
  }
  // Re-upload to a slot that already completed (or errored): reject.
  if (entry.kind !== "pending") {
    return c.json(
      { success: false, code: "already_resolved", message: `Slot is already ${entry.kind}` },
      409,
    );
  }

  // ---- multipart parse ----
  let photoFile: File;
  try {
    const form = await c.req.formData();
    const photoField = form.get("photo");
    if (!(photoField instanceof File)) {
      return c.json({ success: false, message: "'photo' field must be a file" }, 400);
    }
    photoFile = photoField;
  } catch (err) {
    reqLogger.warn({ err, requestId }, "multipart parse failed");
    return c.json({ success: false, message: "Failed to parse multipart body" }, 400);
  }

  // ---- store in R2 + mint short-TTL download URL ----
  try {
    const buf = Buffer.from(await photoFile.arrayBuffer());
    const mimeType = photoFile.type || "image/jpeg";
    const { key, sizeBytes } = await miniappSdkPhotoStorage.putPhoto({
      userId: payload.userId,
      requestId,
      buffer: buf,
      mimeType,
    });
    const photoUrl = await miniappSdkPhotoStorage.getSignedDownloadUrl(
      key,
      DOWNLOAD_URL_TTL_SECONDS,
    );

    const ready: PhotoState = {
      kind: "ready",
      userId: payload.userId,
      photoUrl,
      mimeType,
      size: sizeBytes,
      readyAt: Date.now(),
    };
    photos.set(requestId, ready);
    resolveWaiters(requestId, ready);

    reqLogger.info({ requestId, sizeBytes, mimeType }, "v2 photo uploaded");
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // miniappSdkPhotoStorage throws "R2 not configured ..." if creds missing.
    if (message.includes("R2 not configured")) {
      const errState: PhotoState = {
        kind: "error",
        userId: payload.userId,
        code: "storage_unavailable",
        message: "Photo storage is not configured on this host",
        at: Date.now(),
      };
      photos.set(requestId, errState);
      resolveWaiters(requestId, errState);
      reqLogger.error({ err, requestId }, "v2 photo upload: R2 not configured");
      return c.json(
        { success: false, code: "storage_unavailable", message: errState.message },
        503,
      );
    }
    reqLogger.error({ err, requestId }, "v2 photo upload failed");
    const errState: PhotoState = {
      kind: "error",
      userId: payload.userId,
      code: "upload_failed",
      message,
      at: Date.now(),
    };
    photos.set(requestId, errState);
    resolveWaiters(requestId, errState);
    return c.json({ success: false, code: "upload_failed", message }, 500);
  }
}

/**
 * GET /:requestId — long-poll, hangs up to 30s waiting for /upload.
 * Returns:
 *   200 — slot is ready: {photoUrl, mimeType, size}
 *   408 — slot still pending after 30s OR client aborted
 *   502 — slot errored (e.g. storage_unavailable)
 *   404 — slot doesn't exist or belongs to another user
 */
async function handlePoll(c: AppContext) {
  const reqLogger = c.get("logger") || logger;
  const email = c.get("email")!;
  const requestId = c.req.param("requestId");
  if (!requestId) {
    return c.json({ success: false, message: "requestId required" }, 400);
  }

  const entry = photos.get(requestId);
  if (!entry || entry.userId !== email) {
    return c.json({ success: false, code: "not_found", message: "Photo not found" }, 404);
  }
  if (entry.kind === "ready") {
    return c.json(
      { photoUrl: entry.photoUrl, mimeType: entry.mimeType, size: entry.size },
      200,
    );
  }
  if (entry.kind === "error") {
    return c.json({ success: false, code: entry.code, message: entry.message }, 502);
  }

  // Pending — hang up to LONG_POLL_TIMEOUT_MS, racing:
  //   1) /upload arrives → resolveWaiters fires waiterFn → resolve(ready|error)
  //   2) LONG_POLL_TIMEOUT_MS elapses → resolve({timeout})
  //   3) client aborts (closes connection) → resolve({client_aborted})
  // settle() is idempotent so whichever fires first wins.
  const result = await new Promise<PhotoState>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    let waiterFn: WaiterFn | null = null;
    const settle = (s: PhotoState) => {
      if (settled) return;
      settled = true;
      if (waiterFn) removeWaiter(requestId, waiterFn);
      if (timer) clearTimeout(timer);
      if (onAbort) {
        try {
          c.req.raw.signal?.removeEventListener("abort", onAbort);
        } catch {
          /* ignore */
        }
      }
      resolve(s);
    };
    waiterFn = (s) => settle(s);
    timer = setTimeout(() => {
      settle({
        kind: "error",
        userId: email,
        code: "timeout",
        message: "Upload did not arrive within timeout",
        at: Date.now(),
      });
    }, LONG_POLL_TIMEOUT_MS);
    onAbort = () => {
      settle({
        kind: "error",
        userId: email,
        code: "client_aborted",
        message: "Client closed connection",
        at: Date.now(),
      });
    };
    try {
      c.req.raw.signal?.addEventListener("abort", onAbort);
    } catch {
      /* AbortSignal not available on this runtime — fall back to timeout only */
    }
    addWaiter(requestId, waiterFn);
    // Defensive re-check: if the slot transitioned between our initial
    // entry-check (line ~272) and now, fire settle synchronously. The
    // current code is safe because the executor runs synchronously and
    // no `await` exists between the check and addWaiter, but a future
    // refactor adding an await would silently break this. The re-check
    // costs one Map.get and protects against that.
    const recheck = photos.get(requestId);
    if (recheck && recheck.kind !== "pending") settle(recheck);
  });

  if (result.kind === "ready") {
    return c.json(
      { photoUrl: result.photoUrl, mimeType: result.mimeType, size: result.size },
      200,
    );
  }
  if (result.kind === "error") {
    if (result.code === "timeout" || result.code === "client_aborted") {
      return c.json({ success: false, code: result.code, message: result.message }, 408);
    }
    return c.json({ success: false, code: result.code, message: result.message }, 502);
  }
  // Unreachable; the only non-pending states are ready or error.
  reqLogger.error({ requestId }, "v2 photo poll: settled in pending state");
  return c.json({ success: false, code: "internal", message: "unreachable" }, 500);
}

/**
 * DELETE /:requestId — early cleanup. Idempotent. Frees the map entry.
 * The R2 object is left untouched (bucket has a 1-day lifecycle rule).
 */
async function handleDelete(c: AppContext) {
  const email = c.get("email")!;
  const requestId = c.req.param("requestId");
  if (!requestId) {
    return c.json({ ok: true });
  }

  const entry = photos.get(requestId);
  // Identical response shape for "doesn't exist" and "not yours" so a probe
  // can't distinguish.
  if (entry && entry.userId === email) {
    photos.delete(requestId);
  }
  return c.json({ ok: true });
}

export default app;

// ============================================================================
// Test helpers — exported so the bun:test file can poke internal state.
// Not part of the route's HTTP surface.
// ============================================================================
export const __testing__ = {
  photos,
  waiters,
  clearAll(): void {
    photos.clear();
    waiters.clear();
  },
};
