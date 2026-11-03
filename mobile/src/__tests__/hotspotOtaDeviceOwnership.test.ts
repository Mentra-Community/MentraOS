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
  localNetworkErrorDetails: jest.fn(() => ({
    native: {domain: "NEHotspotConfigurationErrorDomain", code: 8, completed: true},
  })),
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
  localNetwork.disconnect.mockReset().mockResolvedValue(undefined)
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
  expect(localNetwork.connect).toHaveBeenCalledWith(
    expect.any(Symbol),
    "A",
    "password",
    expect.objectContaining({
      gateway: "192.168.43.1",
      purpose: "incoming-server",
    }),
  )
  expect(server.start).toHaveBeenCalledWith("{}", {}, "192.168.43.2")
  bluetoothSdkMock.setHotspotState.mockResolvedValueOnce({type: "hotspot_status", state: "disabled"})
  await hotspotOtaTransport.teardown()
  expect(bluetoothSdkMock.setHotspotState).toHaveBeenLastCalledWith(false)
  expect(server.stop).toHaveBeenCalledTimes(1)
  expect(localNetwork.disconnect).toHaveBeenCalledTimes(1)
})

it("does not publish an OTA URL when the incoming listener fails after association", async () => {
  bluetoothSdkMock.setHotspotState
    .mockResolvedValueOnce({
      type: "hotspot_status",
      state: "enabled",
      ssid: "A",
      password: "password",
      localIp: "192.168.43.1",
    })
    .mockResolvedValueOnce({type: "hotspot_status", state: "disabled"})
  server.start.mockRejectedValueOnce(new Error("Listener could not bind"))
  await expect(hotspotOtaTransport.prepare(check)).rejects.toMatchObject({code: "hotspot_server_failed"})
  expect(server.start).toHaveBeenCalledTimes(1)
  expect(localNetwork.disconnect).toHaveBeenCalledTimes(1)
  expect(bluetoothSdkMock.setHotspotState).toHaveBeenLastCalledWith(false)
})

it("retains terminal native join facts and does not repeat downloads or enable requests", async () => {
  const nativeFailure = Object.assign(new Error("internal error"), {code: "unableToConnect"})
  bluetoothSdkMock.setHotspotState.mockResolvedValueOnce({
    type: "hotspot_status",
    state: "enabled",
    ssid: "A",
    password: "password",
    localIp: "192.168.43.1",
  })
  localNetwork.connect.mockRejectedValueOnce(nativeFailure)
  const failure = await hotspotOtaTransport.prepare(check).catch((error) => error)
  expect(failure).toBeInstanceOf(HotspotOtaTransportError)
  expect(JSON.parse(JSON.stringify(failure))).toMatchObject({
    code: "hotspot_join_failed",
    nativeError: {
      native: {domain: "NEHotspotConfigurationErrorDomain", code: 8, completed: true},
    },
  })
  expect(localNetwork.connect).toHaveBeenCalledWith(expect.any(Symbol), "A", "password", {
    retryIosInternalError: true,
    assertCurrent: expect.any(Function),
    gateway: "192.168.43.1",
    purpose: "incoming-server",
  })
  expect(downloader.prepareArtifacts).toHaveBeenCalledTimes(1)
  expect(server.start).not.toHaveBeenCalled()
})

it("retains failed network cleanup and drains other teardown before retry", async () => {
  bluetoothSdkMock.setHotspotState.mockResolvedValueOnce({
    type: "hotspot_status",
    state: "enabled",
    ssid: "A",
    password: "password",
    localIp: "192.168.43.1",
  })
  await hotspotOtaTransport.prepare(check)
  const failure = new Error("Native release did not complete")
  localNetwork.disconnect.mockRejectedValueOnce(failure)
  await expect(hotspotOtaTransport.teardown(false)).rejects.toBe(failure)
  expect(server.stop).toHaveBeenCalledTimes(1)
  expect(downloader.cleanupArtifacts).toHaveBeenCalledTimes(1)
  await expect(hotspotOtaTransport.prepare(check)).rejects.toThrow("still needs cleanup")
  await hotspotOtaTransport.teardown(false)
  expect(localNetwork.disconnect).toHaveBeenCalledTimes(2)
  expect(server.stop).toHaveBeenCalledTimes(1)
})

