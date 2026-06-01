import {
  findMatchingMtkPatch,
  checkBesUpdate,
  checkVersionUpdateAvailable,
  getLatestVersionInfo,
  mergeOtaCheckWithGlasses,
  shouldShowCacheReadyPrompt,
} from "@/effects/OtaUpdateChecker"

describe("findMatchingMtkPatch", () => {
  const patches = [
    {start_firmware: "MentraLive_20260101", end_firmware: "MentraLive_20260201", url: "https://cdn/patch1.zip"},
    {start_firmware: "MentraLive_20260201", end_firmware: "MentraLive_20260301", url: "https://cdn/patch2.zip"},
  ]

  it("returns null for undefined patches", () => {
    expect(findMatchingMtkPatch(undefined, "20260101")).toBeNull()
  })

  it("returns null for undefined current version", () => {
    expect(findMatchingMtkPatch(patches, undefined)).toBeNull()
  })

  it("returns null when no patch matches", () => {
    expect(findMatchingMtkPatch(patches, "20250101")).toBeNull()
  })

  it("matches exact server format", () => {
    expect(findMatchingMtkPatch(patches, "MentraLive_20260101")).toBe(patches[0])
  })

  it("matches date-only glasses format against server prefixed format", () => {
    expect(findMatchingMtkPatch(patches, "20260101")).toBe(patches[0])
  })

  it("matches second patch for sequential update", () => {
    expect(findMatchingMtkPatch(patches, "20260201")).toBe(patches[1])
  })

  it("returns null for empty patches array", () => {
    expect(findMatchingMtkPatch([], "20260101")).toBeNull()
  })
})

describe("checkBesUpdate", () => {
  const firmware = {version: "17.26.1.15", url: "https://cdn/bes.bin"}

  it("returns false for undefined firmware", () => {
    expect(checkBesUpdate(undefined, "17.26.1.14")).toBe(false)
  })

  it("returns true when current version is unknown (assume update needed)", () => {
    expect(checkBesUpdate(firmware, undefined)).toBe(true)
    expect(checkBesUpdate(firmware, "")).toBe(true)
  })

  it("returns true when server version is newer", () => {
    expect(checkBesUpdate(firmware, "17.26.1.14")).toBe(true)
  })

  it("returns false when versions match", () => {
    expect(checkBesUpdate(firmware, "17.26.1.15")).toBe(false)
  })

  it("returns false when current version is newer", () => {
    expect(checkBesUpdate(firmware, "17.26.2.0")).toBe(false)
  })
})

describe("checkVersionUpdateAvailable", () => {
  const newFormatJson = {
    apps: {
      "com.mentra.asg_client": {
        versionCode: 100,
        versionName: "1.0.0",
        downloadUrl: "https://cdn/app.apk",
        apkSize: 5000000,
        sha256: "abc123",
        releaseNotes: "Test",
      },
    },
  }

  const legacyJson = {
    versionCode: 50,
    versionName: "0.5.0",
    downloadUrl: "https://cdn/app.apk",
    apkSize: 3000000,
    sha256: "def456",
    releaseNotes: "Legacy",
  }

  it("returns false for undefined build number", () => {
    expect(checkVersionUpdateAvailable(undefined, newFormatJson)).toBe(false)
  })

  it("returns false for null version json", () => {
    expect(checkVersionUpdateAvailable("50", null)).toBe(false)
  })

  it("returns false for non-numeric build number", () => {
    expect(checkVersionUpdateAvailable("abc", newFormatJson)).toBe(false)
  })

  it("detects update available in new format", () => {
    expect(checkVersionUpdateAvailable("50", newFormatJson)).toBe(true)
  })

  it("returns false when current equals server in new format", () => {
    expect(checkVersionUpdateAvailable("100", newFormatJson)).toBe(false)
  })

  it("returns false when current is newer in new format", () => {
    expect(checkVersionUpdateAvailable("200", newFormatJson)).toBe(false)
  })

  it("detects update available in legacy format", () => {
    expect(checkVersionUpdateAvailable("30", legacyJson)).toBe(true)
  })

  it("returns false when no update in legacy format", () => {
    expect(checkVersionUpdateAvailable("50", legacyJson)).toBe(false)
  })
})

