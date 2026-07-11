// Imports the real glasses.wifi facade by path (not via "@mentra/engine", which
// jest mocks) so the actual delegation runs under the mobile jest CI runner.
// @mentra/bluetooth-sdk is globally mocked in jest.setup.js — the facade calls it.
import BluetoothSdk from "@mentra/bluetooth-sdk"
import {glassesWifi} from "../../modules/engine/src/facades/glassesWifi"
import {useGlassesStore} from "../../modules/engine/src/stores/glasses"

describe("glassesWifi facade", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("scan() delegates to requestWifiScan and returns its results", async () => {
    const networks = [{ssid: "home", requiresPassword: true, signalStrength: -40}]
    ;(BluetoothSdk.requestWifiScan as jest.Mock).mockResolvedValueOnce(networks)
    await expect(glassesWifi.scan()).resolves.toEqual(networks)
    expect(BluetoothSdk.requestWifiScan).toHaveBeenCalledTimes(1)
  })

  it("connect() delegates to sendWifiCredentials with ssid + password", async () => {
    await glassesWifi.connect("home", "hunter2")
    expect(BluetoothSdk.sendWifiCredentials).toHaveBeenCalledWith("home", "hunter2")
  })

  it("connect() propagates the bluetooth-sdk coded error unchanged", async () => {
    const err = Object.assign(new Error("bt off"), {code: "bluetooth_powered_off"})
    ;(BluetoothSdk.sendWifiCredentials as jest.Mock).mockRejectedValueOnce(err)
    await expect(glassesWifi.connect("home", "x")).rejects.toBe(err)
  })

  it("forget() delegates to forgetWifiNetwork", async () => {
    await glassesWifi.forget("home")
    expect(BluetoothSdk.forgetWifiNetwork).toHaveBeenCalledWith("home")
  })

  it("status() reads the glasses store's wifi state", () => {
    useGlassesStore.setState({wifi: {state: "connected", ssid: "home"}})
    expect(glassesWifi.status()).toEqual({state: "connected", ssid: "home"})
  })

  it("onStatus() fires on wifi change and stops after unsubscribe", () => {
    useGlassesStore.setState({wifi: {state: "disconnected"}})
    const cb = jest.fn()
    const unsub = glassesWifi.onStatus(cb)
    useGlassesStore.setState({wifi: {state: "connected", ssid: "home"}})
    expect(cb).toHaveBeenCalledWith({state: "connected", ssid: "home"}, {state: "disconnected"})
    unsub()
    useGlassesStore.setState({wifi: {state: "disconnected"}})
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
