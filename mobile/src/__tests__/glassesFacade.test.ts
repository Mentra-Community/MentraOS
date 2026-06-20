// Imports the real glasses facade by path (not via "@mentra/island", which jest
// mocks) so the actual projection + delegation run under the mobile jest runner.
import BluetoothSdk from "@mentra/bluetooth-sdk-internal"
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
    expect(st.connected).toBe(true)
    expect(st.ready).toBe(true)
    expect(st.state).toBe("connected")
    expect(st.fullyBooted).toBe(true)
    expect(st.battery).toBe(80)
    expect(st.charging).toBe(true)
    expect(st.micEnabled).toBe(true)
    expect(st.btClassic).toBe(true)
  })

  it("info() projects device info from the store", () => {
    useGlassesStore.setState({
      deviceModel: "Even Realities G1",
      firmwareVersion: "1.2.3",
      serialNumber: "SN1",
      bluetoothName: "Mentra_SN1",
      androidVersion: "13",
      appVersion: "1.0.0",
    })
    const info = glasses.info()
    expect(info.model).toBe("Even Realities G1")
    expect(info.deviceModel).toBe("Even Realities G1")
    expect(info.firmwareVersion).toBe("1.2.3")
    expect(info.serialNumber).toBe("SN1")
    expect(info.bluetoothName).toBe("Mentra_SN1")
    expect(info.androidVersion).toBe("13")
    expect(info.appVersion).toBe("1.0.0")
  })

  it("diagnostics() strips store mutators and redacts hotspot secrets", () => {
    useGlassesStore.setState({
      hotspot: {state: "enabled", ssid: "Mentra", password: "secret", localIp: "192.168.0.1"},
    })
    const diagnostics = glasses.diagnostics()
    expect("setGlassesInfo" in diagnostics).toBe(false)
    expect(diagnostics.hotspot).toEqual({
      state: "enabled",
      ssid: "Mentra",
      password: "[redacted]",
      localIp: "192.168.0.1",
    })
  })

  it("controller.status() projects controller fields", () => {
    useGlassesStore.setState({
      controllerConnected: true,
      controllerFullyBooted: true,
      controllerMacAddress: "AA:BB",
      controllerBatteryLevel: 91,
      controllerSignalStrength: -44,
    })
    expect(glasses.controller.status()).toEqual({
      connected: true,
      fullyBooted: true,
      macAddress: "AA:BB",
      battery: 91,
      signal: -44,
    })
  })

  it("connectDefault / disconnect / forget delegate to bluetooth-sdk", async () => {
    await glasses.connectDefault()
    expect(BluetoothSdk.connectDefault).toHaveBeenCalled()
    await glasses.disconnect()
    expect(BluetoothSdk.disconnect).toHaveBeenCalled()
    await glasses.forget()
    expect(BluetoothSdk.forget).toHaveBeenCalled()
  })

  it("connectDefault() seeds the phone's device settings to native before connecting", async () => {
    await glasses.connectDefault()
    // The pre-connect seed (moved out of the host Reconnect flow) must land first.
    expect(BluetoothSdk.updateBluetoothSettings).toHaveBeenCalled()
    expect((BluetoothSdk.updateBluetoothSettings as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (BluetoothSdk.connectDefault as jest.Mock).mock.invocationCallOrder[0],
    )
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
