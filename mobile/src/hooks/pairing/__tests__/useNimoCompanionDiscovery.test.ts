import BluetoothSdk, {type Device} from "@mentra/bluetooth-sdk"
import {act, renderHook} from "@testing-library/react-native"
import {AppState, type AppStateStatus} from "react-native"

import {useNimoCompanionDiscovery} from "@/hooks/pairing/useNimoCompanionDiscovery"

jest.mock("expo-router", () => ({
  useFocusEffect: (effect: () => () => void) => require("react").useEffect(effect, [effect]),
}))
jest.mock("@mentra/bluetooth-sdk", () => ({__esModule: true, default: {scan: jest.fn(), stopScan: jest.fn()}}))

const nimo: Device = {id: "nimo-a", name: "Nimo-4027", model: "NIMO", address: "nimo-a"}
const second: Device = {...nimo, id: "nimo-b", address: "nimo-b", name: "Nimo-4028"}

describe("NIMO Companion discovery", () => {
  let scans: Array<{emit: (devices: Device[]) => void; finish: () => void; fail: (error: Error) => void}>
  let changeAppState: (state: AppStateStatus) => void
  const remove = jest.fn()
  const selected = jest.fn()

  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    scans = []
    Object.defineProperty(AppState, "currentState", {configurable: true, value: "active"})
    jest.spyOn(AppState, "addEventListener").mockImplementation((_event, handler) => {
      changeAppState = handler
      return {remove}
    })
    ;(BluetoothSdk.stopScan as jest.Mock).mockResolvedValue(undefined)
    ;(BluetoothSdk.scan as jest.Mock).mockImplementation(
      (_model, options) =>
        new Promise<void>((resolve, reject) => {
          scans.push({emit: options.onResults, finish: resolve, fail: reject})
        }),
    )
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  async function setup() {
    const hook = renderHook(() => useNimoCompanionDiscovery(selected))
    await act(async () => {})
    return hook
  }

  async function settle() {
    await act(async () => {
      jest.advanceTimersByTime(1000)
    })
  }

  it("checks on entry and hands an already connected device to pairing only after stopping discovery", async () => {
    let finishStop!: () => void
    ;(BluetoothSdk.stopScan as jest.Mock).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve
        }),
    )
    await setup()
    expect(BluetoothSdk.scan).toHaveBeenCalledWith("NIMO", expect.objectContaining({onResults: expect.any(Function)}))
    act(() => scans[0].emit([nimo]))
    await settle()
    expect(BluetoothSdk.stopScan).toHaveBeenCalledTimes(1)
    expect(selected).not.toHaveBeenCalled()
    await act(async () => finishStop())
    expect(selected).toHaveBeenCalledWith(nimo)
    await settle()
    expect(selected).toHaveBeenCalledTimes(1)
  })

  it("ignores the BLE notification peripheral and other models", async () => {
    const hook = await setup()
    act(() =>
      scans[0].emit([
        {...nimo, name: "Nimo-4027_BLE"},
        {...second, model: "Mentra Live"},
      ]),
    )
    await settle()
    expect(hook.result.current.devices).toEqual([])
    expect(selected).not.toHaveBeenCalled()
  })

  it("waits for an explicit choice when multiple NIMOs arrive", async () => {
    const hook = await setup()
    act(() => scans[0].emit([nimo]))
    await act(async () => jest.advanceTimersByTime(500))
    act(() => scans[0].emit([nimo, second]))
    await settle()
    expect(selected).not.toHaveBeenCalled()
    expect(hook.result.current.devices).toEqual([nimo, second])
    await act(async () => hook.result.current.select(second))
    expect(selected).toHaveBeenCalledWith(second)
  })

  it("keeps explicit selection after returning from Settings with only one NIMO", async () => {
    const hook = await setup()
    act(() => scans[0].emit([nimo, second]))
    expect(hook.result.current.requiresSelection).toBe(true)
    await act(async () => changeAppState("background"))
    await act(async () => changeAppState("active"))
    act(() => scans[1].emit([second]))
    await settle()
    expect(hook.result.current.requiresSelection).toBe(true)
    expect(hook.result.current.devices).toEqual([second])
    expect(selected).not.toHaveBeenCalled()
    await act(async () => hook.result.current.select(second))
    expect(selected).toHaveBeenCalledWith(second)
  })

  it("rechecks on return from Settings and ignores the old scan", async () => {
    const hook = await setup()
    act(() => scans[0].emit([nimo]))
    await act(async () => changeAppState("background"))
    await settle()
    expect(selected).not.toHaveBeenCalled()
    await act(async () => changeAppState("active"))
    expect(scans).toHaveLength(2)
    act(() => scans[0].emit([nimo]))
    expect(hook.result.current.devices).toEqual([])
    act(() => scans[1].emit([second]))
    await settle()
    expect(selected).toHaveBeenCalledWith(second)
  })

  it("cancels selection and listeners when leaving the screen", async () => {
    const hook = await setup()
    act(() => scans[0].emit([nimo]))
    hook.unmount()
    await settle()
    expect(remove).toHaveBeenCalledTimes(1)
    expect(BluetoothSdk.stopScan).toHaveBeenCalledTimes(1)
    expect(selected).not.toHaveBeenCalled()
  })

  it("offers retry after an empty scan or a failure", async () => {
    const hook = await setup()
    await act(async () => scans[0].finish())
    expect(hook.result.current.needsRetry).toBe(true)
    await act(async () => hook.result.current.retry())
    expect(hook.result.current.needsRetry).toBe(false)
    expect(scans).toHaveLength(2)
    jest.spyOn(console, "warn").mockImplementation(() => {})
    await act(async () => scans[1].fail(new Error("radio unavailable")))
    expect(hook.result.current.needsRetry).toBe(true)
    expect(selected).not.toHaveBeenCalled()
  })

  it("revalidates a selection if Settings opens while the scan is stopping", async () => {
    let finishStop!: () => void
    ;(BluetoothSdk.stopScan as jest.Mock).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve
        }),
    )
    await setup()
    act(() => scans[0].emit([nimo]))
    await settle()
    await act(async () => changeAppState("inactive"))
    await act(async () => changeAppState("active"))
    await act(async () => finishStop())
    expect(selected).not.toHaveBeenCalled()
    expect(scans).toHaveLength(2)
    ;(BluetoothSdk.stopScan as jest.Mock).mockResolvedValue(undefined)
    act(() => scans[1].emit([second]))
    await settle()
    expect(selected).toHaveBeenCalledWith(second)
  })

  it("does not start a stale scan when foreground changes during stop", async () => {
    let finishStop!: () => void
    ;(BluetoothSdk.stopScan as jest.Mock).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve
        }),
    )
    const hook = await setup()
    await act(async () => changeAppState("background"))
    await act(async () => changeAppState("active"))
    await act(async () => changeAppState("background"))
    await act(async () => finishStop())
    expect(scans).toHaveLength(1)
    expect(selected).not.toHaveBeenCalled()
    hook.unmount()
  })
})
