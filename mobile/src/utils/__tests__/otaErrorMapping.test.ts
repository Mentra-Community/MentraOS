import {readFileSync} from "fs"
import {resolve} from "path"

import type {OtaProgress, OtaStatus} from "@mentra/bluetooth-sdk-internal"

import {
  BES_INSTALL_RESTART_MESSAGE,
  OTA_ERROR_ENGLISH_COPY,
  OTA_ERROR_UNKNOWN_GLASSES_COPY_KEY,
  OTA_GLASSES_ERROR_COPY_KEYS,
  getOtaErrorMessage,
  otaErrorCopyKey,
  shouldRequireGlassesRebootForBesFailure,
  shouldShowChangeWifiForOtaDownloadFailure,
} from "@/utils/otaErrorMapping"

function baseOtaStatus(overrides: Partial<OtaStatus> = {}): OtaStatus {
  return {
    sessionId: "sid",
    totalSteps: 1,
    currentStep: 1,
    stepType: "apk",
    phase: "download",
    stepPercent: 0,
    overallPercent: 0,
    status: "failed",
    ...overrides,
  }
}

function baseOtaProgress(overrides: Partial<OtaProgress> = {}): OtaProgress {
  return {
    stage: "download",
    status: "FAILED",
    progress: 0,
    bytesDownloaded: 0,
    totalBytes: 0,
    currentUpdate: "apk",
    ...overrides,
  }
}

describe("getOtaErrorMessage", () => {
  it("reports insufficient storage without suggesting a WiFi change", () => {
    expect(getOtaErrorMessage("insufficient_storage")).toContain("free up space")
    expect(shouldShowChangeWifiForOtaDownloadFailure(baseOtaStatus({error: "insufficient_storage"}), null, "")).toBe(
      false,
    )
  })
  it("maps no_internet to WiFi message", () => {
    expect(getOtaErrorMessage("no_internet")).toBe("Glasses WiFi has no internet connection")
  })

  it("maps clock_skew to time-sync message", () => {
    expect(getOtaErrorMessage("clock_skew")).toBe(
      "Glasses clock is wrong — syncing time from your phone, then retrying update check",
    )
  })

  it("maps ssl_error to connection message", () => {
    expect(getOtaErrorMessage("ssl_error")).toBe("Secure connection failed — try a different WiFi network")
  })

  it("maps download_failed to download message", () => {
    expect(getOtaErrorMessage("download_failed")).toBe("Download failed — check glasses WiFi connection")
  })

  it("maps firmware_too_large to size message", () => {
    expect(getOtaErrorMessage("firmware_too_large")).toBe(
      "Firmware file is unexpectedly large — please contact support",
    )
  })

  it("maps firmware_verify_failed to verify message", () => {
    expect(getOtaErrorMessage("firmware_verify_failed")).toBe(
      "Firmware verification failed — please try again or contact support",
    )
  })

  it("maps apk_verify_failed to verify message", () => {
    expect(getOtaErrorMessage("apk_verify_failed")).toBe(
      "Update verification failed — please try again or contact support",
    )
  })

  it("maps install_failed to install message", () => {
    expect(getOtaErrorMessage("install_failed")).toBe("Install failed — please try again")
  })

  it("keeps the BES restart instruction as phone-side UI copy", () => {
    expect(BES_INSTALL_RESTART_MESSAGE).toBe(
      "Restart your glasses to safely exit firmware update mode before trying again",
    )
  })

  it("maps the downgrade handoff codes to recovery-service copy", () => {
    expect(getOtaErrorMessage("downgrade_handoff_failed")).toBe(
      "The recovery service on your glasses did not respond. Restart your glasses and try again.",
    )
    expect(getOtaErrorMessage("downgrade_handoff_refused")).toBe(
      "Your glasses could not start the version change. Restart your glasses and try again.",
    )
    expect(getOtaErrorMessage("downgrade_transaction_stalled")).toBe(
      "The version change on your glasses did not finish. Restart your glasses and try again.",
    )
  })

  it("returns generic message for undefined error", () => {
    expect(getOtaErrorMessage(undefined)).toBe("Update failed")
  })

  it("never echoes an unknown glasses code as the message", () => {
    expect(getOtaErrorMessage("some_custom_error")).toBe(
      "Your glasses reported an unexpected error. Restart your glasses and try again.",
    )
  })

  it("returns generic message for empty string", () => {
    expect(getOtaErrorMessage("")).toBe("Update failed")
  })

  it("treats codes that name inherited Object members as unknown", () => {
    for (const code of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(getOtaErrorMessage(code)).toBe(
        "Your glasses reported an unexpected error. Restart your glasses and try again.",
      )
    }
  })
})

