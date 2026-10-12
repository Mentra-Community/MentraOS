import {hotspotOtaTransport} from "../../modules/engine/src/services/HotspotOtaTransport"
import {startOtaDeviceSession, stopOtaDeviceSession} from "../../modules/engine/src/services/OtaDeviceSession"
import type {OtaCheckCurrentGlassesResult} from "../../modules/engine/src/services/OtaUpdateCheckService"
import {bluetoothSdkMock, emitBluetoothSdkEvent, resetBluetoothSdkMock} from "../test-utils/mockBluetoothSdk"

jest.mock("../../modules/engine/src/services/OtaArtifactDownloader", () => ({
  planArtifacts: jest.fn(() => []),
  prepareArtifacts: jest.fn(async () => []),
  cleanupArtifacts: jest.fn(async () => {}),
  rewriteManifestForLocalServer: jest.fn(() => "{}"),
  OtaArtifactError: class extends Error {},
}))
jest.mock("../../modules/engine/src/services/asg/localNetworkTransport", () => ({
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
const downloader = jest.requireMock("../../modules/engine/src/services/OtaArtifactDownloader")
const localNetwork = jest.requireMock(
  "../../modules/engine/src/services/asg/localNetworkTransport",
).localNetworkTransport
const server = jest.requireMock("@mentra/bluetooth-sdk/ota-transport").otaServer
const pair = (address: string) => ({id: address, address, model: "Mentra Live", name: address})
const check = {manifestBody: "{}"} as OtaCheckCurrentGlassesResult

beforeEach(async () => {
  resetBluetoothSdkMock()
  stopOtaDeviceSession()
  ;(bluetoothSdkMock.getDefaultDevice as jest.Mock).mockResolvedValue(pair("A"))
  await startOtaDeviceSession()
  downloader.prepareArtifacts.mockReset().mockResolvedValue([])
  downloader.cleanupArtifacts.mockClear()
  localNetwork.connect.mockClear()
  localNetwork.disconnect.mockClear()
  server.start.mockClear()
  server.stop.mockClear()
})
afterEach(async () => {
  await hotspotOtaTransport.teardown(false)
  stopOtaDeviceSession()
})

it("cancels after download without enabling the replacement pair's hotspot", async () => {
  let resolve!: (artifacts: unknown[]) => void
  downloader.prepareArtifacts.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r
    }),
  )
  const preparing = hotspotOtaTransport.prepare(check)
  const outcome = preparing.catch((error: Error) => error)
  await Promise.resolve()
  await Promise.resolve()
  emitBluetoothSdkEvent("default_device_changed", {device: pair("B")})
  const cleanup = hotspotOtaTransport.teardown(false)
  resolve([])
  expect(await outcome).toEqual(expect.objectContaining({message: expect.stringContaining("glasses have changed")}))
  await cleanup
  expect(bluetoothSdkMock.setHotspotState).not.toHaveBeenCalled()
  expect(server.start).not.toHaveBeenCalled()
  expect(downloader.cleanupArtifacts).toHaveBeenCalled()
})

it("joins cancelled network work before cleanup and never disables the new glasses", async () => {
  let resolve!: (address: string) => void
  localNetwork.connect.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r
    }),
  )
  bluetoothSdkMock.setHotspotState.mockResolvedValueOnce({
    type: "hotspot_status",
    state: "enabled",
    ssid: "A",
    password: "password",
    localIp: "192.168.43.1",
  })
  const preparing = hotspotOtaTransport.prepare(check)
  const outcome = preparing.catch((error: Error) => error)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(localNetwork.connect).toHaveBeenCalled()
  emitBluetoothSdkEvent("default_device_changed", {device: pair("B")})
  const cleanup = hotspotOtaTransport.teardown(false)
  expect(localNetwork.disconnect).not.toHaveBeenCalled()
  resolve("192.168.43.2")
  expect(await outcome).toEqual(expect.objectContaining({message: expect.stringContaining("glasses have changed")}))
  await cleanup
  expect(localNetwork.disconnect).toHaveBeenCalledTimes(1)
  expect(bluetoothSdkMock.setHotspotState).toHaveBeenCalledTimes(1)
  expect(server.start).not.toHaveBeenCalled()
})

it("keeps normal same-pair hotspot preparation and cleanup working", async () => {
  bluetoothSdkMock.setHotspotState.mockResolvedValueOnce({
    type: "hotspot_status",
    state: "enabled",
    ssid: "A",
    password: "password",
    localIp: "192.168.43.1",
  })
  expect(await hotspotOtaTransport.prepare(check)).toBe("http://192.168.43.2/version.json")
  bluetoothSdkMock.setHotspotState.mockResolvedValueOnce({type: "hotspot_status", state: "disabled"})
  await hotspotOtaTransport.teardown()
  expect(bluetoothSdkMock.setHotspotState).toHaveBeenLastCalledWith(false)
  expect(server.stop).toHaveBeenCalledTimes(1)
  expect(localNetwork.disconnect).toHaveBeenCalledTimes(1)
})
