const END_SEEK_INSET_SECONDS = 0.1
const END_POSITION_TOLERANCE_SECONDS = 0.05
const SEEK_POSITION_TOLERANCE_SECONDS = 0.01

// Accommodate native float/millisecond rounding without accepting the endpoint
// for a seek clamped 100 ms inside the asset.
export function isVideoAtSeekTarget(position: number, target: number): boolean {
  return Number.isFinite(position) && Math.abs(position - target) <= SEEK_POSITION_TOLERANCE_SECONDS
}

export function getVideoSeekTime(requestedTime: number, duration: number): number {
  if (!Number.isFinite(requestedTime) || !Number.isFinite(duration) || duration <= 0) {
    return 0
  }

  return Math.max(0, Math.min(requestedTime, duration - END_SEEK_INSET_SECONDS))
}

export function isVideoAtEnd(currentTime: number, duration: number): boolean {
  return (
    Number.isFinite(currentTime) &&
    Number.isFinite(duration) &&
    duration > 0 &&
    currentTime >= duration - Math.min(END_POSITION_TOLERANCE_SECONDS, duration / 2)
  )
}
