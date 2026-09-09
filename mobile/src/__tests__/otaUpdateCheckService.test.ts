import {checkCurrentGlassesForUpdate, selectMtkUpdate} from "../../modules/engine/src/services/OtaUpdateCheckService"
import {useGlassesStore} from "../../modules/engine/src/stores/glasses"
import {SETTINGS} from "@mentra/engine"
import {useSettingsStore} from "@mentra/engine-host-internal"
import {bluetoothSdkMock, resetBluetoothSdkMock} from "@/test-utils/mockBluetoothSdk"

describe("MTK full fallback", () => {
  const full = {
    end_firmware: "MentraLive_20260908.10",
    url: "https://cdn/full.zip",
    sha256: "a".repeat(64),
    size: 640341205,
  }
  const patch = {start_firmware: "20260709", end_firmware: "20260908.10", url: "https://cdn/delta.zip"}
  const manifest = {mtk_patches: [patch], mtk_full_ota: full}

  it("prefers the exact-base delta even when a full image exists", () => {
    expect(selectMtkUpdate(manifest, "MentraLive_20260709")).toBe(patch)
  })
  it.each(["20260908.9", "MentraLive_20260907.20", "20260101"])("offers full to older %s", (current) => {
    expect(selectMtkUpdate(manifest, current)).toBe(full)
  })
  it.each([undefined, "", "unknown", "20260908.10", "MentraLive_20260908.11", "20260909"])(
    "does not offer full to %s",
    (current) => {
      expect(selectMtkUpdate(manifest, current)).toBeNull()
    },
  )
  it("handles full-only, legacy-only, and date-only revision zero", () => {
    expect(selectMtkUpdate({mtk_full_ota: full}, "20260709")).toBe(full)
    expect(selectMtkUpdate({mtk_patches: [patch]}, "20260101")).toBeNull()
    expect(selectMtkUpdate({mtk_full_ota: {...full, end_firmware: "20260908.0"}}, "20260908")).toBeNull()
  })
  it.each([{sha256: ""}, {size: 0}, {size: 2 ** 31}, {url: "file:///tmp/full.zip"}, {end_firmware: "unknown"}])(
    "refuses malformed full metadata %j",
    (invalid) => {
      expect(selectMtkUpdate({mtk_full_ota: {...full, ...invalid}}, "20260101")).toBeNull()
    },
  )
})

