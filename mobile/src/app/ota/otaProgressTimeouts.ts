/**
 * Re-export shim — the OTA install policy (watchdog timings + failure copy)
 * moved into @mentra/island (modules/island/src/services/otaInstallPolicy.ts)
 * with the OtaInstallCoordinator (WP 8B). Kept so progress-legacy.tsx /
 * check-for-updates.tsx imports resolve unchanged; deleted with the legacy
 * route in WP 8D.
 */
export {
  MINIMUM_OTA_STATUS_BUILD,
  MAX_RETRIES,
  RETRY_INTERVAL_MS,
  PROGRESS_TIMEOUT_MS,
  DOWNLOAD_STUCK_TIMEOUT_MS,
  MTK_INSTALL_TIMEOUT_MS,
  GLOBAL_OTA_TIMEOUT_MS,
  POST_APK_OTA_START_DELAY_MS,
  PING_INTERVAL_MS,
  QUERY_REPLY_TIMEOUT_MS,
  OtaProgressMessages,
} from "@mentra/island"
