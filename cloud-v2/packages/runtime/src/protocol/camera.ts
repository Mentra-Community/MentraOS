/**
 * @fileoverview Canonical camera wire types: managed photo + managed stream.
 *
 * zod schemas + inferred TS types for the camera service. The request/result
 * shapes ride REST; `photo.ready` / `photo.error` are WebSocket push events
 * registered into the message union (messages.ts). Pure + isomorphic: no server
 * imports, safe to bundle into the client.
 *
 * Mirrors docs/issues/002-cloud-runtime/camera/spec.md.
 */
import { z } from "zod";

// --- Managed photo ----------------------------------------------------------

/** Device-canonical photo size tier (matches miniapp SDK and ASG). */
export const photoSizeCanonicalSchema = z.enum(["low", "medium", "high", "max"]);
export type PhotoSizeTier = z.infer<typeof photoSizeCanonicalSchema>;

/** Accepted on the wire: canonical names plus legacy cloud aliases. */
const photoSizeInputSchema = z.enum([
  "low",
  "medium",
  "high",
  "max",
  "small",
  "large",
  "full",
]);

/**
 * Normalize a photo size string to the device-canonical tier.
 * Legacy aliases: small→low, large→high, full→max.
 */
export function normalizePhotoSizeTier(value: string): PhotoSizeTier {
  switch (value) {
    case "small":
      return "low";
    case "large":
      return "high";
    case "full":
      return "max";
    case "low":
    case "medium":
    case "high":
    case "max":
      return value;
    default:
      throw new Error(`invalid photo size: ${value}`);
  }
}

const photoCompressInputSchema = z.enum(["none", "low", "medium", "high", "heavy"]);

/** Normalize compression aliases to the cloud wire enum. */
export function normalizePhotoCompress(
  value: string,
): "none" | "medium" | "heavy" {
  switch (value) {
    case "low":
    case "medium":
      return "medium";
    case "high":
    case "heavy":
      return "heavy";
    case "none":
      return "none";
    default:
      throw new Error(`invalid photo compress: ${value}`);
  }
}

export const photoOptionsSchema = z.object({
  size: photoSizeInputSchema
    .optional()
    .transform((value) => (value === undefined ? undefined : normalizePhotoSizeTier(value))),
  compress: photoCompressInputSchema
    .optional()
    .transform((value) => (value === undefined ? undefined : normalizePhotoCompress(value))),
  saveToGallery: z.boolean().optional(),
  sound: z.boolean().optional(),
});
export type PhotoOptions = z.infer<typeof photoOptionsSchema>;

/**
 * The REST response to a photo request. The capture happens out of band (the
 * glasses upload to `uploadUrl`); `readUrl` is the presigned URL the finished
 * photo will be readable at, returned up front so the client has it before the
 * `photo.ready` push confirms the upload landed.
 */
export const photoRequestResultSchema = z.object({
  requestId: z.string(),
  uploadUrl: z.string(),
  readUrl: z.string(),
});
export type PhotoRequestResult = z.infer<typeof photoRequestResultSchema>;

/** `photo.ready` push payload: the capture+upload completed. */
export const photoReadyPayloadSchema = z.object({
  requestId: z.string(),
  readUrl: z.string(),
});
export type PhotoReady = z.infer<typeof photoReadyPayloadSchema>;

/** `photo.error` push payload: the capture+upload failed. */
export const photoErrorPayloadSchema = z.object({
  requestId: z.string(),
  reason: z.string(),
});
export type PhotoError = z.infer<typeof photoErrorPayloadSchema>;

// --- Managed stream ---------------------------------------------------------

/** A restream destination: re-publish the ingest to an external RTMP target. */
export const restreamDestinationSchema = z.union([
  z.string(),
  z.object({ url: z.string(), name: z.string().optional() }),
]);
export type RestreamDestination = z.infer<typeof restreamDestinationSchema>;

export const streamOptionsSchema = z.object({
  /** Region hint so the cloud provisions a nearby ingest endpoint. */
  region: z.string().optional(),
  /** External RTMP targets the provider re-publishes the ingest to. */
  restreamDestinations: z.array(restreamDestinationSchema).optional(),
});
export type StreamOptions = z.infer<typeof streamOptionsSchema>;

/**
 * A provisioned stream. `ingest` is where the device pushes frames; `playback`
 * is where viewers watch. Both are left as open records because the provider
 * (Cloudflare Stream by default) is swappable per region and its exact field
 * shapes are not finalized. The Cloudflare provider populates ingest
 * `{protocol, url, streamKey, rtmpUrl, srtUrl?, webrtcPublishUrl?}` (the last
 * three ready-to-publish with credentials embedded) and playback
 * `{hls, dash, webrtc?}`.
 */
export const managedStreamSchema = z.object({
  streamId: z.string(),
  ingest: z.record(z.unknown()),
  playback: z.record(z.unknown()),
});
export type ManagedStream = z.infer<typeof managedStreamSchema>;

/**
 * `GET /api/camera/stream/:id` result: the provider's view of the ingest.
 * `isConnected` is the portable signal (is the device's push arriving?);
 * the rest is provider detail for debugging.
 */
export const streamStatusResultSchema = z.object({
  streamId: z.string(),
  isConnected: z.boolean(),
  state: z.string().nullable(),
  connectedAt: z.string().optional(),
  lastSeenAt: z.string().optional(),
  reason: z.string().optional(),
});
export type StreamStatusResult = z.infer<typeof streamStatusResultSchema>;
