// Imports the real glasses facade by path (not via "@mentra/engine", which jest
// mocks) so the actual projection + delegation run under the mobile jest runner.
import BluetoothSdk from "@mentra/bluetooth-sdk-internal"
import {dev} from "../../modules/engine/src/facades/dev"
import {glasses} from "../../modules/engine/src/facades/glasses"
import {useCloudClientStatusStore} from "../../modules/engine/src/stores/cloudClientStatus"
import {WebSocketStatus, useConnectionStore} from "../../modules/engine/src/stores/connection"
import {useCoreStore} from "../../modules/engine/src/stores/core"
import {useGlassesStore} from "../../modules/engine/src/stores/glasses"

describe("glasses facade", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    useGlassesStore.getState().reset()
    useCoreStore.getState().reset()
    useConnectionStore.getState().reset()
    useCloudClientStatusStore.getState().reset()
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
    useGlassesStore.setState({
      deviceModel: "Even Realities G1",
      firmwareVersion: "1.2.3",
      serialNumber: "SN1",
      bluetoothName: "MentraLive_664ebf",
      appVersion: "39",
      wifi: {state: "connected", ssid: "home", localIp: "192.168.1.5"},
    })
    const info = glasses.info()
    expect(info.model).toBe("Even Realities G1")
    expect(info.firmwareVersion).toBe("1.2.3")
    expect(info.serialNumber).toBe("SN1")
    expect(info.bluetoothName).toBe("MentraLive_664ebf")
    expect(info.appVersion).toBe("39")
    expect(info.wifi).toEqual({state: "connected", ssid: "home", localIp: "192.168.1.5"})
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

  it("onInfo() fires only when projected device info changes", () => {
    const cb = jest.fn()
    const unsub = glasses.onInfo(cb)
    useGlassesStore.setState({batteryLevel: 42})
    expect(cb).not.toHaveBeenCalled()
    useGlassesStore.setState({bluetoothName: "MentraLive_664ebf"})
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({bluetoothName: "MentraLive_664ebf"}))
    unsub()
    cb.mockClear()
    useGlassesStore.setState({bluetoothName: "MentraLive_aaaaaa"})
    expect(cb).not.toHaveBeenCalled()
  })

  it("controller.status() projects controller state", () => {
    useGlassesStore.setState({
      controllerConnected: true,
      controllerFullyBooted: true,
      controllerBatteryLevel: 88,
      controllerSignalStrength: -55,
    })
    expect(glasses.controller.status()).toEqual({
      connected: true,
      fullyBooted: true,
      battery: 88,
      signal: -55,
    })
  })

  it("dev.runtimeStatus() projects island debug state", () => {
    useCoreStore.getState().setCoreInfo({
      searching: true,
      currentMic: "glasses",
      systemMicUnavailable: true,
    })
    useGlassesStore.setState({
      connection: {state: "connected", fullyBooted: true} as never,
      bluetoothClassicConnected: true,
    })
    useConnectionStore.getState().setStatus(WebSocketStatus.CONNECTED)
    useCloudClientStatusStore.getState().setSnapshot({status: "connected", audioTransport: "udp"})

    expect(dev.runtimeStatus()).toEqual(
      expect.objectContaining({
        searching: true,
        currentMic: "glasses",
        systemMicUnavailable: true,
        glassesConnected: true,
        glassesFullyBooted: true,
        bluetoothClassicConnected: true,
        coreStatus: "connected",
        cloudClientStatus: "connected",
        cloudClientAudioTransport: "udp",
      }),
    )
  })
})
