import type {FirmwareCopy} from "../../ota/types"

/** English fallback for SDK hosts; the Mentra App supplies its normal translator. */
export const NIMO_OTA_ENGLISH_COPY = {
  title: "NIMO firmware",
  reopen: "Reopen this flow to check the current glasses.",
  checking: "Checking NIMO firmware",
  keepConnected: "Keep your glasses connected.",
  available: "NIMO update available",
  chargedNearby: "Keep both sides charged and nearby during the update.",
  ready: "NIMO is ready",
  compatibleOffline: "Your installed firmware is compatible. New update information is currently unavailable.",
  compatible: "Your installed firmware is compatible.",
  attention: "NIMO firmware needs attention",
  checkUnavailable: "Could not check the required firmware. Reconnect to the Internet and try again.",
  unsupportedPath: "This firmware version has no approved upgrade path. Contact support before updating.",
  noSource: "No approved NIMO firmware source is configured for this deployment.",
  downloading: "Downloading NIMO firmware",
  keepAppOpen: "Keep the Mentra App open while preparing the update.",
  preparing: "Preparing NIMO update",
  doNotDisconnect: "Keep both sides nearby. Do not disconnect your glasses.",
  changed: "NIMO firmware changed",
  checkChanged: "Check again before updating these glasses.",
  installing: "Updating NIMO",
  synchronizing: "Updating both sides",
  restarting: "Restarting NIMO",
  verifying: "Verifying NIMO firmware",
  complete: "NIMO update complete",
  failed: "NIMO update failed",
  recovery: "NIMO update needs recovery",
  doNotReset: "Keep both sides charged and nearby. Do not reset your glasses.",
  checkRecovery: "Check recovery",
  install: "Update now",
  checkAgain: "Check again",
  continue: "Continue",
  close: "Close",
  couldNotContinue: "NIMO update could not continue",
} as const

const keys = new Map<string, string>(
  Object.entries(NIMO_OTA_ENGLISH_COPY).map(([key, text]) => [text, `nimoOta:${key}`]),
)
export function nimoFirmwareCopy(text: string): FirmwareCopy {
  return {text, key: keys.get(text)}
}
