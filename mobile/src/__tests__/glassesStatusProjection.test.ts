import {
  startGlassesStatusProjection,
  stopGlassesStatusProjection,
} from "../../modules/engine/src/services/GlassesStatusProjection"
import {useCoreStore} from "../../modules/engine/src/stores/core"
import {useGlassesStore} from "../../modules/engine/src/stores/glasses"
import {bluetoothSdkMock, emitBluetoothSdkEvent, resetBluetoothSdkMock} from "@/test-utils/mockBluetoothSdk"

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

  it("does not let a delayed initial glasses snapshot overwrite a live status event", async () => {
    let resolveInitialSnapshot: (status: unknown) => void = () => {}
    ;(bluetoothSdkMock.getGlassesStatus as jest.Mock).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInitialSnapshot = resolve
      }),
    )

    startGlassesStatusProjection()
    emitBluetoothSdkEvent("glasses_status", {
      connection: {state: "connected", fullyBooted: true},
      deviceModel: "Live event",
      batteryLevel: 88,
    })

    resolveInitialSnapshot({
      connection: {state: "disconnected"},
      deviceModel: "Stale snapshot",
      batteryLevel: 1,
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(useGlassesStore.getState()).toEqual(
      expect.objectContaining({
        connection: expect.objectContaining({state: "connected"}),
        deviceModel: "Live event",
        batteryLevel: 88,
      }),
    )
  })

  it("clears session-scoped hotspot capability and Wi-Fi knowledge on disconnect", () => {
    startGlassesStatusProjection()
    emitBluetoothSdkEvent("glasses_status", {
      connection: {state: "connected", fullyBooted: true},
      hotspotOtaVersion: 1,
      wifi: {state: "connected", ssid: "office"},
    })

    expect(useGlassesStore.getState()).toEqual(expect.objectContaining({hotspotOtaVersion: 1, wifiStatusKnown: true}))

    emitBluetoothSdkEvent("glasses_status", {connection: {state: "disconnected"}})

    expect(useGlassesStore.getState()).toEqual(expect.objectContaining({hotspotOtaVersion: 0, wifiStatusKnown: false}))
  })
})
