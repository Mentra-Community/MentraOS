/** Shared OTA progress watchdog timings (see progress-legacy.tsx / progress.tsx). */

/**
 * First glasses `build_number` (ASG `versionCode`) that uses `progress.tsx` with unified
 * `ota_status` session UI. Strictly lower builds redirect to `/ota/progress-legacy`.
 * Change only here.
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
/** After APK reboot, ASG OTA service needs time before next ota_start */
export const POST_APK_OTA_START_DELAY_MS = 6000
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

export const OtaProgressMessages = {
  noAckResponse: "Unable to start update. Glasses did not respond.",
  stalledOrStuck: "Update may have failed. Ensure glasses have internet access and try again.",
  globalTimeout: "Update took too long. Please try again.",
  sendOtaStartFailed: "Failed to communicate with glasses.",
} as const
