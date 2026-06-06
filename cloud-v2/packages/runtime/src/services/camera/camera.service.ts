/**
 * @fileoverview Camera service: managed photo + managed stream.
 *
 * Sits on top of the storage service. A managed photo is a request-then-push
 * flow: presign an upload + read URL, record the pending request, and push
 * `photo.ready` when the upload lands. Completion arrives one of two ways:
 *   - local provider: the runtime serves the upload, so its PUT handler calls
 *     `completeUpload` directly (instant, no polling).
 *   - r2/s3 provider: the object-created event reaches the storage webhook,
 *     which calls `completeUpload`.
 * A dev auto-capture (CAMERA_AUTOCAPTURE, opt-in) simulates the glasses by
 * self-storing a placeholder, so the flow completes without hardware in tests
 * and local dev.
 *
 * Managed stream is provisioned synchronously (stub coordinates today; a real
 * Cloudflare Stream provider lands later) and has no push.
 *
 * Pending requests live in Redis keyed by requestId, so a completion event that
 * lands on any pod can resolve the user to push to. The push itself currently
 * targets the user's WS on this pod; cross-pod push routing lands with the same
 * work the audio path needs.
 *
 * Spec: docs/issues/002-cloud-runtime/camera/spec.md.
 */

import { ulid } from "ulid";
import { createLogger } from "@mentra/cloud-shared";
import { getRedis } from "../../clients/redis.client";
import { getStorageProvider } from "../storage/storage.service";
import { forwardToUserSessions } from "../../net/ws";
import { PROTOCOL_MAJOR } from "../../protocol/envelope";
import type { PhotoOptions, StreamOptions, ManagedStream } from "../../protocol/camera";

const logger = createLogger("audio").child({ service: "camera.service" });

const PHOTO_CONTENT_TYPE = "image/jpeg";
/** Pending photo requests TTL: long enough for an upload, then abandoned. */
const PHOTO_REQUEST_TTL_SEC = 300;

/**
 * Opt-in dev simulation of the glasses capture+upload (off in production). Read
 * lazily, not at module load: the env is configured by the host/test before the
 * first request, after this module is already imported.
 */
function autocaptureEnabled(): boolean {
  return process.env.CAMERA_AUTOCAPTURE === "true";
}
/** How long the dev auto-capture waits before "uploading", so the client has
 * recorded its pending request from the POST response first. */
function autocaptureDelayMs(): number {
  return Number.parseInt(process.env.CAMERA_AUTOCAPTURE_MS ?? "50", 10);
}

interface PendingPhoto {
  mentraUserId: string;
  key: string;
  readUrl: string;
}

function photoKey(requestId: string): string {
  return `photos/${requestId}`;
}
function requestIdFromKey(key: string): string | null {
  return key.startsWith("photos/") ? key.slice("photos/".length) : null;
}
function pendingRedisKey(requestId: string): string {
  return `photo-request:${requestId}`;
}

export interface PhotoRequestResult {
  requestId: string;
  uploadUrl: string;
  readUrl: string;
}

/**
 * Create a managed-photo request: presign the upload + read URLs, record the
 * pending request, and (in dev auto-capture) simulate the upload. Returns the
 * URLs the device uses; the caller gets `photo.ready` over its WS on completion.
 */
export async function requestPhoto(
  mentraUserId: string,
  opts: PhotoOptions,
  origin: string,
): Promise<PhotoRequestResult> {
  void opts; // size/compress/etc. are passed to a real provider later
  const provider = getStorageProvider();
  const requestId = `photo_${ulid()}`;
  const key = photoKey(requestId);

  const upload = await provider.presignUpload(key, {
    contentType: PHOTO_CONTENT_TYPE,
    origin,
  });
  const readUrl = await provider.presignDownload(key, { origin });

  const pending: PendingPhoto = { mentraUserId, key, readUrl };
  await getRedis().set(
    pendingRedisKey(requestId),
    JSON.stringify(pending),
    "EX",
    PHOTO_REQUEST_TTL_SEC,
  );

  logger.info({ mentraUserId, requestId, provider: provider.name }, "managed photo requested");

  // Dev auto-capture: simulate the glasses uploading a placeholder so the flow
  // completes without hardware. Only the local provider serves its own bytes;
  // for remote providers there is nothing to self-store, so we just complete.
  if (autocaptureEnabled()) {
    setTimeout(() => {
      void simulateCapture(key);
    }, autocaptureDelayMs());
  }

  return { requestId, uploadUrl: upload.url, readUrl };
}

/** Dev-only: store a placeholder image (local provider) then mark complete. */
async function simulateCapture(key: string): Promise<void> {
  try {
    const provider = getStorageProvider();
    if (provider.servesBytes && provider.put) {
      const placeholder = new TextEncoder().encode(`mentra-local-placeholder-photo:${key}`);
      await provider.put(key, placeholder, PHOTO_CONTENT_TYPE);
    }
    await completeUpload(key);
  } catch (err) {
    logger.error({ err, key }, "auto-capture failed");
  }
}

/**
 * Mark a photo upload complete and push `photo.ready` to the requester. Called
 * by the local provider's upload handler and by the storage event webhook.
 * Idempotent: a duplicate event finds no pending entry and is a no-op.
 */
export async function completeUpload(key: string): Promise<void> {
  const requestId = requestIdFromKey(key);
  if (!requestId) return;
  const pending = await takePending(requestId);
  if (!pending) return;

  forwardToUserSessions(pending.mentraUserId, {
    v: PROTOCOL_MAJOR,
    type: "photo.ready",
    timestamp: Date.now(),
    payload: { requestId, readUrl: pending.readUrl },
  });
  logger.info({ mentraUserId: pending.mentraUserId, requestId }, "managed photo ready");
}

/** Mark a photo request failed and push `photo.error`. */
export async function failUpload(requestId: string, reason: string): Promise<void> {
  const pending = await takePending(requestId);
  if (!pending) return;
  forwardToUserSessions(pending.mentraUserId, {
    v: PROTOCOL_MAJOR,
    type: "photo.error",
    timestamp: Date.now(),
    payload: { requestId, reason },
  });
  logger.warn({ mentraUserId: pending.mentraUserId, requestId, reason }, "managed photo failed");
}

/** Read and remove a pending request, so it settles exactly once. */
async function takePending(requestId: string): Promise<PendingPhoto | null> {
  const redis = getRedis();
  const raw = await redis.get(pendingRedisKey(requestId));
  if (!raw) return null;
  await redis.del(pendingRedisKey(requestId));
  try {
    return JSON.parse(raw) as PendingPhoto;
  } catch {
    return null;
  }
}

/**
 * Provision a managed stream. Stub coordinates for now; a real Cloudflare Stream
 * provider lands later. Fully answered by this response (no push).
 */
export async function startStream(
  mentraUserId: string,
  opts: StreamOptions,
): Promise<ManagedStream> {
  void opts;
  const streamId = `stream_${ulid()}`;
  logger.info({ mentraUserId, streamId }, "managed stream provisioned");
  return {
    streamId,
    ingest: { url: `rtmps://stream.mentra.local/ingest/${streamId}` },
    playback: { url: `https://stream.mentra.local/play/${streamId}.m3u8` },
  };
}

/** Stop a managed stream. */
export async function stopStream(mentraUserId: string, streamId: string): Promise<void> {
  void mentraUserId;
  logger.info({ mentraUserId, streamId }, "managed stream stopped");
}