describe("OtaUpdateCheckService", () => {
  const originalFetch = global.fetch
  const originalEmbeddedManifestUrl = process.env.EXPO_PUBLIC_ASG_OTA_VERSION_URL

  beforeEach(() => {
    process.env.EXPO_PUBLIC_ASG_OTA_VERSION_URL = "https://ota.example/app-pinned-version.json"
    resetBluetoothSdkMock()
    useGlassesStore.getState().reset()
    useSettingsStore.getState().resetAllSettingsLocally()
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      buildNumber: "10",
      otaVersionUrl: "https://ota.example/version.json",
      mtkFirmwareVersion: "20260101",
      besFirmwareVersion: "17.26.1.14",
    })
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  afterAll(() => {
    if (originalEmbeddedManifestUrl === undefined) {
      delete process.env.EXPO_PUBLIC_ASG_OTA_VERSION_URL
    } else {
      process.env.EXPO_PUBLIC_ASG_OTA_VERSION_URL = originalEmbeddedManifestUrl
    }
  })

  it("skips the check entirely when the mobile app has no embedded OTA manifest pin", async () => {
    delete process.env.EXPO_PUBLIC_ASG_OTA_VERSION_URL
    useGlassesStore.getState().setGlassesInfo({appVersion: "staging.20260731.022348.189fe56"})
    global.fetch = jest.fn() as unknown as typeof fetch

    const result = await checkCurrentGlassesForUpdate({
      refreshVersionInfo: false,
      fixClockBeforeCheck: false,
      waitForBesVersionMs: 0,
      waitForMtkVersionMs: 0,
    })

    expect(result.skippedReason).toBe("dev_build")
    expect(result.updateAvailable).toBe(false)
    // An unpinned phone build must not fetch or apply an automatic OTA manifest.
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("skips the check when the glasses run a sideloaded client package", async () => {
    useGlassesStore.getState().setGlassesInfo({
      buildNumber: "120",
      packageName: "com.mentra.asg_client.thirdparty",
    })
    global.fetch = jest.fn() as unknown as typeof fetch

    const result = await checkCurrentGlassesForUpdate({
      refreshVersionInfo: false,
      fixClockBeforeCheck: false,
      waitForBesVersionMs: 0,
      waitForMtkVersionMs: 0,
    })

    expect(result.skippedReason).toBe("unofficial_client")
    expect(result.packageName).toBe("com.mentra.asg_client.thirdparty")
    expect(result.updateAvailable).toBe(false)
    // Installing the manifest APK would replace a package this client is not, so the
    // manifest must not even be fetched: the prompt could never be satisfied.
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("checks normally when the glasses report the stock client package", async () => {
    useGlassesStore.getState().setGlassesInfo({buildNumber: "40", packageName: "com.mentra.asg_client"})
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({apps: {"com.mentra.asg_client": {versionCode: 10}}}),
      } as unknown as Response),
    ) as unknown as typeof fetch

    const result = await checkCurrentGlassesForUpdate({
      refreshVersionInfo: false,
      fixClockBeforeCheck: false,
      waitForBesVersionMs: 0,
      waitForMtkVersionMs: 0,
    })

    expect(result.skippedReason).toBeUndefined()
    expect(result.hasCheckCompleted).toBe(true)
  })

  it("checks normally when the glasses predate the package_name field", async () => {
    // Fielded glasses report no package_name at all; they must keep getting OTA.
    useGlassesStore.getState().setGlassesInfo({buildNumber: "40"})
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({apps: {"com.mentra.asg_client": {versionCode: 10}}}),
      } as unknown as Response),
    ) as unknown as typeof fetch

    const result = await checkCurrentGlassesForUpdate({
      refreshVersionInfo: false,
      fixClockBeforeCheck: false,
      waitForBesVersionMs: 0,
      waitForMtkVersionMs: 0,
    })

    expect(result.skippedReason).toBeUndefined()
    expect(result.hasCheckCompleted).toBe(true)
  })

  it("keeps identity paired with the build number across a disconnect", async () => {
    // Regression: clearing packageName on disconnect while buildNumber survived left a stale
    // sideloaded build paired with a blank package. A blank package reads as stock, so the
    // reconnect would compare the leftover sideloaded build to the stock pin and prompt forever
    // — the original loop. Identity may only be cleared together with the build number, which
    // the native session boundary does atomically.
    useGlassesStore.getState().setGlassesInfo({
      buildNumber: "120",
      packageName: "com.mentra.asg_client.thirdparty",
    })
    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    expect(useGlassesStore.getState().packageName).toBe("com.mentra.asg_client.thirdparty")
    expect(useGlassesStore.getState().buildNumber).toBe("120")

    // Reconnect before version_info_1 lands: stale build + stale identity is fail-closed.
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    global.fetch = jest.fn() as unknown as typeof fetch
    const stale = await checkCurrentGlassesForUpdate({
      refreshVersionInfo: false,
      fixClockBeforeCheck: false,
      waitForBesVersionMs: 0,
      waitForMtkVersionMs: 0,
    })
    expect(stale.skippedReason).toBe("unofficial_client")
    expect(global.fetch).not.toHaveBeenCalled()

    // The native boundary clears both together, so the next session starts clean.
    useGlassesStore.getState().setGlassesInfo({buildNumber: "", packageName: ""})
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      buildNumber: "40",
    })
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({apps: {"com.mentra.asg_client": {versionCode: 10}}}),
      } as unknown as Response),
    ) as unknown as typeof fetch

    const result = await checkCurrentGlassesForUpdate({
      refreshVersionInfo: false,
      fixClockBeforeCheck: false,
      waitForBesVersionMs: 0,
      waitForMtkVersionMs: 0,
    })

    expect(result.skippedReason).toBeUndefined()
    expect(result.hasCheckCompleted).toBe(true)
  })

  it("keeps a known package when a version_info response omits the field", async () => {
    // requestVersionInfo() resolves from ANY version_info chunk, and only chunk 1 carries
    // package_name. The bridges therefore omit the key unless it is known; if they emitted ""
    // instead, the raw-spread apply below would blank a known identity, and a blank package
    // reads as stock — failing OPEN on the exact client the guard just identified.
    useGlassesStore.getState().setGlassesInfo({
      buildNumber: "120",
      packageName: "com.mentra.asg_client.thirdparty",
    })

    const chunkWithoutIdentity = await bluetoothSdkMock.requestVersionInfo()
    // The omission is the contract under test, not an accident of the fixture.
    expect(Object.prototype.hasOwnProperty.call(chunkWithoutIdentity, "packageName")).toBe(false)
    useGlassesStore.getState().setGlassesInfo(chunkWithoutIdentity)

    expect(useGlassesStore.getState().packageName).toBe("com.mentra.asg_client.thirdparty")

    // That same apply does blank buildNumber, which is pre-existing behaviour for every field
    // the responding chunk omits and is out of scope here; restore it so the guard is reached.
    useGlassesStore.getState().setGlassesInfo({buildNumber: "120"})

    global.fetch = jest.fn() as unknown as typeof fetch
    const result = await checkCurrentGlassesForUpdate({
      refreshVersionInfo: false,
      fixClockBeforeCheck: false,
      waitForBesVersionMs: 0,
      waitForMtkVersionMs: 0,
    })

    expect(result.skippedReason).toBe("unofficial_client")
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("allows a pinned mobile build regardless of the ASG app version", async () => {
    useGlassesStore.getState().setGlassesInfo({appVersion: "49076573-dev", buildNumber: "40"})
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({apps: {"com.mentra.asg_client": {versionCode: 10}}}),
      } as unknown as Response),
    ) as unknown as typeof fetch

    const result = await checkCurrentGlassesForUpdate({
      refreshVersionInfo: false,
      fixClockBeforeCheck: false,
      waitForBesVersionMs: 0,
      waitForMtkVersionMs: 0,
    })

    expect(result.skippedReason).toBeUndefined()
    expect(result.hasCheckCompleted).toBe(true)
    expect(global.fetch).toHaveBeenCalledWith("https://ota.example/app-pinned-version.json")
  })

  it("allows an explicit super-mode manifest override from an unpinned mobile build", async () => {
    delete process.env.EXPO_PUBLIC_ASG_OTA_VERSION_URL
    useGlassesStore.getState().setGlassesInfo({buildNumber: "40"})
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        [SETTINGS.super_mode.key]: true,
        [SETTINGS.ota_version_url.key]: "https://ota.example/manual-version.json",
      },
    }))
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({apps: {"com.mentra.asg_client": {versionCode: 40}}}),
      } as unknown as Response),
    ) as unknown as typeof fetch

    const result = await checkCurrentGlassesForUpdate({
      refreshVersionInfo: false,
      fixClockBeforeCheck: false,
      waitForBesVersionMs: 0,
      waitForMtkVersionMs: 0,
    })

    expect(result.skippedReason).toBeUndefined()
    expect(result.hasCheckCompleted).toBe(true)
    expect(global.fetch).toHaveBeenCalledWith("https://ota.example/manual-version.json")
  })

  it("reports a failed check (never up-to-date) for a zeroed pin on modern glasses", async () => {
    useGlassesStore.getState().setGlassesInfo({buildNumber: "49076573"})
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({apps: {"com.mentra.asg_client": {versionCode: 0}}}),
      } as unknown as Response),
    ) as unknown as typeof fetch

    const result = await checkCurrentGlassesForUpdate({
      refreshVersionInfo: false,
      fixClockBeforeCheck: false,
      waitForBesVersionMs: 0,
      waitForMtkVersionMs: 0,
    })

    expect(result.hasCheckCompleted).toBe(false)
    expect(result.updateAvailable).toBe(false)
    expect(result.checkFailureReason).toBe("pin_unavailable")
  })

  it("classifies a 404 pin as pin_unavailable and a network error as network", async () => {
    const check = () =>
      checkCurrentGlassesForUpdate({
        refreshVersionInfo: false,
        fixClockBeforeCheck: false,
        waitForBesVersionMs: 0,
        waitForMtkVersionMs: 0,
      })

    global.fetch = jest.fn(() =>
      Promise.resolve({ok: false, status: 404} as unknown as Response),
    ) as unknown as typeof fetch
    let result = await check()
    expect(result.hasCheckCompleted).toBe(false)
    expect(result.checkFailureReason).toBe("pin_unavailable")

    global.fetch = jest.fn(() => Promise.reject(new Error("offline"))) as unknown as typeof fetch
    result = await check()
    expect(result.hasCheckCompleted).toBe(false)
    expect(result.checkFailureReason).toBe("network")

    global.fetch = jest.fn(() =>
      Promise.resolve({ok: false, status: 503} as unknown as Response),
    ) as unknown as typeof fetch
    result = await check()
    expect(result.checkFailureReason).toBe("network")
  })

  it("keeps a handled network check failure out of the error console", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {})
    const consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => {})
    global.fetch = jest.fn(() => Promise.reject(new Error("network switching"))) as unknown as typeof fetch

    const result = await checkCurrentGlassesForUpdate({
      refreshVersionInfo: false,
      fixClockBeforeCheck: false,
      waitForBesVersionMs: 0,
      waitForMtkVersionMs: 0,
    })

    expect(result.hasCheckCompleted).toBe(false)
    expect(result.checkFailureReason).toBe("network")
    expect(consoleWarn).toHaveBeenCalledWith("OTA: Error fetching version info:", expect.any(Error))
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
    consoleWarn.mockRestore()
  })

  it("skips (missing_build) for an unparseable or zero glasses build number", async () => {
    useGlassesStore.getState().setGlassesInfo({buildNumber: "0"})
    global.fetch = jest.fn() as unknown as typeof fetch

    const result = await checkCurrentGlassesForUpdate({
      refreshVersionInfo: false,
      fixClockBeforeCheck: false,
      waitForBesVersionMs: 0,
      waitForMtkVersionMs: 0,
    })

    expect(result.skippedReason).toBe("missing_build")
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("projects the explicit version response after an APK check clears Engine's cached build", async () => {
    useGlassesStore.getState().setGlassesInfo({buildNumber: ""})
    bluetoothSdkMock.requestVersionInfo.mockResolvedValueOnce({
      androidVersion: "13",
      firmwareVersion: "firmware",
      besFirmwareVersion: "17.26.1.14",
      mtkFirmwareVersion: "20260101",
      buildNumber: "10",
      otaVersionUrl: "https://ota.example/version.json",
      appVersion: "10.0",
    })
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({apps: {"com.mentra.asg_client": {versionCode: 10}}}),
      } as unknown as Response),
    ) as unknown as typeof fetch

    const result = await checkCurrentGlassesForUpdate({
      fixClockBeforeCheck: false,
      waitForBuildNumberMs: 100,
      waitForBesVersionMs: 0,
      waitForMtkVersionMs: 0,
    })

    expect(result.skippedReason).toBeUndefined()
    expect(result.hasCheckCompleted).toBe(true)
    expect(useGlassesStore.getState().buildNumber).toBe("10")
  })

  it("downgrades default to skippable; explicit isRequired forces them", async () => {
    // Enable downgrades with a floor at/below the pin (production ships floor 0 = disabled).
    const check = () =>
      checkCurrentGlassesForUpdate({
        refreshVersionInfo: false,
        fixClockBeforeCheck: false,
        waitForBesVersionMs: 0,
        waitForMtkVersionMs: 0,
        floorVersionCode: 9,
      })
    const manifestWith = (extra: object) => ({
      apps: {
        "com.mentra.asg_client": {
          versionCode: 9,
          versionName: "9",
          downloadUrl: "u",
          apkSize: 1,
          sha256: "s",
          releaseNotes: "",
          ...extra,
        },
      },
    })

    // Glasses newer than the pin -> downgrade; absent isRequired -> skippable.
    global.fetch = jest.fn(() =>
      Promise.resolve({ok: true, json: () => Promise.resolve(manifestWith({}))} as unknown as Response),
    ) as unknown as typeof fetch
    let result = await check()
    expect(result.isApkDowngrade).toBe(true)
    expect(result.isRequired).toBe(false)

    // Explicit isRequired: true is the escape hatch and forces the downgrade.
    global.fetch = jest.fn(() =>
      Promise.resolve({ok: true, json: () => Promise.resolve(manifestWith({isRequired: true}))} as unknown as Response),
    ) as unknown as typeof fetch
    result = await check()
    expect(result.isRequired).toBe(true)

    // Upgrades keep the historical forced default when isRequired is absent.
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            apps: {
              "com.mentra.asg_client": {
                versionCode: 999999,
                versionName: "n",
                downloadUrl: "u",
                apkSize: 1,
                sha256: "s",
                releaseNotes: "",
              },
            },
          }),
      } as unknown as Response),
    ) as unknown as typeof fetch
    result = await check()
    expect(result.isApkDowngrade).toBe(false)
    expect(result.isRequired).toBe(true)

    // Floor 0 (production default) disables downgrades entirely: the same lower pin is not offered.
    global.fetch = jest.fn(() =>
      Promise.resolve({ok: true, json: () => Promise.resolve(manifestWith({}))} as unknown as Response),
    ) as unknown as typeof fetch
    result = await checkCurrentGlassesForUpdate({
      refreshVersionInfo: false,
      fixClockBeforeCheck: false,
      waitForBesVersionMs: 0,
      waitForMtkVersionMs: 0,
      floorVersionCode: 0,
    })
    expect(result.isApkDowngrade).toBe(false)
    expect(result.updateAvailable).toBe(false)
  })

  it("checks the current glasses and writes the available OTA snapshot", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            releaseVersion: "3.1.0-beta.3",
            apps: {
              "com.mentra.asg_client": {
                versionCode: 11,
                versionName: "11",
                downloadUrl: "https://ota.example/app.apk",
                apkSize: 1,
                sha256: "abc",
                releaseNotes: "test",
                isRequired: false,
              },
            },
            mtk_patches: [
              {
                start_firmware: "MentraLive_20260101",
                end_firmware: "MentraLive_20260201",
                url: "https://ota.example/mtk.zip",
              },
            ],
            bes_firmware: {
              version: "17.26.1.15",
              url: "https://ota.example/bes.bin",
            },
          }),
      } as unknown as Response),
    ) as unknown as typeof fetch

    const result = await checkCurrentGlassesForUpdate({
      refreshVersionInfo: false,
      fixClockBeforeCheck: false,
      waitForBesVersionMs: 0,
      waitForMtkVersionMs: 0,
    })

    expect(global.fetch).toHaveBeenCalledWith("https://ota.example/version.json")
    expect(result).toEqual(
      expect.objectContaining({
        hasCheckCompleted: true,
        updateAvailable: true,
        isRequired: false,
        releaseVersion: "3.1.0-beta.3",
        updates: ["apk", "mtk", "bes"],
      }),
    )
    expect(useGlassesStore.getState().otaUpdateAvailable).toEqual(
      expect.objectContaining({
        available: true,
        versionCode: 11,
        versionName: "11",
        updates: ["apk", "mtk", "bes"],
        besVersion: "17.26.1.15",
      }),
    )
  })

  it("filters MTK from the written update info after MTK already updated this session", async () => {
    useGlassesStore.getState().setMtkUpdatedThisSession(true)
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            mtk_patches: [
              {
                start_firmware: "MentraLive_20260101",
                end_firmware: "MentraLive_20260201",
                url: "https://ota.example/mtk.zip",
              },
            ],
          }),
      } as unknown as Response),
    ) as unknown as typeof fetch

    const result = await checkCurrentGlassesForUpdate({
      refreshVersionInfo: false,
      fixClockBeforeCheck: false,
      waitForBesVersionMs: 0,
      waitForMtkVersionMs: 0,
    })

    expect(result.updateAvailable).toBe(false)
    expect(result.updates).toEqual([])
    expect(useGlassesStore.getState().otaUpdateAvailable).toBeNull()
  })
})
