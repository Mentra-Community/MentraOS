import {HotspotOtaTransportError, hotspotOtaTransport} from "../../modules/engine/src/services/HotspotOtaTransport"
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
  localNetworkErrorDetails: jest.fn(() => ({code: "ERR_HOTSPOT_JOIN", message: "Hotspot join timed out"})),
}))
// The glasses Wi-Fi service owns the hotspot and the join; OTA only holds the link it gives.
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
jest.mock("../../modules/engine/src/services/HotspotGlassesIdentity", () => ({
  joinedGlassesIdentity: jest.fn(async () => "same_glasses"),
}))
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
const downloader = jest.requireMock("../../modules/engine/src/services/OtaArtifactDownloader")
const service = jest.requireMock("../../modules/engine/src/services/GlassesWifi")
const identity = jest.requireMock("../../modules/engine/src/services/HotspotGlassesIdentity")
const localNetworkMock = jest.requireMock("../../modules/engine/src/services/asg/localNetworkTransport")
const server = jest.requireMock("@mentra/bluetooth-sdk/ota-transport").otaServer
const pair = (address: string) => ({id: address, address, model: "Mentra Live", name: address})
const check = {manifestBody: "{}"} as OtaCheckCurrentGlassesResult
const binding = {ssid: "A", password: "password", gateway: "192.168.43.1", phoneIpv4: "192.168.43.2"}
let release: jest.Mock

beforeEach(async () => {
  resetBluetoothSdkMock()
  stopOtaDeviceSession()
  ;(bluetoothSdkMock.getDefaultDevice as jest.Mock).mockResolvedValue(pair("A"))
  await startOtaDeviceSession()
  downloader.prepareArtifacts.mockReset().mockResolvedValue([])
  downloader.cleanupArtifacts.mockClear()
  release = jest.fn(async () => {})
  service.holdGlassesWifi.mockReset().mockImplementation(async () => ({
    binding,
    onChange: () => () => {},
    ready: async () => binding,
    release,
  }))
  identity.joinedGlassesIdentity.mockReset().mockResolvedValue("same_glasses")
  server.start.mockClear()
  server.stop.mockReset().mockResolvedValue(undefined)
})
afterEach(async () => {
  await hotspotOtaTransport.teardown()
  stopOtaDeviceSession()
})

it("cancels after download without holding the replacement pair's link", async () => {
  let resolve!: (artifacts: unknown[]) => void
  downloader.prepareArtifacts.mockReturnValueOnce(new Promise((r) => (resolve = r)))
  const outcome = hotspotOtaTransport.prepare(check).catch((error: Error) => error)
  await Promise.resolve()
  await Promise.resolve()
  emitBluetoothSdkEvent("default_device_changed", {device: pair("B")})
  const cleanup = hotspotOtaTransport.teardown()
  resolve([])
  expect(await outcome).toEqual(expect.objectContaining({message: expect.stringContaining("glasses have changed")}))
  await cleanup
  expect(service.holdGlassesWifi).not.toHaveBeenCalled()
  expect(server.start).not.toHaveBeenCalled()
  expect(downloader.cleanupArtifacts).toHaveBeenCalled()
})

it("holds the link for the glasses to download from, serves on the phone's address, and releases it", async () => {
  expect(await hotspotOtaTransport.prepare(check)).toBe("http://192.168.43.2/version.json")
  expect(service.holdGlassesWifi).toHaveBeenCalledWith(
    expect.objectContaining({consumer: "hotspot-ota", purpose: "incoming-server"}),
  )
  expect(server.start).toHaveBeenCalledWith("{}", {}, "192.168.43.2")
  await hotspotOtaTransport.teardown()
  expect(server.stop).toHaveBeenCalledTimes(1)
  expect(release).toHaveBeenCalledTimes(1)
})

it("teardown gives back a hold still waiting on the person", async () => {
  service.holdGlassesWifi.mockImplementationOnce(
    ({signal}: {signal: AbortSignal}) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("hold cancelled")))),
  )
  const outcome = hotspotOtaTransport.prepare(check).catch((error: Error) => error)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(service.holdGlassesWifi).toHaveBeenCalled()
  await hotspotOtaTransport.teardown()
  expect(await outcome).toEqual(expect.objectContaining({message: expect.stringContaining("cancelled")}))
  expect(server.start).not.toHaveBeenCalled()
})

it("does not publish an OTA URL when the incoming listener fails, and releases the link", async () => {
  server.start.mockRejectedValueOnce(new Error("Listener could not bind"))
  await expect(hotspotOtaTransport.prepare(check)).rejects.toMatchObject({code: "hotspot_server_failed"})
  expect(server.start).toHaveBeenCalledTimes(1)
  expect(release).toHaveBeenCalledTimes(1)
})

it("names a hotspot failure and a join failure apart, keeping the native join's facts", async () => {
  const {GlassesWifiError} = service
  service.holdGlassesWifi.mockRejectedValueOnce(new GlassesWifiError("enable", new Error("hotspot did not start")))
  await expect(hotspotOtaTransport.prepare(check)).rejects.toMatchObject({code: "hotspot_start_failed"})

  const nativeFailure = Object.assign(new Error("Hotspot join timed out"), {code: "ERR_HOTSPOT_JOIN"})
  service.holdGlassesWifi.mockRejectedValueOnce(new GlassesWifiError("join", nativeFailure))
  const failure = await hotspotOtaTransport.prepare(check).catch((error) => error)
  expect(failure).toBeInstanceOf(HotspotOtaTransportError)
  expect(JSON.parse(JSON.stringify(failure))).toMatchObject({
    code: "hotspot_join_failed",
    nativeError: {code: "ERR_HOTSPOT_JOIN", message: "Hotspot join timed out"},
  })
  expect(downloader.prepareArtifacts).toHaveBeenCalledTimes(2)
  expect(server.start).not.toHaveBeenCalled()
})

it("names Mac Location access when it blocks identifying the glasses hotspot", async () => {
  localNetworkMock.localNetworkErrorDetails.mockReturnValueOnce({
    code: "ERR_HOTSPOT_JOIN",
    message: "Location access is required to identify the glasses hotspot on Mac [location raw=2]",
  })
  service.holdGlassesWifi.mockRejectedValueOnce(
    new service.GlassesWifiError("join", new Error("Location access is required")),
  )
  await expect(hotspotOtaTransport.prepare(check)).rejects.toMatchObject({code: "hotspot_location_denied"})
})

it("leaves another pair's network and holds again, then gives up", async () => {
  identity.joinedGlassesIdentity.mockResolvedValue("other_glasses")
  await expect(hotspotOtaTransport.prepare(check)).rejects.toMatchObject({code: "hotspot_other_glasses"})
  expect(service.holdGlassesWifi).toHaveBeenCalledTimes(3)
  expect(release).toHaveBeenCalledTimes(3)
})

it("retains a failed server stop, and releases the link only once the server stops", async () => {
  await hotspotOtaTransport.prepare(check)
  const failure = new Error("server stop refused")
  server.stop.mockRejectedValueOnce(failure)
  await expect(hotspotOtaTransport.teardown()).rejects.toBe(failure)
  expect(release).not.toHaveBeenCalled()
  expect(downloader.cleanupArtifacts).not.toHaveBeenCalled()
  // The next attempt finishes the leftover cleanup first, then prepares normally.
  expect(await hotspotOtaTransport.prepare(check)).toBe("http://192.168.43.2/version.json")
  expect(server.stop).toHaveBeenCalledTimes(2)
  expect(release).toHaveBeenCalledTimes(1)
  expect(downloader.cleanupArtifacts).toHaveBeenCalledTimes(1)
})
