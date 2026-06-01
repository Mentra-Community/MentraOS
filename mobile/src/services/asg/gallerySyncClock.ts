/**
 * Clock skew detection for gallery sync (phone vs glasses).
 * Phone pushes time to glasses only when skew is detected during sync.
 */

export const CLOCK_SKEW_TOLERANCE_MS = 60_000

export type ClockSkewReason = "watermark_ahead_of_glasses" | "wall_clock_drift" | ""

export interface ClockSkewResult {
  skewed: boolean
  reason: ClockSkewReason
}

export function detectClockSkew(
  phoneNow: number,
  glassesServerTime: number,
  lastSyncTime: number,
  toleranceMs: number = CLOCK_SKEW_TOLERANCE_MS,
): ClockSkewResult {
  if (lastSyncTime > glassesServerTime + toleranceMs) {
    return {skewed: true, reason: "watermark_ahead_of_glasses"}
  }
  if (Math.abs(phoneNow - glassesServerTime) > toleranceMs) {
    return {skewed: true, reason: "wall_clock_drift"}
  }
  return {skewed: false, reason: ""}
}

export function isSyncManifestEmpty(syncData: {
  api_version?: number
  captures?: unknown[]
  changed_files?: unknown[]
}): boolean {
  if (syncData.api_version === 2 && syncData.captures && syncData.captures.length > 0) {
    return false
  }
  return !syncData.changed_files || syncData.changed_files.length === 0
}
