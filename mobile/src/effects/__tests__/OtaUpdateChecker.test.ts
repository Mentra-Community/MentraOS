import {
  findMatchingMtkPatch,
  checkBesUpdate,
  checkVersionUpdateAvailable,
  getPendingUpdatePromptAction,
  getLatestVersionInfo,
} from "@/effects/OtaUpdateChecker"

describe("getPendingUpdatePromptAction", () => {
  it("waits until the glasses WiFi status is known", () => {
    expect(getPendingUpdatePromptAction(true, false, false, true)).toBeNull()
  })

  it("prompts for WiFi when returning home with an old ASG and no glasses WiFi", () => {
    expect(getPendingUpdatePromptAction(true, true, false, false)).toBe("wifi_setup")
  })

  it("waits while an update is cached away from home with no available transport", () => {
    expect(getPendingUpdatePromptAction(false, true, false, false)).toBeNull()
  })

  it("prompts for install when WiFi or hotspot OTA is available", () => {
    expect(getPendingUpdatePromptAction(true, true, true, false)).toBe("install")
    expect(getPendingUpdatePromptAction(true, true, false, true)).toBe("install")
  })
})

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

  it("does not flag a downgrade when the floor is disabled (production default 0)", () => {
    // Floor 0 disables downgrades: a newer installed build than the exact pin is not offered.
    expect(checkVersionUpdateAvailable("200", newFormatJson)).toBe(false)
  })

  it("flags a downgrade when the floor is enabled at/below the pin", () => {
    // With a positive floor at/below the pinned versionCode (100), the lower-than-installed pin
    // is an actionable version change.
    expect(checkVersionUpdateAvailable("200", newFormatJson, 100)).toBe(true)
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
