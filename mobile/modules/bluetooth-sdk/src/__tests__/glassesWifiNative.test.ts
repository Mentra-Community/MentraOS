import {afterEach, beforeEach, describe, expect, it, jest} from "@jest/globals"

import {Platform} from "react-native"

// The phone's native joins, faked on both platforms; tests switch Platform.OS.
const mockPlatform = Platform as {OS: string}

type Listener = (event: {id?: string; systemAnswer?: string; reason?: string}) => void
const mockListeners = new Map<string, Set<Listener>>()
const mockNative = {
  joinHotspot: jest.fn(async (..._args: unknown[]): Promise<string | undefined> => "192.168.43.2"),
  leaveHotspot: jest.fn(async (_id: string) => {}),
  connect: jest.fn(async (ssid: string, _password: string, _incoming: boolean) => ({
    connected: true,
    ssid,
    localAddress: "192.168.43.20",
  })),
  connectWifiDirect: jest.fn(async (_incoming: boolean) => ({
    connected: true,
    ssid: "DIRECT-ML",
    localAddress: "192.168.43.50",
    gateway: "192.168.43.1",
  })),
  disconnect: jest.fn(async () => {}),
  wifiDirectAvailable: jest.fn(() => false),
  cacheDirectory: jest.fn(() => "/data/cache/"),
  download: jest.fn(async (..._args: unknown[]) => ({statusCode: 200, bytesWritten: 3, headers: {}})),
  addListener: jest.fn((event: string, listener: Listener) => {
    if (!mockListeners.has(event)) mockListeners.set(event, new Set())
    mockListeners.get(event)!.add(listener)
    return {remove: () => mockListeners.get(event)?.delete(listener)}
  }),
}
jest.mock("../_private/MentraLocalNetworkModule", () => ({__esModule: true, default: mockNative}))
const emit = (event: string, payload: Parameters<Listener>[0]) => mockListeners.get(event)?.forEach((l) => l(payload))

const link = jest.requireActual<typeof import("../glasses-wifi/native")>("../glasses-wifi/native")

const pending = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return {promise, resolve}
}

describe("iOS hotspot join", () => {
  beforeEach(async () => {
    mockPlatform.OS = "ios"
    await link.leave()
    jest.clearAllMocks()
  })
  afterEach(async () => {
    mockNative.leaveHotspot.mockResolvedValue(undefined)
    await link.leave()
    mockPlatform.OS = "android"
  })

  it("returns the verified address from the native join, for the purpose and channel asked", async () => {
    await expect(
      link.joinHotspot("glasses", "private", {gateway: "192.168.43.1", frequency: 5180, purpose: "incoming-server"}),
    ).resolves.toBe("192.168.43.2")
    expect(mockNative.joinHotspot).toHaveBeenCalledWith(
      expect.any(String),
      "glasses",
      "private",
      "192.168.43.1",
      "incoming-server",
      5180,
    )
    await link.leave()
    expect(mockNative.leaveHotspot).toHaveBeenCalledTimes(1)
  })

  it("reports a Local Network wait for its own join only, until the join settles", async () => {
    const joined = pending<string>()
    mockNative.joinHotspot.mockImplementationOnce(() => joined.promise)
    const onPermissionRequired = jest.fn()
    const joining = link.joinHotspot("glasses", "private", {purpose: "outgoing-client", onPermissionRequired})
    const id = mockNative.joinHotspot.mock.calls[0][0] as string
    emit("hotspotPermissionRequired", {id: "another join", systemAnswer: "denied"})
    expect(onPermissionRequired).not.toHaveBeenCalled()
    emit("hotspotPermissionRequired", {id, systemAnswer: "unsatisfiedReason=localNetworkDenied for 5s"})
    expect(onPermissionRequired).toHaveBeenCalledWith("unsatisfiedReason=localNetworkDenied for 5s")
    joined.resolve("192.168.43.2")
    await joining
    expect(mockListeners.get("hotspotPermissionRequired")?.size ?? 0).toBe(0)
  })

  it("refuses a second join while one is held, and keeps custody until a late completion is left", async () => {
    const joined = pending<string>()
    const left = pending<void>()
    mockNative.joinHotspot.mockImplementationOnce(() => joined.promise)
    mockNative.leaveHotspot.mockImplementationOnce(() => left.promise)
    const joining = link.joinHotspot("glasses", "private", {purpose: "outgoing-client"})
    const failure = expect(joining).rejects.toThrow("superseded")
    const leaving = link.leave()
    await expect(link.joinHotspot("other", "private", {purpose: "outgoing-client"})).rejects.toThrow(
      "not been released",
    )
    joined.resolve("192.168.43.2")
    left.resolve()
    await leaving
    await failure
  })

  it("keeps the original join error when leaving after it also fails, and the next leave frees it", async () => {
    const original = new Error("association refused")
    mockNative.joinHotspot.mockRejectedValueOnce(original)
    mockNative.leaveHotspot.mockRejectedValueOnce(new Error("cleanup refused"))
    await expect(link.joinHotspot("glasses", "private", {purpose: "outgoing-client"})).rejects.toBe(original)
    await expect(link.joinHotspot("other", "private", {purpose: "outgoing-client"})).rejects.toThrow(
      "not been released",
    )
    await link.leave()
    await expect(link.joinHotspot("glasses", "private", {purpose: "outgoing-client"})).resolves.toBe("192.168.43.2")
  })

  it("hears a loss of its own join only", async () => {
    await link.joinHotspot("glasses", "private", {purpose: "outgoing-client"})
    const lost = jest.fn()
    const stop = link.onLost(lost)
    emit("hotspotLost", {id: "another join", reason: "gone"})
    expect(lost).not.toHaveBeenCalled()
    emit("hotspotLost", {id: mockNative.joinHotspot.mock.calls[0][0] as string, reason: "gone"})
    expect(lost).toHaveBeenCalledTimes(1)
    stop()
  })
})

