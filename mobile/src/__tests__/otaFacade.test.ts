import BluetoothSdk from "@mentra/bluetooth-sdk-internal"
import {ota} from "../../modules/island/src/facades/ota"
import {useGlassesStore} from "../../modules/island/src/stores/glasses"

describe("ota facade", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(BluetoothSdk as typeof BluetoothSdk & {checkForOtaUpdate: jest.Mock}).checkForOtaUpdate = jest.fn()
    useGlassesStore.getState().reset()
  })

  it("exposes OTA snapshots from the glasses store", () => {
    const status = {status: "running", progress: 25} as never
    const progress = {status: "IN_PROGRESS", stage: "download", progress: 25} as never
    const updateAvailable = {versionName: "1.2.3"} as never
    useGlassesStore.setState({
      otaStatus: status,
      otaProgress: progress,
      otaUpdateAvailable: updateAvailable,
      mtkUpdatedThisSession: true,
    })

    expect(ota.status()).toBe(status)
    expect(ota.progress()).toBe(progress)
    expect(ota.updateAvailable()).toBe(updateAvailable)
    expect(ota.mtkUpdatedThisSession()).toBe(true)
  })

  it("install() and retry() delegate to bluetooth-sdk", () => {
    ota.install("https://example.com/version.json")
    ota.retry()

    expect(BluetoothSdk.startOtaUpdate).toHaveBeenCalledWith("https://example.com/version.json")
    expect(BluetoothSdk.checkForOtaUpdate).toHaveBeenCalled()
  })
})
