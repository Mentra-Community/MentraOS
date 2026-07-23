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
