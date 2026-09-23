const END_SEEK_INSET_SECONDS = 0.1

export function getVideoSeekTime(requestedTime: number, duration: number): number {
  if (!Number.isFinite(requestedTime) || !Number.isFinite(duration) || duration <= 0) {
    return 0
  }

  return Math.max(0, Math.min(requestedTime, duration - END_SEEK_INSET_SECONDS))
}
