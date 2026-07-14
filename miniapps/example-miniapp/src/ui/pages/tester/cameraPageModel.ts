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
}

export function buildTakePhotoArgs(config: TakePhotoConfig) {
  const options: Record<string, unknown> = {
    size: config.size,
    mode: config.mode,
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
