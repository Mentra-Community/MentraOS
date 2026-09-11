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
 * The device (glasses) does the actual capture + upload to the presigned URL.
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
import {
  provisionStream,
  stopStream as stopManagedStream,
  streamStatus as getManagedStreamStatus,
} from "../stream/stream.service";
import { forwardToUserSessions } from "../../net/ws";
import { PROTOCOL_MAJOR } from "@mentra/cloud-protocol/envelope";
import type {
  PhotoOptions,
  StreamOptions,
  ManagedStream,
  StreamStatusResult,
} from "@mentra/cloud-protocol/camera";

const logger = createLogger("audio").child({ service: "camera.service" });

const PHOTO_CONTENT_TYPE = "image/jpeg";
/** Pending photo requests TTL: long enough for an upload, then abandoned. */
const PHOTO_REQUEST_TTL_SEC = 300;

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
 * Create a managed-photo request: presign the upload + read URLs and record the
 * pending request. Returns the URLs the device uses; the caller gets
 * `photo.ready` over its WS on completion.
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

  // The device (glasses) uploads the captured image to `uploadUrl` out of band.
  // Completion arrives via the local upload handler (local provider) or the
  // storage-events webhook (r2/s3); both call `completeUpload`.
  return { requestId, uploadUrl: upload.url, readUrl };
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
 * Provision a managed stream on the configured stream provider (Cloudflare
 * Stream). Fully answered by this response (no push). Throws if no stream
 * provider is configured, rather than returning fake coordinates.
 */
export async function startStream(
  mentraUserId: string,
  opts: StreamOptions,
): Promise<ManagedStream> {
  const stream = await provisionStream(mentraUserId, opts);
  logger.info({ mentraUserId, streamId: stream.streamId }, "managed stream provisioned");
  return stream;
}

/** The provider's view of a managed stream's ingest (is the push arriving?). */
export async function streamStatus(
  mentraUserId: string,
  streamId: string,
): Promise<StreamStatusResult> {
  void mentraUserId;
  return await getManagedStreamStatus(streamId);
}

/** Stop a managed stream. */
export async function stopStream(mentraUserId: string, streamId: string): Promise<void> {
  await stopManagedStream(streamId);
  logger.info({ mentraUserId, streamId }, "managed stream stopped");
}
