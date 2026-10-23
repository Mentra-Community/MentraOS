export type PhotoSize = "low" | "medium" | "high" | "max"
export type PhotoMode = "photo" | "text"

export const DEFAULT_WARMUP_DURATION_MS = 15_000

export const CANONICAL_PHOTO_SIZES = ["low", "medium", "high", "max"] as const satisfies readonly PhotoSize[]

export interface PhotoTakenResult {
  requestId?: string
  photoUrl?: string
  mimeType?: string
  size?: number
}

export interface TakePhotoConfig {
  size: PhotoSize
  mode: PhotoMode
  /** ZSL preview buffering. Always sent as an explicit boolean. */
  zsl: boolean
  /** MFNR still capture. Always sent as an explicit boolean. */
  mfnr: boolean
}

/**
 * Wire size for the request. Text mode ignores the public quality tier — ASG owns sensor
 * resolution via TEXT_MODE_SENSOR_CAPTURE_* constants — but the BLE schema still requires a size.
 */
export function wirePhotoSize(size: PhotoSize, mode: PhotoMode): PhotoSize {
  return mode === "text" ? "medium" : size
}

export function buildTakePhotoArgs(config: TakePhotoConfig) {
  const options: Record<string, unknown> = {
    size: wirePhotoSize(config.size, config.mode),
    mode: config.mode,
    zsl: config.zsl,
    mfnr: config.mfnr,
  }
  return [options] as const
}

export function buildWarmUpArgs(
  size: PhotoSize,
  mode: PhotoMode,
  durationMs = DEFAULT_WARMUP_DURATION_MS,
) {
  return [{size: wirePhotoSize(size, mode), mode, durationMs}] as const
}

export function formatElapsedMs(elapsedMs: number | undefined): string {
  if (elapsedMs == null || !Number.isFinite(elapsedMs)) return "—"
  return `${Math.round(elapsedMs)} ms`
}

export function formatByteSize(size: number | undefined): string {
  if (size == null || size < 0) return "unknown"
  if (size < 1024) return `${size} B`
  return `${(size / 1024).toFixed(1)} KB`
}