it("preserves the join failure while retaining a rejected connection's cleanup", async () => {
  bluetoothSdkMock.setHotspotState.mockResolvedValueOnce({
    type: "hotspot_status",
    state: "enabled",
    ssid: "A",
    password: "password",
    localIp: "192.168.43.1",
  })
  localNetwork.connect.mockRejectedValueOnce(new Error("association refused"))
  localNetwork.disconnect.mockRejectedValueOnce(new Error("release refused"))
  await expect(hotspotOtaTransport.prepare(check)).rejects.toMatchObject({
    code: "hotspot_join_failed",
    message: "association refused",
  })
  expect(localNetwork.disconnect).toHaveBeenCalledTimes(1)
  await expect(hotspotOtaTransport.prepare(check)).rejects.toThrow("still needs cleanup")
  await hotspotOtaTransport.teardown(false)
  expect(localNetwork.disconnect).toHaveBeenCalledTimes(2)
})

it("retains a failed server stop while still releasing the network", async () => {
  bluetoothSdkMock.setHotspotState.mockResolvedValueOnce({
    type: "hotspot_status",
    state: "enabled",
    ssid: "A",
    password: "password",
    localIp: "192.168.43.1",
  })
  await hotspotOtaTransport.prepare(check)
  const failure = new Error("server stop refused")
  server.stop.mockRejectedValueOnce(failure)
  await expect(hotspotOtaTransport.teardown(false)).rejects.toBe(failure)
  expect(localNetwork.disconnect).toHaveBeenCalledTimes(1)
  expect(downloader.cleanupArtifacts).not.toHaveBeenCalled()
  await hotspotOtaTransport.teardown(false)
  expect(server.stop).toHaveBeenCalledTimes(2)
  expect(localNetwork.disconnect).toHaveBeenCalledTimes(1)
  expect(downloader.cleanupArtifacts).toHaveBeenCalledTimes(1)
})

it("holds completion and the OTA owner until native returned-network observation settles", async () => {
  bluetoothSdkMock.setHotspotState.mockResolvedValueOnce({
    type: "hotspot_status",
    state: "enabled",
    ssid: "A",
    password: "password",
    localIp: "192.168.43.1",
  })
  await hotspotOtaTransport.prepare(check)
  let settle!: () => void
  let entered!: () => void
  const enteredNativeLeave = new Promise<void>((resolve) => {
    entered = resolve
  })
  localNetwork.disconnect.mockImplementationOnce(() => {
    entered()
    return new Promise<void>((resolve) => {
      settle = resolve
    })
  })
  bluetoothSdkMock.setHotspotState.mockResolvedValueOnce({type: "hotspot_status", state: "disabled"})
  let completed = false
  const cleanup = hotspotOtaTransport.teardown().then(() => {
    completed = true
  })
  await enteredNativeLeave
  expect(localNetwork.disconnect).toHaveBeenCalledWith(expect.any(Symbol), true)
  expect(completed).toBe(false)
  expect(downloader.cleanupArtifacts).not.toHaveBeenCalled()
  let nextStarted = false
  const nextPreparation = hotspotOtaTransport.prepare(check).then(() => {
    nextStarted = true
  })
  for (let i = 0; i < 3; i++) await Promise.resolve()
  expect(nextStarted).toBe(false)
  expect(localNetwork.connect).toHaveBeenCalledTimes(1)
  const alsoWaiting = hotspotOtaTransport.teardown()
  expect(localNetwork.disconnect).toHaveBeenCalledTimes(1)
  settle()
  await Promise.all([cleanup, alsoWaiting])
  expect(completed).toBe(true)
  expect(downloader.cleanupArtifacts).toHaveBeenCalledTimes(1)
  await nextPreparation
  expect(nextStarted).toBe(true)
})

it("a device change during returned-network observation cannot enable the replacement glasses", async () => {
  bluetoothSdkMock.setHotspotState.mockResolvedValueOnce({
    type: "hotspot_status",
    state: "enabled",
    ssid: "A",
    password: "password",
    localIp: "192.168.43.1",
  })
  await hotspotOtaTransport.prepare(check)
  let settle!: () => void
  let entered!: () => void
  const enteredNativeLeave = new Promise<void>((resolve) => {
    entered = resolve
  })
  localNetwork.disconnect.mockImplementationOnce(() => {
    entered()
    return new Promise<void>((resolve) => {
      settle = resolve
    })
  })
  bluetoothSdkMock.setHotspotState.mockResolvedValueOnce({type: "hotspot_status", state: "disabled"})
  const cleanup = hotspotOtaTransport.teardown()
  await enteredNativeLeave
  const nextPreparation = hotspotOtaTransport.prepare(check).catch((error: Error) => error)
  emitBluetoothSdkEvent("default_device_changed", {device: pair("B")})
  expect(bluetoothSdkMock.setHotspotState).toHaveBeenCalledTimes(2)
  settle()
  await cleanup
  expect(await nextPreparation).toEqual(expect.objectContaining({message: "The OTA glasses have changed"}))
  expect(localNetwork.disconnect).toHaveBeenCalledTimes(1)
})
