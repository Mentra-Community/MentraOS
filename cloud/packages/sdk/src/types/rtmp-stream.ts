// src/types/rtmp-stream.ts

import type { StreamStatus } from "./messages/glasses-to-cloud";

/**
 * RTMP Streaming Types
 *
 * This file contains the interfaces and types for RTMP streaming functionality.
 *
 * RTMP status updates are received through the standard stream subscription mechanism:
 *
 * ```typescript
 * // Subscribe to status updates
 * session.subscribe(StreamType.RTMP_STATUS);
 *
 * // Listen for updates
 * session.on(StreamType.RTMP_STATUS, (status) => {
 *   console.log('RTMP Status:', status);
 * });
 * ```
 *
 * Alternatively, use the CameraModule's convenience methods:
 *
 * ```typescript
 * // This does both subscription and event listening in one call
 * const cleanup = session.camera.onLocalLivestreamStatus((status) => {
 *   console.log('Stream status:', status);
 * });
 *
 * // When done:
 * cleanup();
 * ```
 */

/**
 * Glasses-side clamp ranges for {@link VideoConfig}. Mirrors
 * `com.mentra.asg_client.io.streaming.config.RtmpStreamConfig` and
 * `WhipStreamConfig` when parsing JSON from the SDK.
 */
export const VIDEO_CONFIG_LIMITS = {
  width: {min: 320, max: 1920, default: 854},
  height: {min: 240, max: 1080, default: 480},
  frameRate: {min: 10, max: 60, default: 15},
  bitrate: {min: 100_000, max: 10_000_000, default: 1_000_000},
} as const;

type VideoConfigNumericKey = keyof typeof VIDEO_CONFIG_LIMITS;

function assertVideoNumericField(key: VideoConfigNumericKey, value: number): void {
  const spec = VIDEO_CONFIG_LIMITS[key];
  if (!Number.isFinite(value)) {
    throw new RangeError(`video.${key} must be a finite number (got ${value})`);
  }
  if (!Number.isInteger(value)) {
    throw new RangeError(`video.${key} must be an integer (got ${value})`);
  }
  if (value < spec.min || value > spec.max) {
    throw new RangeError(
      `video.${key} must be between ${spec.min} and ${spec.max} (got ${value})`,
    );
  }
}

/**
 * Validates optional {@link VideoConfig} before sending a stream request to the cloud.
 * Omitted fields are left to glasses defaults. Any supplied field must be an integer
 * within {@link VIDEO_CONFIG_LIMITS} or this throws {@link RangeError}.
 *
 * On the device, values outside these ranges are clamped; the SDK rejects them early
 * so apps see a clear error. The glasses still pick a native camera mode and may
 * center-crop / downscale to the requested aspect; resolutions that would require
 * upscaling are rejected during stream start (preflight).
 */
export function validateVideoConfig(video?: VideoConfig): void {
  if (video == null) {
    return;
  }
  if (video.width !== undefined) {
    assertVideoNumericField("width", video.width);
  }
  if (video.height !== undefined) {
    assertVideoNumericField("height", video.height);
  }
  if (video.frameRate !== undefined) {
    assertVideoNumericField("frameRate", video.frameRate);
  }
  if (video.bitrate !== undefined) {
    assertVideoNumericField("bitrate", video.bitrate);
  }
}

/**
 * Video configuration options for RTMP / SRT / WHIP streaming.
 *
 * All numeric fields are optional; when omitted, glasses use defaults
 * ({@link VIDEO_CONFIG_LIMITS} `default` per field). When set, each value must
 * fall within the corresponding `min`/`max` or {@link validateVideoConfig} throws.
 *
 * The glasses select a native capture size and may center-crop / downscale to match
 * the requested output without upscaling. If the camera cannot satisfy the request
 * without upscale, stream start fails on the device.
 */
export interface VideoConfig {
  /** Width in pixels; default 854; allowed 320–1920 */
  width?: number;
  /** Height in pixels; default 480; allowed 240–1080 */
  height?: number;
  /** Bitrate in bits per second; default 1_000_000; allowed 100_000–10_000_000 */
  bitrate?: number;
  /** Frame rate in fps; default 15; allowed 10–60 */
  frameRate?: number;
}

/**
 * Audio configuration options for RTMP streaming
 */
export interface AudioConfig {
  /** Optional audio bitrate in bits per second (e.g., 128000 for 128 kbps) */
  bitrate?: number;
  /** Optional audio sample rate in Hz (e.g., 44100) */
  sampleRate?: number;
  /** Optional flag to enable echo cancellation */
  echoCancellation?: boolean;
  /** Optional flag to enable noise suppression */
  noiseSuppression?: boolean;
}

/**
 * Stream configuration options for RTMP streaming
 */
export interface StreamConfig {
  /** Optional maximum duration in seconds (e.g., 1800 for 30 minutes) */
  durationLimit?: number;
}

/**
 * Type for stream status event handler
 */
export type StreamStatusHandler = (status: StreamStatus) => void;
