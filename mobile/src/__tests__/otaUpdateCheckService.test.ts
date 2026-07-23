import {checkCurrentGlassesForUpdate} from "../../modules/engine/src/services/OtaUpdateCheckService"
import {useGlassesStore} from "../../modules/engine/src/stores/glasses"
import {resetBluetoothSdkMock} from "@/test-utils/mockBluetoothSdk"

describe("OtaUpdateCheckService", () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    resetBluetoothSdkMock()
    useGlassesStore.getState().reset()
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

  it("skips the check entirely for development builds", async () => {
    useGlassesStore.getState().setGlassesInfo({appVersion: "49076573-dev"})
    global.fetch = jest.fn() as unknown as typeof fetch

    const result = await checkCurrentGlassesForUpdate({
      refreshVersionInfo: false,
      fixClockBeforeCheck: false,
      waitForBesVersionMs: 0,
      waitForMtkVersionMs: 0,
    })

    expect(result.skippedReason).toBe("dev_build")
    expect(result.updateAvailable).toBe(false)
    // The manifest must not even be fetched for a dev build.
    expect(global.fetch).not.toHaveBeenCalled()
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

    global.fetch = jest.fn(() => Promise.resolve({ok: false, status: 404} as unknown as Response)) as unknown as typeof fetch
    let result = await check()
    expect(result.hasCheckCompleted).toBe(false)
    expect(result.checkFailureReason).toBe("pin_unavailable")

    global.fetch = jest.fn(() => Promise.reject(new Error("offline"))) as unknown as typeof fetch
    result = await check()
    expect(result.hasCheckCompleted).toBe(false)
    expect(result.checkFailureReason).toBe("network")

    global.fetch = jest.fn(() => Promise.resolve({ok: false, status: 503} as unknown as Response)) as unknown as typeof fetch
    result = await check()
    expect(result.checkFailureReason).toBe("network")
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
      apps: {"com.mentra.asg_client": {versionCode: 9, versionName: "9", downloadUrl: "u", apkSize: 1, sha256: "s", releaseNotes: "", ...extra}},
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
        json: () => Promise.resolve({apps: {"com.mentra.asg_client": {versionCode: 999999, versionName: "n", downloadUrl: "u", apkSize: 1, sha256: "s", releaseNotes: ""}}}),
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
        updates: ["apk", "mtk", "bes"],
      }),
    )
    expect(useGlassesStore.getState().otaUpdateAvailable).toEqual(
      expect.objectContaining({
        available: true,
        versionCode: 11,
        versionName: "11",
        updates: ["apk", "mtk", "bes"],
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
