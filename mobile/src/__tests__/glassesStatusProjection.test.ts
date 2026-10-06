// This test exercises engine-private projection and stores; no public test export exists.
/* eslint-disable no-restricted-imports */
import {
  startGlassesStatusProjection,
  stopGlassesStatusProjection,
  toMiniappConnectionData,
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

  it("hydrates the connected replacement pair after switching while projection is stopped", async () => {
    const pairA = {id: "A", model: "Mentra Live"}
    const pairB = {id: "B", model: "Mentra Live"}
    ;(bluetoothSdkMock.getDefaultDevice as jest.Mock).mockResolvedValueOnce(pairA)
    ;(bluetoothSdkMock.getGlassesStatus as jest.Mock).mockResolvedValueOnce({
      connection: {state: "connected", fullyBooted: true},
      appVersion: "A",
    })
    await startGlassesStatusProjection()
    stopGlassesStatusProjection()
    ;(bluetoothSdkMock.getDefaultDevice as jest.Mock).mockResolvedValueOnce(pairB)
    ;(bluetoothSdkMock.getGlassesStatus as jest.Mock).mockResolvedValueOnce({
      connection: {state: "connected", fullyBooted: true},
      appVersion: "B",
      wifi: {state: "connected", ssid: "office"},
    })
    await startGlassesStatusProjection()

    expect(useGlassesStore.getState()).toMatchObject({
      connection: {state: "connected", fullyBooted: true},
      appVersion: "B",
      wifiStatusKnown: true,
    })
  })

  it("refetches the current pair when ownership changes during status hydration", async () => {
    let resolveSnapshot!: (status: unknown) => void
    const pairA = {id: "A", model: "Mentra Live"}
    const pairB = {id: "B", model: "Mentra Live"}
    ;(bluetoothSdkMock.getDefaultDevice as jest.Mock).mockResolvedValueOnce(pairA)
    ;(bluetoothSdkMock.getGlassesStatus as jest.Mock)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSnapshot = resolve
        }),
      )
      .mockResolvedValueOnce({connection: {state: "connected", fullyBooted: true}, appVersion: "B"})
    const hydration = startGlassesStatusProjection()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    emitBluetoothSdkEvent("glasses_status", {appVersion: "A"})
    emitBluetoothSdkEvent("default_device_changed", {device: pairB})
    resolveSnapshot({connection: {state: "connected", fullyBooted: true}, appVersion: "A"})
    await hydration

    expect(bluetoothSdkMock.getGlassesStatus).toHaveBeenCalledTimes(2)
    expect(useGlassesStore.getState().appVersion).toBe("B")
  })

  it("uses the new pair when a pairing event wins over delayed default-device hydration", async () => {
    let resolveDevice!: (device: unknown) => void
    ;(bluetoothSdkMock.getDefaultDevice as jest.Mock).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDevice = resolve
      }),
    )
    ;(bluetoothSdkMock.getGlassesStatus as jest.Mock).mockResolvedValueOnce({
      connection: {state: "connected", fullyBooted: true},
      appVersion: "B",
    })
    const hydration = startGlassesStatusProjection()
    expect(bluetoothSdkMock.getGlassesStatus).not.toHaveBeenCalled()
    emitBluetoothSdkEvent("default_device_changed", {device: {id: "B", model: "Mentra Live"}})
    resolveDevice({id: "A", model: "Mentra Live"})
    await hydration
    expect(useGlassesStore.getState().appVersion).toBe("B")
  })

  it("discards a pending snapshot when the projection stops", async () => {
    let resolveSnapshot!: (status: unknown) => void
    ;(bluetoothSdkMock.getGlassesStatus as jest.Mock).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSnapshot = resolve
      }),
    )
    const hydration = startGlassesStatusProjection()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    stopGlassesStatusProjection()
    resolveSnapshot({connection: {state: "connected", fullyBooted: true}, appVersion: "A"})
    await hydration
    expect(useGlassesStore.getState().appVersion).toBe("")
  })

  it("carries the delayed G2 arm notice through hydration, the facade and live clearing", async () => {
    const {glasses} = jest.requireActual(
      "../../modules/engine/src/facades/glasses",
    ) as typeof import("../../modules/engine/src/facades/glasses")
    ;(bluetoothSdkMock.getGlassesStatus as jest.Mock).mockResolvedValueOnce({
      connection: {state: "disconnected"},
      g2MissingArm: "left",
    })
    await startGlassesStatusProjection()
    expect(glasses.status().g2MissingArm).toBe("left")
    expect(glasses.status().fullyBooted).toBe(false)
    const listener = jest.fn()
    const unsubscribe = glasses.onStatus(listener)
    emitBluetoothSdkEvent("glasses_status", {g2MissingArm: null})
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({g2MissingArm: null}))
    expect(glasses.status().g2MissingArm).toBeNull()
    unsubscribe()
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

    await startGlassesStatusProjection()

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

    const hydration = startGlassesStatusProjection()
    for (let i = 0; i < 5; i++) await Promise.resolve()
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
    await hydration

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

  it("adds full-runtime event forwarding after OTA-only initialization", () => {
    const forward = jest.fn()
    startGlassesStatusProjection()
    startGlassesStatusProjection(forward)

    const changed = {
      connection: {state: "connected", fullyBooted: true} as const,
      deviceModel: "Mentra Live",
    }
    emitBluetoothSdkEvent("glasses_status", changed)

    expect(forward).toHaveBeenCalledWith(changed)
  })
})

describe("toMiniappConnectionData", () => {
  it("maps nested connection.state to the miniapp connected boolean", () => {
    expect(
      toMiniappConnectionData({
        connection: {state: "connected", fullyBooted: true},
        deviceModel: "Mentra Live",
        batteryLevel: 80,
      }),
    ).toEqual({connected: true, modelName: "Mentra Live"})
  })

  it("maps a disconnect delta without inventing a model name", () => {
    expect(toMiniappConnectionData({connection: {state: "disconnected"}})).toEqual({connected: false})
  })

  it("returns null for battery-only deltas so they cannot flip the link", () => {
    expect(toMiniappConnectionData({batteryLevel: 80})).toBeNull()
  })

  it("passes through an already-shaped ConnectionData payload", () => {
    expect(toMiniappConnectionData({connected: true, modelName: "Mentra Live"})).toEqual({
      connected: true,
      modelName: "Mentra Live",
    })
  })

  it("returns null for empty or non-object payloads", () => {
    expect(toMiniappConnectionData(null)).toBeNull()
    expect(toMiniappConnectionData(undefined)).toBeNull()
  })
})
