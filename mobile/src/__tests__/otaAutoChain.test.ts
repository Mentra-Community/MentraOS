import type {OtaCheckCurrentGlassesResult} from "@mentra/engine"

import {
  beginOtaAutoChain,
  clearOtaAutoChainReconnectWait,
  isOtaAutoChainActive,
  MAX_OTA_AUTO_CHAIN_PASSES,
  OTA_AUTO_CHAIN_RECONNECT_TIMEOUT_MS,
  otaAutoChainFingerprint,
  otaAutoChainReconnectWaitRemaining,
  stopOtaAutoChain,
  tryAdvanceOtaAutoChain,
} from "@/services/otaAutoChain"

function result(overrides: Partial<OtaCheckCurrentGlassesResult> = {}): OtaCheckCurrentGlassesResult {
  return {
    hasCheckCompleted: true,
    updateAvailable: true,
    latestVersionInfo: {
      versionCode: 37,
      versionName: "37.0",
      downloadUrl: "https://example.com/asg.apk",
      apkSize: 1,
      sha256: "abc",
      releaseNotes: "",
    },
    updates: ["apk"],
    mtkPatch: null,
    besVersion: null,
    isApkDowngrade: false,
    manifestBody: '{"version":37}',
    updateInfo: {
      available: true,
      versionCode: 37,
      versionName: "37.0",
      updates: ["apk"],
      totalSize: 0,
    },
    isRequired: true,
    manifestUrl: "https://example.com/legacy.json",
    buildNumber: "1",
    mtkFirmwareVersion: "MentraLive_20260113",
    besFirmwareVersion: "17.26.01.13",
    ...overrides,
  }
}

afterEach(() => stopOtaAutoChain())

it("advances through distinct update offers after the user approves the first pass", () => {
  const first = otaAutoChainFingerprint(result())
  const second = otaAutoChainFingerprint(result({buildNumber: "37", updates: ["mtk", "bes"]}))

  beginOtaAutoChain(first, false)

  expect(tryAdvanceOtaAutoChain(second, false)).toEqual({advance: true, passCount: 2})
  expect(isOtaAutoChainActive()).toBe(true)
})

it("stops instead of reinstalling the same offer twice", () => {
  const fingerprint = otaAutoChainFingerprint(result())
  beginOtaAutoChain(fingerprint, false)

  expect(tryAdvanceOtaAutoChain(fingerprint, false)).toEqual({advance: false, reason: "duplicate"})
  expect(isOtaAutoChainActive()).toBe(false)
})

it("requires separate approval when an upgrade chain encounters a downgrade", () => {
  beginOtaAutoChain(otaAutoChainFingerprint(result()), false)

  expect(tryAdvanceOtaAutoChain("downgrade", true)).toEqual({
    advance: false,
    reason: "downgrade_not_approved",
  })
  expect(isOtaAutoChainActive()).toBe(false)
})

it("allows subsequent downgrade passes when the user approved a downgrade initially", () => {
  beginOtaAutoChain("firmware-first-downgrade", true)

  expect(tryAdvanceOtaAutoChain("downgrade-handoff", true)).toEqual({advance: true, passCount: 2})
})

it("bounds the number of automatic passes", () => {
  beginOtaAutoChain("pass-1", false)
  for (let pass = 2; pass <= MAX_OTA_AUTO_CHAIN_PASSES; pass += 1) {
    expect(tryAdvanceOtaAutoChain(`pass-${pass}`, false).advance).toBe(true)
  }

  expect(tryAdvanceOtaAutoChain("one-too-many", false)).toEqual({advance: false, reason: "max_passes"})
  expect(isOtaAutoChainActive()).toBe(false)
})

it("bounds a reboot reconnect wait without extending it on subsequent renders", () => {
  beginOtaAutoChain("pass-1", false)

  expect(otaAutoChainReconnectWaitRemaining(1_000)).toBe(OTA_AUTO_CHAIN_RECONNECT_TIMEOUT_MS)
  expect(otaAutoChainReconnectWaitRemaining(2_000)).toBe(OTA_AUTO_CHAIN_RECONNECT_TIMEOUT_MS - 1_000)
  expect(otaAutoChainReconnectWaitRemaining(1_000 + OTA_AUTO_CHAIN_RECONNECT_TIMEOUT_MS)).toBe(0)
})

it("starts a fresh bounded wait after a successful reconnect", () => {
  beginOtaAutoChain("pass-1", false)
  expect(otaAutoChainReconnectWaitRemaining(1_000)).toBe(OTA_AUTO_CHAIN_RECONNECT_TIMEOUT_MS)

  clearOtaAutoChainReconnectWait()

  expect(otaAutoChainReconnectWaitRemaining(10_000)).toBe(OTA_AUTO_CHAIN_RECONNECT_TIMEOUT_MS)
})