describe("otaErrorCopyKey", () => {
  it("resolves every known glasses code to a key with English copy", () => {
    for (const [code, key] of Object.entries(OTA_GLASSES_ERROR_COPY_KEYS)) {
      expect(otaErrorCopyKey(code)).toBe(key)
      expect(OTA_ERROR_ENGLISH_COPY[key]).toEqual(expect.any(String))
    }
  })

  it("resolves the downgrade handoff failure to its own key", () => {
    expect(otaErrorCopyKey("downgrade_handoff_failed")).toBe("ota:errorDowngradeHandoffFailed")
  })

  it("falls back to the unknown-glasses-error key for unmapped codes", () => {
    expect(otaErrorCopyKey("some_custom_error")).toBe(OTA_ERROR_UNKNOWN_GLASSES_COPY_KEY)
    expect(otaErrorCopyKey("some_custom_error")).toBe("ota:errorGlassesUnknown")
  })

  it("falls back to the plain generic key without a code", () => {
    expect(otaErrorCopyKey(undefined)).toBe("ota:errorGeneric")
    expect(otaErrorCopyKey(null)).toBe("ota:errorGeneric")
    expect(otaErrorCopyKey("")).toBe("ota:errorGeneric")
  })

  it("never resolves an inherited Object member name to a mapped key", () => {
    expect(otaErrorCopyKey("constructor")).toBe(OTA_ERROR_UNKNOWN_GLASSES_COPY_KEY)
    expect(otaErrorCopyKey("__proto__")).toBe(OTA_ERROR_UNKNOWN_GLASSES_COPY_KEY)
  })
})

