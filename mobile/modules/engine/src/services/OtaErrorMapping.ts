import type {OtaProgress, OtaStatus} from "../facades/ota"

/**
 * Copy keys for OTA failures the glasses report by code (`ota_status.error`), plus the
 * phone-side BES restart instruction. Hosts translate these keys; the engine's own
 * English copy for each key lives in `OTA_ERROR_ENGLISH_COPY`.
 *
 * The glasses-side producers are `sendProgressToPhone(..., "FAILED", errorCode)` in the
 * ASG client's OtaHelper (download classification, install failures, and the downgrade
 * handoff to the recovery worker). Keep this table in sync with those codes; anything
 * else falls back to `OTA_ERROR_UNKNOWN_GLASSES_COPY_KEY`. Raw codes remain in private
 * incident evidence rather than the product failure page.
 */
export const OTA_GLASSES_ERROR_COPY_KEYS: Readonly<Record<string, string>> = {
  dns_failed: "ota:errorDnsFailed",
  connection_failed: "ota:errorConnectionFailed",
  connect_timeout: "ota:errorConnectTimeout",
  download_timeout: "ota:errorDownloadTimeout",
  http_error: "ota:errorHttpError",
  downgrade_recovery_disabled: "ota:errorDowngradeRecoveryDisabled",
  downgrade_recovery_incompatible: "ota:errorDowngradeRecoveryIncompatible",
  downgrade_recovery_unavailable: "ota:errorDowngradeRecoveryUnavailable",
  downgrade_recovery_busy: "ota:errorDowngradeRecoveryBusy",
  downgrade_status_unknown: "ota:errorDowngradeStatusUnknown",
  downgrade_not_owned: "ota:errorDowngradeNotOwned",
  no_internet: "ota:errorNoInternet",
  clock_skew: "ota:errorClockSkew",
  ssl_error: "ota:errorSslError",
  download_failed: "ota:errorDownloadFailed",
  insufficient_storage: "ota:errorInsufficientStorage",
  firmware_too_large: "ota:errorFirmwareTooLarge",
  firmware_verify_failed: "ota:errorFirmwareVerifyFailed",
  apk_verify_failed: "ota:errorApkVerifyFailed",
  install_failed: "ota:errorInstallFailed",
  apk_restart_guard_not_persisted: "ota:errorApkRestartGuardNotPersisted",
  downgrade_handoff_refused: "ota:errorDowngradeHandoffRefused",
  downgrade_handoff_failed: "ota:errorDowngradeHandoffFailed",
  downgrade_transaction_stalled: "ota:errorDowngradeTransactionStalled",
}

export const OTA_ERROR_UNKNOWN_GLASSES_COPY_KEY = "ota:errorGlassesUnknown"
export const OTA_ERROR_GENERIC_COPY_KEY = "ota:errorGeneric"
export const OTA_ERROR_BES_RESTART_REQUIRED_COPY_KEY = "ota:errorBesRestartRequired"

const PHONE_ARTIFACT_COPY_KEYS: Readonly<Record<string, string>> = {
  internet: "ota:errorPhoneInternet",
  connection: "ota:errorPhoneConnection",
  server: "ota:errorPhoneDownloadServer",
  timeout: "ota:errorPhoneDownloadTimeout",
  storage: "ota:errorPhoneStorage",
  save: "ota:errorPhoneSave",
  secure_connection: "ota:errorPhoneSecureConnection",
  download: "ota:errorPhoneDownload",
  verify: "ota:errorPhoneVerify",
}

