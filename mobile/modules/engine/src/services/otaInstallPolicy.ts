/** Shared OTA progress watchdog timings (see progress-legacy.tsx / progress.tsx). */
import type {OtaProgress, OtaStatus} from "@mentra/bluetooth-sdk/internal"

/**
 * First glasses `build_number` (ASG `versionCode`) that uses `progress.tsx` with unified
 * `ota_status` session UI. Strictly lower builds use `/ota/progress-legacy` (routed from
 * `check-for-updates.tsx` before navigation), and get the LEGACY_* padded policy below
 * in the unified OtaInstallCoordinator (WP 8C). Change only here.
 */
export const MINIMUM_OTA_STATUS_BUILD = 37

export const MAX_RETRIES = 3
export const RETRY_INTERVAL_MS = 5000
/** APK/BES and general install when progress events are expected */
export const PROGRESS_TIMEOUT_MS = 120_000
/** Fail if still at 0% in starting/downloading */
export const DOWNLOAD_STUCK_TIMEOUT_MS = 70_000
/** MTK system install often goes quiet for long periods */
export const MTK_INSTALL_TIMEOUT_MS = 300_000
/** Whole multi-step session cap */
export const GLOBAL_OTA_TIMEOUT_MS = 20 * 60 * 1000
/** BLE keepalive during OTA */
export const PING_INTERVAL_MS = 10_000
/**
 * If we sent ota_query_status (e.g. on reconnect) and the glasses haven't
 * replied with an ota_status by then, fall back to ota_start. This recovers
 * from the case where the glasses process restarted between mount and
 * reconnect — the session is gone, ota_query_status returns nothing, and
 * the user would otherwise sit on the spinner forever.
 */
export const QUERY_REPLY_TIMEOUT_MS = 6000
/** 15s lockout on the Continue button after a BES restart, to prevent an accidental tap. */
export const BES_CONTINUE_LOCKOUT_MS = 15_000

// --- Legacy old-build (< MINIMUM_OTA_STATUS_BUILD) OTA policy (WP 8C) ---
//
// Ported verbatim from mobile/src/app/ota/progress-legacy.tsx, which padded EVERY
// watchdog/timer by +20s for old ASG builds ("Legacy OTA: +20s on every watchdog /
// timer duration"). Old builds respond slower on every path, so where the legacy
// screen used a longer duration the coordinator applies the longer value whenever
// the session is legacy-shaped (see isLegacyShapedOtaStatus / the coordinator's
// session-shape check). Builds >= 37 keep the unpadded values above.

/** The uniform pad progress-legacy.tsx added to every duration for old builds. */
export const LEGACY_EXTRA_TIMEOUT_MS = 20_000
export const LEGACY_RETRY_INTERVAL_MS = RETRY_INTERVAL_MS + LEGACY_EXTRA_TIMEOUT_MS
export const LEGACY_PROGRESS_TIMEOUT_MS = PROGRESS_TIMEOUT_MS + LEGACY_EXTRA_TIMEOUT_MS
export const LEGACY_DOWNLOAD_STUCK_TIMEOUT_MS = DOWNLOAD_STUCK_TIMEOUT_MS + LEGACY_EXTRA_TIMEOUT_MS
export const LEGACY_MTK_INSTALL_TIMEOUT_MS = MTK_INSTALL_TIMEOUT_MS + LEGACY_EXTRA_TIMEOUT_MS
export const LEGACY_GLOBAL_OTA_TIMEOUT_MS = GLOBAL_OTA_TIMEOUT_MS + LEGACY_EXTRA_TIMEOUT_MS
export const LEGACY_PING_INTERVAL_MS = PING_INTERVAL_MS + LEGACY_EXTRA_TIMEOUT_MS
export const LEGACY_BES_CONTINUE_LOCKOUT_MS = BES_CONTINUE_LOCKOUT_MS + LEGACY_EXTRA_TIMEOUT_MS
/**
 * After a legacy apk `install FINISHED` observed in-flight, the legacy screen held the
 * completed state for 12s (+20s pad) so the ASG process restart settles (and fresh
 * version_info lands) before the user can continue.
 */