describe("glasses-side producer coverage", () => {
  // Every code the ASG client can attach to a FAILED ota_status must have its own copy, so
  // scan the producers rather than only the codes already in the table. Producers: literal
  // codes passed to sendProgressToPhone(..., "FAILED", code), the downgrade watchdog codes,
  // classifyDownloadError's return values, FirmwareDownloadException's CODE_* constants, and
  // AsgConstants' OTA_* codes.
  const asgJavaRoot = resolve(__dirname, "../../../../asg_client/app/src/main/java/com/mentra/asg_client")
  const otaHelper = readFileSync(resolve(asgJavaRoot, "io/ota/helpers/OtaHelper.java"), "utf8")
  const downloadException = readFileSync(resolve(asgJavaRoot, "io/ota/utils/FirmwareDownloadException.java"), "utf8")
  const asgConstants = readFileSync(resolve(asgJavaRoot, "AsgConstants.java"), "utf8")

  function matchAll(source: string, pattern: RegExp): string[] {
    return Array.from(source.matchAll(pattern), (match) => match[1])
  }

  const classifyDownloadErrorBody = otaHelper.slice(otaHelper.indexOf("private String classifyDownloadError("))
  const producedCodes = new Set<string>([
    ...matchAll(otaHelper, /"FAILED",\s*"([a-z_]+)"/g),
    ...matchAll(otaHelper, /armHandoffWatchdog\(\s*[\w.]+,\s*"([a-z_]+)"/g),
    ...matchAll(
      classifyDownloadErrorBody.slice(0, classifyDownloadErrorBody.indexOf("\n    }\n")),
      /return "([a-z_]+)";/g,
    ),
    ...matchAll(downloadException, /CODE_[A-Z_]+\s*=\s*"([a-z_]+)"/g),
    ...matchAll(asgConstants, /\bOTA_[A-Z_]+\s*=\s*"([a-z_]+)"/g),
  ])

  it("finds the producers it scans for", () => {
    for (const code of [
      "download_failed",
      "install_failed",
      "no_internet",
      "apk_verify_failed",
      "insufficient_storage",
      "downgrade_handoff_refused",
      "downgrade_handoff_failed",
      "apk_restart_guard_not_persisted",
    ]) {
      expect(producedCodes.has(code)).toBe(true)
    }
  })

  it("maps every code the glasses can report", () => {
    const unmapped = Array.from(producedCodes).filter((code) => !(code in OTA_GLASSES_ERROR_COPY_KEYS))
    expect(unmapped).toEqual([])
  })

  it("has English copy for every mapped key", () => {
    for (const key of Object.values(OTA_GLASSES_ERROR_COPY_KEYS)) {
      expect(typeof OTA_ERROR_ENGLISH_COPY[key]).toBe("string")
    }
  })
})

describe("shouldRequireGlassesRebootForBesFailure", () => {
  it("infers restart-required from an existing generic BES install failure", () => {
    expect(
      shouldRequireGlassesRebootForBesFailure(
        baseOtaStatus({stepType: "bes", phase: "install", status: "failed", error: "install_failed"}),
        null,
        "",
      ),
    ).toBe(true)
  })

  it("infers reboot-required when the phone watchdog fires during BES install", () => {
    expect(
      shouldRequireGlassesRebootForBesFailure(
        baseOtaStatus({stepType: "bes", phase: "install", status: "in_progress"}),
        null,
        "Update appears stalled",
      ),
    ).toBe(true)
  })

  it("does not require reboot for download or non-BES failures", () => {
    expect(
      shouldRequireGlassesRebootForBesFailure(
        baseOtaStatus({stepType: "bes", phase: "download", error: "download_failed"}),
        null,
        "",
      ),
    ).toBe(false)
    expect(
      shouldRequireGlassesRebootForBesFailure(
        baseOtaStatus({stepType: "apk", phase: "install", error: "install_failed"}),
        null,
        "",
      ),
    ).toBe(false)
  })

  it("does not require restart while BES install remains healthy", () => {
    expect(
      shouldRequireGlassesRebootForBesFailure(
        baseOtaStatus({stepType: "bes", phase: "install", status: "in_progress"}),
        null,
        "",
      ),
    ).toBe(false)
  })
})

describe("shouldShowChangeWifiForOtaDownloadFailure", () => {
  it("is true for any glasses failed state in download phase", () => {
    expect(
      shouldShowChangeWifiForOtaDownloadFailure(
        baseOtaStatus({status: "failed", phase: "download", error: "firmware_verify_failed"}),
        null,
        "",
      ),
    ).toBe(true)
    expect(
      shouldShowChangeWifiForOtaDownloadFailure(
        baseOtaStatus({status: "failed", phase: "download", error: "no_internet"}),
        null,
        "",
      ),
    ).toBe(true)
  })

  it("is false when glasses failed in install phase", () => {
    expect(
      shouldShowChangeWifiForOtaDownloadFailure(
        baseOtaStatus({status: "failed", phase: "install", error: "install_failed"}),
        null,
        "",
      ),
    ).toBe(false)
  })

  it("is true for legacy otaProgress FAILED in download stage", () => {
    expect(shouldShowChangeWifiForOtaDownloadFailure(null, baseOtaProgress(), "")).toBe(true)
  })

  it("is true for local watchdog error while store still shows download phase", () => {
    expect(
      shouldShowChangeWifiForOtaDownloadFailure(
        baseOtaStatus({status: "in_progress", phase: "download"}),
        null,
        "Update timed out",
      ),
    ).toBe(true)
    expect(
      shouldShowChangeWifiForOtaDownloadFailure(
        baseOtaStatus({status: "in_progress", phase: "download"}),
        null,
        "Update appears stalled",
      ),
    ).toBe(true)
  })

  it("is false for local watchdog error during install phase", () => {
    expect(
      shouldShowChangeWifiForOtaDownloadFailure(
        baseOtaStatus({status: "in_progress", phase: "install"}),
        null,
        "Update timed out",
      ),
    ).toBe(false)
  })

  it("is false for BLE / ack errors with no download phase in store", () => {
    expect(shouldShowChangeWifiForOtaDownloadFailure(null, null, "No acknowledgement")).toBe(false)
    expect(shouldShowChangeWifiForOtaDownloadFailure(null, null, "Could not start update")).toBe(false)
  })

  it("is false when nothing indicates a download-step failure", () => {
    expect(shouldShowChangeWifiForOtaDownloadFailure(null, null, "")).toBe(false)
  })
})