/** A known failed stage is useful; it is not evidence of an internet outage. */
export function phoneOtaErrorCopyKey(error: unknown): string {
  if (typeof error !== "object" || error === null) return OTA_ERROR_GENERIC_COPY_KEY
  const detail = error as {code?: unknown; failure?: {category?: unknown}}
  switch (detail.code) {
    case "artifact_download_failed":
    case "artifact_verify_failed": {
      const category = detail.failure?.category
      if (typeof category === "string" && hasOwn(PHONE_ARTIFACT_COPY_KEYS, category))
        return PHONE_ARTIFACT_COPY_KEYS[category]
      return detail.code === "artifact_verify_failed" ? "ota:errorPhoneVerify" : "ota:errorPhoneDownload"
    }
    case "manifest_invalid":
      return "ota:errorPhoneVerify"
    case "hotspot_wifi_permission_denied":
      return "ota:errorPhoneNearbyPermission"
    case "hotspot_start_failed":
      return "ota:errorGlassesHotspotStart"
    case "hotspot_join_failed":
      return "ota:errorPhoneHotspotJoin"
    case "hotspot_server_failed":
      return "ota:errorPhoneShareUpdate"
    default:
      return OTA_ERROR_GENERIC_COPY_KEY
  }
}

/** English copy for every OTA error key above. Mirrored in the Mentra App's `ota` i18n namespace. */
export const OTA_ERROR_ENGLISH_COPY: Readonly<Record<string, string>> = {
  "ota:errorDnsFailed": "Could not find the update server — retry, or check glasses Wi-Fi if this continues",
  "ota:errorConnectionFailed": "Could not connect to the update server — please retry",
  "ota:errorConnectTimeout": "The update server took too long to connect — please retry",
  "ota:errorDownloadTimeout": "The update stopped responding — please retry",
  "ota:errorHttpError": "The update server returned an error — retry later or contact support",
  "ota:errorDowngradeRecoveryDisabled":
    "The recovery service is disabled. Contact support to restore it before changing versions.",
  "ota:errorDowngradeRecoveryIncompatible":
    "The recovery service is incompatible. Contact support to restore it before changing versions.",
  "ota:errorDowngradeRecoveryUnavailable":
    "The recovery service is not ready. Wait a moment and retry; contact support if this continues.",
  "ota:errorDowngradeRecoveryBusy":
    "Another glasses recovery is still running. Keep your glasses nearby and retry after it finishes.",
  "ota:errorDowngradeStatusUnknown":
    "Still checking the version change on your glasses. Keep them nearby. Contact support if this continues.",
  "ota:errorDowngradeNotOwned": "The version change did not finish. Recovery has stopped; you can safely retry.",
  "ota:errorNoInternet": "Glasses Wi-Fi has no internet connection",
  "ota:errorClockSkew": "Glasses clock is wrong — syncing time from your phone, then retrying update check",
  "ota:errorSslError": "Secure connection failed — try a different Wi-Fi network",
  "ota:errorDownloadFailed": "The update could not be downloaded to your glasses. Please try again.",
  "ota:errorInsufficientStorage": "Not enough storage on your glasses — free up space before trying again",
  "ota:errorFirmwareTooLarge": "Firmware file is unexpectedly large — please contact support",
  "ota:errorFirmwareVerifyFailed": "Firmware verification failed — please try again or contact support",
  "ota:errorApkVerifyFailed": "Update verification failed — please try again or contact support",
  "ota:errorInstallFailed": "The update could not be installed on your glasses. Please try again.",
  "ota:errorApkRestartGuardNotPersisted":
    "Your glasses could not save the update before restarting. Restart your glasses and try again.",
  "ota:errorDowngradeHandoffRefused":
    "Your glasses could not start the version change. Restart your glasses and try again.",
  "ota:errorDowngradeHandoffFailed":
    "The recovery service on your glasses did not respond. Restart your glasses and try again.",
  "ota:errorDowngradeTransactionStalled":
    "The version change on your glasses did not finish. Restart your glasses and try again.",
  "ota:errorGlassesUnknown": "Something went wrong. Please try again.",
  "ota:errorGeneric": "Something went wrong. Please try again.",
  "ota:errorPhoneInternet": "Your phone could not connect to the internet. Check its connection and try again.",
  "ota:errorPhoneConnection": "Your phone could not reach the update server. Check its connection and try again.",
  "ota:errorPhoneDownloadServer": "The update server could not provide the download. Please try again later.",
  "ota:errorPhoneDownloadTimeout": "The update download took too long. Please try again.",
  "ota:errorPhoneStorage": "There is not enough space on your phone for the update. Free up space and try again.",
  "ota:errorPhoneSave": "Your phone could not save the update. Please try again.",
  "ota:errorPhoneSecureConnection":
    "Your phone could not make a secure connection to the update server. Please try again later.",
  "ota:errorPhoneDownload": "The update could not be downloaded to your phone. Please try again.",
  "ota:errorPhoneVerify": "The update file could not be verified. Please try again later.",
  "ota:errorPhoneNearbyPermission": "Allow nearby devices access so your phone can connect to your glasses.",
  "ota:errorGlassesHotspotStart":
    "Your glasses could not start the connection needed for the update. Please try again.",
  "ota:errorPhoneHotspotJoin": "Your phone could not connect to your glasses for the update. Please try again.",
  "ota:errorPhoneShareUpdate": "Your phone could not send the update to your glasses. Please try again.",
  "ota:errorBesRestartRequired": "Restart your glasses to safely exit firmware update mode before trying again",
  "ota:errorCode": "Error code: {{code}}",
}

