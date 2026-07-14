export type PhotoSize = "low" | "medium" | "high" | "max"
export type PhotoMode = "photo" | "text"
export type PhotoCompress = "none" | "low" | "medium" | "high"

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
  compress: PhotoCompress
  sound: boolean
  saveToGallery: boolean
  exposureTimeNs?: number
}

export interface CaptureHistoryEntry {
  id: string
  label: string
  startedAt: number
  elapsedMs: number
  options: TakePhotoConfig
  result?: PhotoTakenResult
  error?: string
}

export function buildTakePhotoArgs(config: TakePhotoConfig) {
  const options: Record<string, unknown> = {
    size: config.size,
    mode: config.mode,
    compress: config.compress,
    sound: config.sound,
    saveToGallery: config.saveToGallery,
  }
  if (config.exposureTimeNs != null && Number.isFinite(config.exposureTimeNs) && config.exposureTimeNs > 0) {
    options.exposureTimeNs = config.exposureTimeNs
  }
  return [options] as const
}

export function buildWarmUpArgs(size: PhotoSize, durationMs = DEFAULT_WARMUP_DURATION_MS) {
  return [{size, durationMs}] as const
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

export function createCaptureHistoryEntry(
  label: string,
  options: TakePhotoConfig,
  startedAt: number,
  elapsedMs: number,
  result?: PhotoTakenResult,
  error?: string,
): CaptureHistoryEntry {
  return {
    id: `${startedAt}-${label}`,
    label,
    startedAt,
    elapsedMs,
    options,
    result,
    error,
  }
}
