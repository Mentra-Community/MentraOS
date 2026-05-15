import type {OtaProgress, OtaStatus} from "@mentra/bluetooth-sdk"

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

export function getOtaErrorMessage(error?: string): string {
  switch (error) {
    case "no_internet":
      return "Glasses WiFi has no internet connection"
    case "ssl_error":
      return "Secure connection failed — try a different WiFi network"
    case "download_failed":
      return "Download failed — check glasses WiFi connection"
    case "firmware_too_large":
      return "Firmware file is unexpectedly large — please contact support"
    case "firmware_verify_failed":
      return "Firmware verification failed — please try again or contact support"
    case "install_failed":
      return "Install failed — please try again"
    default:
      return error || "Update failed"
  }
}