export const BES_INSTALL_RESTART_MESSAGE = OTA_ERROR_ENGLISH_COPY[OTA_ERROR_BES_RESTART_REQUIRED_COPY_KEY]

/**
 * Copy key for a glasses-reported failure code. Unknown codes get the generic
 * glasses-error copy; a missing code gets the plain generic copy.
 */
export function otaErrorCopyKey(error?: string | null): string {
  if (!error) return OTA_ERROR_GENERIC_COPY_KEY
  // Own-property lookup: a code that happens to name an inherited Object member
  // ("constructor", "toString", ...) is unknown, not a mapped key.
  return hasOwn(OTA_GLASSES_ERROR_COPY_KEYS, error)
    ? OTA_GLASSES_ERROR_COPY_KEYS[error]
    : OTA_ERROR_UNKNOWN_GLASSES_COPY_KEY
}

function hasOwn(table: Readonly<Record<string, string>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key)
}

function isDownloadPhaseSnapshot(
  otaStatus: OtaStatus | null | undefined,
  otaProgress: OtaProgress | null | undefined,
): boolean {
  if (otaStatus?.phase === "download") {
    return true
  }
  if (otaProgress?.stage === "download") {
    return true
  }
  return false
}

/**
 * Offer Change WiFi whenever the OTA flow failed while the glasses were in the
 * download step (any download failure — network, SSL, size cap, verify, etc.).
 *
 * Also covers phone-side watchdog failures that fire while the store still shows
 * an active download phase (stall / global timeout mid-download).
 */
export function shouldShowChangeWifiForOtaDownloadFailure(
  otaStatus: OtaStatus | null | undefined,
  otaProgress: OtaProgress | null | undefined,
  localErrorMessage: string,
): boolean {
  if (otaStatus?.error === "insufficient_storage" || otaProgress?.errorMessage === "insufficient_storage") {
    return false
  }
  if (otaStatus?.status === "failed" && otaStatus.phase === "download") {
    return true
  }
  if (otaProgress?.status === "FAILED" && otaProgress.stage === "download") {
    return true
  }
  if (localErrorMessage && isDownloadPhaseSnapshot(otaStatus, otaProgress)) {
    return true
  }
  return false
}

/** English message for a glasses-reported failure code. Never echoes the raw code. */
export function getOtaErrorMessage(error?: string | null): string {
  return OTA_ERROR_ENGLISH_COPY[otaErrorCopyKey(error)]
}

/**
 * Once a BES install has started, any failure conservatively requires a glasses restart. This
 * avoids adding a BES-specific error code to the wire protocol and, more importantly, never offers
 * an unsafe retry when a generic failure or silence may mean BES entered its raw OTA parser.
 */
export function shouldRequireGlassesRebootForBesFailure(
  otaStatus: OtaStatus | null | undefined,
  _otaProgress: OtaProgress | null | undefined,
  localErrorMessage: string,
): boolean {
  if (otaStatus?.stepType !== "bes" || otaStatus.phase !== "install") {
    return false
  }
  return otaStatus.status === "failed" || Boolean(localErrorMessage)
}
