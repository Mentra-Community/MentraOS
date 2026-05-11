import {
  findMatchingMtkPatch,
  checkBesUpdate,
  checkVersionUpdateAvailable,
  getLatestVersionInfo,
  mergeOtaCheckWithGlasses,
} from "../OtaUpdateChecker"

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

  it("returns true when current version is unknown", () => {
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