describe("Android joins", () => {
  beforeEach(async () => {
    mockPlatform.OS = "android"
    await link.leave()
    jest.clearAllMocks()
  })

  it("joins the hotspot over a scoped network, telling the native join when the glasses connect to the phone", async () => {
    await expect(link.joinHotspot("glasses", "pw", {purpose: "incoming-server"})).resolves.toBe("192.168.43.20")
    expect(mockNative.connect).toHaveBeenCalledWith("glasses", "pw", true)
    expect(link.isScoped()).toBe(true)
    await link.leave()
    expect(mockNative.disconnect).toHaveBeenCalled()
    expect(link.isScoped()).toBe(false)
  })

  it("joins the Wi-Fi Direct group the glasses send", async () => {
    await expect(link.joinWifiDirect("outgoing-client")).resolves.toMatchObject({gateway: "192.168.43.1"})
    expect(mockNative.connectWifiDirect).toHaveBeenCalledWith(false)
    expect(link.isScoped()).toBe(true)
  })

  it("keeps a network whose release failed, for the next leave", async () => {
    await link.joinHotspot("glasses", "pw", {purpose: "outgoing-client"})
    const failure = new Error("Native network release failed")
    mockNative.disconnect.mockRejectedValueOnce(failure)
    await expect(link.leave()).rejects.toBe(failure)
    expect(link.isScoped()).toBe(true)
    await link.leave()
    expect(link.isScoped()).toBe(false)
  })

  it("is no longer scoped once the network is lost", async () => {
    await link.joinHotspot("glasses", "pw", {purpose: "outgoing-client"})
    const lost = jest.fn()
    link.onLost(lost)
    emit("networkLost", {})
    expect(lost).toHaveBeenCalled()
    expect(link.isScoped()).toBe(false)
  })

  it("downloads a glasses file into the cache folder", async () => {
    await expect(
      link.downloadToCache("http://192.168.43.1:8089/api/deferred?id=p1", "glasses-file-p1", {
        connectionMs: 1,
        readMs: 2,
      }),
    ).resolves.toEqual({
      statusCode: 200,
      uri: "file:///data/cache/glasses-file-p1",
      bytes: 3,
    })
    expect(mockNative.download).toHaveBeenCalledWith(
      expect.stringMatching(/^file_/),
      "http://192.168.43.1:8089/api/deferred?id=p1",
      "/data/cache/glasses-file-p1",
      {},
      1,
      2,
    )
  })
})