export const LEGACY_APK_COMPLETION_SETTLE_MS = 12_000 + LEGACY_EXTRA_TIMEOUT_MS
/**
 * Legacy MTK install stall simulation (display-only): the MTK system install typically
 * stalls around 49-50%. After LEGACY_MTK_STALL_DETECT_MS without a new event in the
 * [45, 55) zone, the legacy screen simulated +1% every LEGACY_MTK_SIM_TICK_MS starting
 * at max(stall+1, 51) and capped at 60%, purely to keep the user informed.
 */
export const LEGACY_MTK_STALL_DETECT_MS = 20_000 + LEGACY_EXTRA_TIMEOUT_MS
export const LEGACY_MTK_SIM_TICK_MS = 15_000 + LEGACY_EXTRA_TIMEOUT_MS
export const LEGACY_MTK_STALL_ZONE_MIN_PERCENT = 45
export const LEGACY_MTK_STALL_ZONE_MAX_PERCENT = 55
export const LEGACY_MTK_SIM_FLOOR_PERCENT = 51
export const LEGACY_MTK_SIM_CAP_PERCENT = 60

export type OtaProtocolProfile = "legacy" | "unified"

/**
 * Legacy-shaped ota_status: old (< 37) ASG builds send `ota_progress`, which the SDK
 * (Android MentraLive.kt / iOS MentraLive.swift) maps to a unified ota_status with
 * sessionId "" and totalSteps 1, and FINISHED→"complete" regardless of phase. A real
 * (>= 37) session always carries a sessionId; an "idle" reply also has sessionId "" but
 * proves the glasses speak the unified protocol, so it is NOT legacy-shaped.
 */
export function isLegacyShapedOtaStatus(otaStatus: OtaStatus | null): boolean {
  return !!otaStatus && otaStatus.sessionId === "" && otaStatus.status !== "idle"
}

/**
 * Is the current install session legacy-shaped? Event shape wins when events exist
 * (per the WP 8C rule: key off legacy-shaped inputs, not a build flag, where possible);
 * before any event arrives only the glasses build number can tell.
 */
export function isLegacyShapedOtaSession(
  otaStatus: OtaStatus | null,
  otaProgress: OtaProgress | null,
  buildNumber: string | null | undefined,
): boolean {
  if (otaStatus) return isLegacyShapedOtaStatus(otaStatus)
  if (otaProgress) return true
  const build = Number.parseInt(buildNumber ?? "", 10)
  return Number.isFinite(build) && build > 0 && build < MINIMUM_OTA_STATUS_BUILD
}

/**
 * Select the compatibility profile once at install-screen attach. The old split
 * routes made this decision from the pre-update build and kept it for the whole
 * mounted flow, even when an APK step restarted into a newer ASG build. Returning
 * null leaves the coordinator undecided until the first meaningful OTA event.
 */
export function selectOtaProtocolProfile(
  otaStatus: OtaStatus | null,
  otaProgress: OtaProgress | null,
  buildNumber: string | null | undefined,
): OtaProtocolProfile | null {
  const build = Number.parseInt(buildNumber ?? "", 10)
  if (Number.isFinite(build) && build > 0) {
    return build < MINIMUM_OTA_STATUS_BUILD ? "legacy" : "unified"
  }
  if (otaStatus) return isLegacyShapedOtaStatus(otaStatus) ? "legacy" : "unified"
  if (otaProgress) return "legacy"
  return null
}

export const OtaProgressMessages = {
  noAckResponse: "Unable to start update. Glasses did not respond.",
  stalledOrStuck: "Update may have failed. Ensure glasses have internet access and try again.",
  globalTimeout: "Update took too long. Please try again.",
  sendOtaStartFailed: "Failed to communicate with glasses.",
} as const
