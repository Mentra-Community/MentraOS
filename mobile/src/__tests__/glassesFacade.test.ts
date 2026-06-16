// Imports the real glasses facade by path (not via "@mentra/island", which jest
// mocks) so the actual projection + delegation run under the mobile jest runner.
import BluetoothSdk from "@mentra/bluetooth-sdk"
import {glasses} from "../../modules/island/src/facades/glasses"
import {useGlassesStore} from "../../modules/island/src/stores/glasses"

describe("glasses facade", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    useGlassesStore.getState().reset()
  })

  it("status() projects the glasses store into the read-model", () => {
    useGlassesStore.setState({
      connection: {state: "connected", fullyBooted: true} as never,
      batteryLevel: 80,
      charging: true,
      signalStrength: -50,
      micEnabled: true,
      bluetoothClassicConnected: true,
    })
    const st = glasses.status()
    expect(st.state).toBe("connected")
    expect(st.fullyBooted).toBe(true)
    expect(st.battery).toBe(80)
    expect(st.charging).toBe(true)
    expect(st.micEnabled).toBe(true)
    expect(st.btClassic).toBe(true)
  })

  it("info() projects device info from the store", () => {
    useGlassesStore.setState({deviceModel: "Even Realities G1", firmwareVersion: "1.2.3", serialNumber: "SN1"})
    const info = glasses.info()
    expect(info.model).toBe("Even Realities G1")
    expect(info.firmwareVersion).toBe("1.2.3")
    expect(info.serialNumber).toBe("SN1")
  })

  it("connectDefault / disconnect / forget delegate to bluetooth-sdk", async () => {
    await glasses.connectDefault()
    expect(BluetoothSdk.connectDefault).toHaveBeenCalled()
    await glasses.disconnect()
    expect(BluetoothSdk.disconnect).toHaveBeenCalled()
    await glasses.forget()
    expect(BluetoothSdk.forget).toHaveBeenCalled()
  })

  it("onStatus() fires on store changes and stops after unsubscribe", () => {
    const cb = jest.fn()
    const unsub = glasses.onStatus(cb)
    useGlassesStore.setState({batteryLevel: 42})
    expect(cb).toHaveBeenCalled()
    unsub()
    cb.mockClear()
    useGlassesStore.setState({batteryLevel: 10})
    expect(cb).not.toHaveBeenCalled()
  })
})
