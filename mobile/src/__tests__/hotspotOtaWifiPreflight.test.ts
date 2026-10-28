import {PermissionsAndroid, Platform} from "react-native"

import {bluetoothSdkMock, resetBluetoothSdkMock} from "@/test-utils/mockBluetoothSdk"

import {hotspotOtaTransport} from "../../modules/engine/src/services/HotspotOtaTransport"
import {startOtaDeviceSession, stopOtaDeviceSession} from "../../modules/engine/src/services/OtaDeviceSession"
import type {OtaCheckCurrentGlassesResult} from "../../modules/engine/src/services/OtaUpdateCheckService"

const mockSeams: {requestPhoneWifiEnable?: jest.Mock} = {}
jest.mock("../../modules/engine/src/runtime/bootstrap", () => ({
  ...jest.requireActual("../../modules/engine/src/runtime/bootstrap"),
  getUiSeams: () => mockSeams,
}))
jest.mock("react-native-wifi-reborn", () => ({__esModule: true, default: {isEnabled: jest.fn()}}))
jest.mock("../../modules/engine/src/services/OtaArtifactDownloader", () => ({
  planArtifacts: jest.fn(() => []),
  prepareArtifacts: jest.fn(async () => []),
  cleanupArtifacts: jest.fn(async () => {}),
  rewriteManifestForLocalServer: jest.fn(() => "{}"),
  OtaArtifactError: class extends Error {},
}))
jest.mock("../../modules/engine/src/services/asg/localNetworkTransport", () => ({
  localNetworkErrorDetails: jest.fn(() => ({})),
  localNetworkTransport: {connect: jest.fn(async () => "192.168.43.2"), disconnect: jest.fn(async () => {})},
}))
jest.mock("@mentra/bluetooth-sdk/ota-transport", () => ({
  otaServer: {
    start: jest.fn(async () => ({
      host: "192.168.43.2",
      baseUrl: "http://192.168.43.2",
      manifestUrl: "http://192.168.43.2/version.json",
    })),
    stop: jest.fn(async () => {}),
    waitForWifiAddress: jest.fn(async () => "192.168.43.2"),
  },
}))

const wifi = jest.requireMock("react-native-wifi-reborn").default as {isEnabled: jest.Mock}
const downloader = jest.requireMock("../../modules/engine/src/services/OtaArtifactDownloader")
const localNetwork = jest.requireMock(
  "../../modules/engine/src/services/asg/localNetworkTransport",
).localNetworkTransport
const check = {manifestBody: "{}"} as OtaCheckCurrentGlassesResult
const enabledHotspot = {
  type: "hotspot_status",
  state: "enabled",
  ssid: "A",
  password: "password",
  localIp: "192.168.43.1",
}
let platform = "android"

beforeAll(() => {
  Object.defineProperty(Platform, "OS", {configurable: true, get: () => platform})
})
beforeEach(async () => {
  platform = "android"
  resetBluetoothSdkMock()
  stopOtaDeviceSession()
  ;(bluetoothSdkMock.getDefaultDevice as jest.Mock).mockResolvedValue({
    id: "A",
    address: "A",
    model: "Mentra Live",
    name: "A",
  })
  await startOtaDeviceSession()
  jest.spyOn(PermissionsAndroid, "check").mockResolvedValue(true)
  wifi.isEnabled.mockReset().mockResolvedValue(true)
  delete mockSeams.requestPhoneWifiEnable
  downloader.prepareArtifacts.mockClear()
  localNetwork.connect.mockClear()
})
afterEach(async () => {
  await hotspotOtaTransport.teardown(false)
  stopOtaDeviceSession()
})

it("asks for Wi-Fi before downloading and continues once it is on", async () => {
  wifi.isEnabled.mockResolvedValueOnce(false)
  mockSeams.requestPhoneWifiEnable = jest.fn(async () => {
    expect(downloader.prepareArtifacts).not.toHaveBeenCalled()
    return {enabled: true, cancelled: false}
  })
  bluetoothSdkMock.setHotspotState.mockResolvedValueOnce(enabledHotspot)
  expect(await hotspotOtaTransport.prepare(check)).toBe("http://192.168.43.2/version.json")
  expect(mockSeams.requestPhoneWifiEnable).toHaveBeenCalledTimes(1)
  expect(localNetwork.connect).toHaveBeenCalledTimes(1)
})

it("fails as Wi-Fi off, before the download or glasses hotspot, when the prompt is declined", async () => {
  wifi.isEnabled.mockResolvedValue(false)
  mockSeams.requestPhoneWifiEnable = jest.fn(async () => ({enabled: false, cancelled: true}))
  await expect(hotspotOtaTransport.prepare(check)).rejects.toMatchObject({code: "hotspot_wifi_disabled"})
  expect(downloader.prepareArtifacts).not.toHaveBeenCalled()
  expect(bluetoothSdkMock.setHotspotState).not.toHaveBeenCalled()
})

it("fails as Wi-Fi off when the host has no Wi-Fi prompt or cannot show it", async () => {
  wifi.isEnabled.mockResolvedValue(false)
  await expect(hotspotOtaTransport.prepare(check)).rejects.toMatchObject({code: "hotspot_wifi_disabled"})
  mockSeams.requestPhoneWifiEnable = jest.fn(async () => {
    throw Object.assign(new Error("background"), {code: "REQUEST_ABORTED"})
  })
  await expect(hotspotOtaTransport.prepare(check)).rejects.toMatchObject({code: "hotspot_wifi_disabled"})
  expect(bluetoothSdkMock.setHotspotState).not.toHaveBeenCalled()
})

it("reports Wi-Fi off when the radio goes off before the hotspot join", async () => {
  bluetoothSdkMock.setHotspotState
    .mockResolvedValueOnce(enabledHotspot)
    .mockResolvedValueOnce({type: "hotspot_status", state: "disabled"})
  localNetwork.connect.mockImplementationOnce(async () => {
    wifi.isEnabled.mockResolvedValue(false)
    throw Object.assign(new Error("Could not connect to A"), {code: "ERR_LOCAL_WIFI_UNAVAILABLE"})
  })
  await expect(hotspotOtaTransport.prepare(check)).rejects.toMatchObject({code: "hotspot_wifi_disabled"})
})

it("keeps a join failure with Wi-Fi on as a join failure", async () => {
  bluetoothSdkMock.setHotspotState
    .mockResolvedValueOnce(enabledHotspot)
    .mockResolvedValueOnce({type: "hotspot_status", state: "disabled"})
  localNetwork.connect.mockRejectedValueOnce(new Error("Could not connect to A"))
  await expect(hotspotOtaTransport.prepare(check)).rejects.toMatchObject({code: "hotspot_join_failed"})
})

it("does not probe the radio on iOS, which cannot read it", async () => {
  platform = "ios"
  bluetoothSdkMock.setHotspotState.mockResolvedValueOnce(enabledHotspot)
  await hotspotOtaTransport.prepare(check)
  expect(wifi.isEnabled).not.toHaveBeenCalled()
})
