import type {OtaCheckCurrentGlassesResult} from "@mentra/engine"

import {
  beginOtaAutoChain,
  isOtaAutoChainActive,
  MAX_OTA_AUTO_CHAIN_PASSES,
  otaAutoChainFingerprint,
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
