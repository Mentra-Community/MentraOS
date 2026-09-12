import type {OtaProgress, OtaStatus} from "../facades/ota"

/**
 * Copy keys for OTA failures the glasses report by code (`ota_status.error`), plus the
 * phone-side BES restart instruction. Hosts translate these keys; the engine's own
 * English copy for each key lives in `OTA_ERROR_ENGLISH_COPY`.
 *
 * The glasses-side producers are `sendProgressToPhone(..., "FAILED", errorCode)` in the
 * ASG client's OtaHelper (download classification, install failures, and the downgrade
 * handoff to the recovery worker). Keep this table in sync with those codes; anything
 * else falls back to `OTA_ERROR_UNKNOWN_GLASSES_COPY_KEY` and the raw code is shown in a
 * secondary line so support can still identify it.
 */
export const OTA_GLASSES_ERROR_COPY_KEYS: Readonly<Record<string, string>> = {
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

/** English copy for every OTA error key above. Mirrored in the Mentra App's `ota` i18n namespace. */
export const OTA_ERROR_ENGLISH_COPY: Readonly<Record<string, string>> = {
  "ota:errorNoInternet": "Glasses WiFi has no internet connection",
  "ota:errorClockSkew": "Glasses clock is wrong — syncing time from your phone, then retrying update check",
  "ota:errorSslError": "Secure connection failed — try a different WiFi network",
  "ota:errorDownloadFailed": "Download failed — check glasses WiFi connection",
  "ota:errorInsufficientStorage": "Not enough storage on your glasses — free up space before trying again",
  "ota:errorFirmwareTooLarge": "Firmware file is unexpectedly large — please contact support",
  "ota:errorFirmwareVerifyFailed": "Firmware verification failed — please try again or contact support",
  "ota:errorApkVerifyFailed": "Update verification failed — please try again or contact support",
  "ota:errorInstallFailed": "Install failed — please try again",
  "ota:errorApkRestartGuardNotPersisted":
    "Your glasses could not save the update before restarting. Restart your glasses and try again.",
  "ota:errorDowngradeHandoffRefused":
    "Your glasses could not start the version change. Restart your glasses and try again.",
  "ota:errorDowngradeHandoffFailed":
    "The recovery service on your glasses did not respond. Restart your glasses and try again.",
  "ota:errorDowngradeTransactionStalled":
    "The version change on your glasses did not finish. Restart your glasses and try again.",
  "ota:errorGlassesUnknown": "Your glasses reported an unexpected error. Restart your glasses and try again.",
  "ota:errorGeneric": "Update failed",
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
