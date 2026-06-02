import type {OtaProgress, OtaStatus} from "@mentra/bluetooth-sdk-internal"

import {OtaProgressMessages} from "@/app/ota/otaProgressTimeouts"

import {getOtaErrorMessage, shouldShowChangeWifiForOtaDownloadFailure} from "@/utils/otaErrorMapping"

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

  it("maps install_failed to install message", () => {
    expect(getOtaErrorMessage("install_failed")).toBe("Install failed — please try again")
  })

  it("returns generic message for undefined error", () => {
    expect(getOtaErrorMessage(undefined)).toBe("Update failed")
  })

  it("passes through arbitrary error strings", () => {
    expect(getOtaErrorMessage("some_custom_error")).toBe("some_custom_error")
  })

  it("returns generic message for empty string", () => {
    expect(getOtaErrorMessage("")).toBe("Update failed")
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
        OtaProgressMessages.globalTimeout,
      ),
    ).toBe(true)
    expect(
      shouldShowChangeWifiForOtaDownloadFailure(
        baseOtaStatus({status: "in_progress", phase: "download"}),
        null,
        OtaProgressMessages.stalledOrStuck,
      ),
    ).toBe(true)
  })

  it("is false for local watchdog error during install phase", () => {
    expect(
      shouldShowChangeWifiForOtaDownloadFailure(
        baseOtaStatus({status: "in_progress", phase: "install"}),
        null,
        OtaProgressMessages.globalTimeout,
      ),
    ).toBe(false)
  })

  it("is false for BLE / ack errors with no download phase in store", () => {
    expect(shouldShowChangeWifiForOtaDownloadFailure(null, null, OtaProgressMessages.noAckResponse)).toBe(false)
    expect(shouldShowChangeWifiForOtaDownloadFailure(null, null, OtaProgressMessages.sendOtaStartFailed)).toBe(false)
  })

  it("is false when nothing indicates a download-step failure", () => {
    expect(shouldShowChangeWifiForOtaDownloadFailure(null, null, "")).toBe(false)
  })
})