describe("getLatestVersionInfo", () => {
  it("returns null for null input", () => {
    expect(getLatestVersionInfo(null)).toBeNull()
  })

  it("extracts info from new format", () => {
    const json = {
      apps: {
        "com.mentra.asg_client": {
          versionCode: 100,
          versionName: "1.0.0",
          downloadUrl: "https://cdn/app.apk",
          apkSize: 5000000,
          sha256: "abc123",
          releaseNotes: "New release",
        },
      },
    }
    const result = getLatestVersionInfo(json)
    expect(result).not.toBeNull()
    expect(result!.versionCode).toBe(100)
    expect(result!.versionName).toBe("1.0.0")
  })

  it("extracts info from legacy format", () => {
    const json = {
      versionCode: 50,
      versionName: "0.5.0",
    }
    const result = getLatestVersionInfo(json as any)
    expect(result).not.toBeNull()
    expect(result!.versionCode).toBe(50)
  })

  it("returns null for empty json", () => {
    expect(getLatestVersionInfo({} as any)).toBeNull()
  })
})

describe("mergeOtaCheckWithGlasses", () => {
  const phoneNo = {
    hasCheckCompleted: true,
    updateAvailable: false,
    latestVersionInfo: {
      versionCode: 38,
      versionName: "38.0",
      downloadUrl: "https://example/apk",
      apkSize: 1,
      sha256: "x",
      releaseNotes: "",
    },
    updates: [] as string[],
    mtkPatch: null,
    besVersion: "17.26.2.22",
  }

  it("returns phone result when glasses have no hint", () => {
    expect(mergeOtaCheckWithGlasses(phoneNo, null)).toEqual(phoneNo)
  })

  it("union-updates when glasses report ota_update_available (stale phone build case)", () => {
    const merged = mergeOtaCheckWithGlasses(phoneNo, {
      available: true,
      versionCode: 38,
      versionName: "38.0",
      updates: ["apk", "bes"],
      totalSize: 0,
      cacheReady: true,
    })
    expect(merged.updateAvailable).toBe(true)
    expect(merged.updates.sort()).toEqual(["apk", "bes"].sort())
    expect(merged.latestVersionInfo?.versionCode).toBe(38)
  })
})

describe("shouldShowCacheReadyPrompt", () => {
  const cacheReady = {
    available: true,
    versionCode: 100,
    versionName: "1.0",
    updates: ["apk"],
    totalSize: 5_000_000,
    cacheReady: true,
  }

  const baseArgs = {
    pathname: "/home",
    glassesConnected: true,
    glassesWifiConnected: true,
    otaUpdateAvailable: cacheReady,
  }

  it("returns true when glasses report a cache-ready update on /home with WiFi", () => {
    expect(shouldShowCacheReadyPrompt(baseArgs)).toBe(true)
  })

  it("returns false off the /home route", () => {
    expect(shouldShowCacheReadyPrompt({...baseArgs, pathname: "/settings"})).toBe(false)
    expect(shouldShowCacheReadyPrompt({...baseArgs, pathname: null})).toBe(false)
  })

  it("returns false when glasses are not connected", () => {
    expect(shouldShowCacheReadyPrompt({...baseArgs, glassesConnected: false})).toBe(false)
  })

  it("returns false when glasses WiFi is offline", () => {
    expect(shouldShowCacheReadyPrompt({...baseArgs, glassesWifiConnected: false})).toBe(false)
  })

  it("returns false when otaUpdateAvailable is null/undefined", () => {
    expect(shouldShowCacheReadyPrompt({...baseArgs, otaUpdateAvailable: null})).toBe(false)
    expect(shouldShowCacheReadyPrompt({...baseArgs, otaUpdateAvailable: undefined})).toBe(false)
  })

  it("returns false when available is false", () => {
    expect(shouldShowCacheReadyPrompt({...baseArgs, otaUpdateAvailable: {...cacheReady, available: false}})).toBe(false)
  })

  it("returns false when updates list is empty", () => {
    expect(shouldShowCacheReadyPrompt({...baseArgs, otaUpdateAvailable: {...cacheReady, updates: []}})).toBe(false)
  })

  // The most important case: this is exactly the in-flow write produced by
  // check-for-updates.tsx. Without the cacheReady gate it would resurrect the popup
  // on the next return to /home (e.g. after a completed update + a re-check that
  // found nothing).
  it("returns false when cacheReady is not strictly true (in-flow check-for-updates write)", () => {
    expect(shouldShowCacheReadyPrompt({...baseArgs, otaUpdateAvailable: {...cacheReady, cacheReady: false}})).toBe(
      false,
    )
    expect(shouldShowCacheReadyPrompt({...baseArgs, otaUpdateAvailable: {...cacheReady, cacheReady: undefined}})).toBe(
      false,
    )
  })
})
