import {
  startGlassesStatusProjection,
  stopGlassesStatusProjection,
} from "../../modules/island/src/services/GlassesStatusProjection"
import {useCoreStore} from "../../modules/island/src/stores/core"
import {useGlassesStore} from "../../modules/island/src/stores/glasses"
import {bluetoothSdkMock, resetBluetoothSdkMock} from "@/test-utils/mockBluetoothSdk"

describe("GlassesStatusProjection", () => {
  beforeEach(() => {
    resetBluetoothSdkMock()
    useCoreStore.getState().reset()
    useGlassesStore.getState().reset()
  })

  afterEach(() => {
    stopGlassesStatusProjection()
  })

  it("hydrates the initial bluetooth and glasses status snapshots", async () => {
    ;(bluetoothSdkMock.getBluetoothStatus as jest.Mock).mockResolvedValueOnce({
      searching: true,
      micRanking: ["glasses"],
      currentMic: "glasses",
      wifiScanResults: [],
      searchResults: [],
      lastLog: [],
      otherBtConnected: true,
    })
    ;(bluetoothSdkMock.getGlassesStatus as jest.Mock).mockResolvedValueOnce({
      connection: {state: "connected", fullyBooted: true},
      deviceModel: "Mentra Live",
      batteryLevel: 77,
    })

    startGlassesStatusProjection()
    await Promise.resolve()
    await Promise.resolve()

    expect(useCoreStore.getState()).toEqual(expect.objectContaining({searching: true, otherBtConnected: true}))
    expect(useGlassesStore.getState()).toEqual(
      expect.objectContaining({
        deviceModel: "Mentra Live",
        batteryLevel: 77,
      }),
    )
  })
})
