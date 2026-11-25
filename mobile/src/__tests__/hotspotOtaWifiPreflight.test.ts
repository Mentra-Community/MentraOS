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
jest.mock("@react-native-community/netinfo", () => ({__esModule: true, default: {fetch: jest.fn()}}))
jest.mock("../../modules/engine/src/services/OtaArtifactDownloader", () => ({
  planArtifacts: jest.fn(() => []),
  prepareArtifacts: jest.fn(async () => []),
  cleanupArtifacts: jest.fn(async () => {}),
  rewriteManifestForLocalServer: jest.fn(() => "{}"),
  OtaArtifactError: class extends Error {},
}))
jest.mock("../../modules/engine/src/services/asg/localNetworkTransport", () => ({
  localNetworkErrorDetails: jest.fn(() => ({})),
}))
jest.mock("../../modules/engine/src/services/HotspotGlassesIdentity", () => ({
  joinedGlassesIdentity: jest.fn(async () => "same_glasses"),
}))
const binding = {ssid: "A", password: "password", gateway: "192.168.43.1", phoneIpv4: "192.168.43.2"}
jest.mock("../../modules/engine/src/services/GlassesWifi", () => {
  class GlassesWifiError extends Error {
    stage: "enable" | "join"
    cause: Error & {code?: string}
    code?: string
    constructor(stage: "enable" | "join", cause: Error & {code?: string}) {
      super(cause.message)
      this.stage = stage
      this.cause = cause
      this.code = cause.code
    }
  }
  return {GlassesWifiError, holdGlassesWifi: jest.fn()}
})
jest.mock("@mentra/bluetooth-sdk/ota-transport", () => ({
  otaServer: {
    start: jest.fn(async () => ({
      host: "192.168.43.2",
      baseUrl: "http://192.168.43.2",
      manifestUrl: "http://192.168.43.2/version.json",
    })),
    stop: jest.fn(async () => {}),
  },
}))

const wifi = jest.requireMock("react-native-wifi-reborn").default as {isEnabled: jest.Mock}
const netInfo = jest.requireMock("@react-native-community/netinfo").default as {fetch: jest.Mock}
const wifiInternet = {type: "wifi", isConnected: true, isInternetReachable: true}
const downloader = jest.requireMock("../../modules/engine/src/services/OtaArtifactDownloader")
const service = jest.requireMock("../../modules/engine/src/services/GlassesWifi")
const check = {manifestBody: "{}"} as OtaCheckCurrentGlassesResult
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
  netInfo.fetch.mockReset().mockResolvedValue(wifiInternet)
  delete mockSeams.requestPhoneWifiEnable
  downloader.prepareArtifacts.mockClear()
  service.holdGlassesWifi.mockReset().mockImplementation(async () => ({
    binding,
    onChange: () => () => {},
    ready: async () => binding,
    release: async () => {},
  }))
})
afterEach(async () => {
  await hotspotOtaTransport.teardown()
  stopOtaDeviceSession()
})

it("asks for Wi-Fi before downloading and continues once Wi-Fi carries the internet", async () => {
  wifi.isEnabled.mockResolvedValueOnce(false)
  mockSeams.requestPhoneWifiEnable = jest.fn(async () => {
    expect(downloader.prepareArtifacts).not.toHaveBeenCalled()
    return {enabled: true, cancelled: false}
  })
  // The radio is on but cellular is still the route; downloading now would drop on the switch.
  netInfo.fetch.mockResolvedValueOnce({type: "cellular", isConnected: true, isInternetReachable: true})
  netInfo.fetch.mockImplementationOnce(async () => {
    expect(downloader.prepareArtifacts).not.toHaveBeenCalled()
    return wifiInternet
  })
  expect(await hotspotOtaTransport.prepare(check)).toBe("http://192.168.43.2/version.json")
  expect(mockSeams.requestPhoneWifiEnable).toHaveBeenCalledTimes(1)
  expect(netInfo.fetch).toHaveBeenCalledTimes(2)
  expect(downloader.prepareArtifacts).toHaveBeenCalledTimes(1)
  expect(service.holdGlassesWifi).toHaveBeenCalledTimes(1)
})

it("fails as Wi-Fi off, before the download or glasses hotspot, when the prompt is declined", async () => {
  wifi.isEnabled.mockResolvedValue(false)
  mockSeams.requestPhoneWifiEnable = jest.fn(async () => ({enabled: false, cancelled: true}))
  await expect(hotspotOtaTransport.prepare(check)).rejects.toMatchObject({code: "hotspot_wifi_disabled"})
  expect(downloader.prepareArtifacts).not.toHaveBeenCalled()
  expect(service.holdGlassesWifi).not.toHaveBeenCalled()
})

it("fails as Wi-Fi off when the host has no Wi-Fi prompt or cannot show it", async () => {
  wifi.isEnabled.mockResolvedValue(false)
  await expect(hotspotOtaTransport.prepare(check)).rejects.toMatchObject({code: "hotspot_wifi_disabled"})
  mockSeams.requestPhoneWifiEnable = jest.fn(async () => {
    throw Object.assign(new Error("background"), {code: "REQUEST_ABORTED"})
  })
  await expect(hotspotOtaTransport.prepare(check)).rejects.toMatchObject({code: "hotspot_wifi_disabled"})
  expect(service.holdGlassesWifi).not.toHaveBeenCalled()
})

it("reports Wi-Fi off when the radio goes off before the hotspot join", async () => {
  service.holdGlassesWifi.mockImplementationOnce(async () => {
    wifi.isEnabled.mockResolvedValue(false)
    throw new service.GlassesWifiError("join", new Error("Could not connect to A"))
  })
  await expect(hotspotOtaTransport.prepare(check)).rejects.toMatchObject({code: "hotspot_wifi_disabled"})
})

it("keeps a join failure with Wi-Fi on as a join failure", async () => {
  service.holdGlassesWifi.mockRejectedValueOnce(new service.GlassesWifiError("join", new Error("Could not connect to A")))
  await expect(hotspotOtaTransport.prepare(check)).rejects.toMatchObject({code: "hotspot_join_failed"})
})

it("does not probe the radio on iOS, which cannot read it", async () => {
  platform = "ios"
  await hotspotOtaTransport.prepare(check)
  expect(wifi.isEnabled).not.toHaveBeenCalled()
})
