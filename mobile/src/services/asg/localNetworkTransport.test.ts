jest.mock("react-native", () => ({Platform: {OS: "android", Version: 33}}))

jest.mock("react-native-wifi-reborn", () => ({
  __esModule: true,
  default: {connectToProtectedSSID: jest.fn()},
}))
jest.mock("@dr.pogodin/react-native-fs", () => ({
  downloadFile: jest.fn(),
  stopDownload: jest.fn(),
}))

jest.mock("@mentra/glasses-media", () => ({
  glassesHotspot: {join: jest.fn(async () => "192.168.43.2"), leave: jest.fn(async () => {})},
}))
jest.mock("@mentra/crust", () => ({__esModule: true, default: {isIOSAppOnMac: false}}))

import {
  localNetworkErrorDetails,
  localNetworkTransport,
  shouldUseScopedLocalNetwork,
} from "../../../modules/engine/src/services/asg/localNetworkTransport"
import {Platform} from "react-native"
import {emitLocalNetworkEvent, mentraLocalNetworkMock as mockNativeModule} from "../../test-utils/mockBluetoothSdk"
const networkOwner = Symbol("transport-test")
const otherOwner = Symbol("other-test")
const mockLegacyConnect = jest.requireMock("react-native-wifi-reborn").default.connectToProtectedSSID as jest.Mock
const mockMacHotspot = jest.requireMock("@mentra/glasses-media").glassesHotspot as {join: jest.Mock; leave: jest.Mock}
const mockCrust = jest.requireMock("@mentra/crust").default

describe("Mac hotspot ownership", () => {
  beforeEach(async () => {
    mockMacHotspot.leave.mockResolvedValue(undefined)
    await localNetworkTransport.disconnect(networkOwner)
    jest.clearAllMocks()
    mockCrust.isIOSAppOnMac = true
    Platform.OS = "ios"
  })
  afterEach(async () => {
    mockMacHotspot.leave.mockResolvedValue(undefined)
    await localNetworkTransport.disconnect(networkOwner)
    mockCrust.isIOSAppOnMac = false
    Platform.OS = "android"
  })

  it("returns the actual Mac Wi-Fi address without using the iPhone join", async () => {
    await expect(
      localNetworkTransport.connect(networkOwner, "glasses", "private", {gateway: "192.168.43.1"}),
    ).resolves.toBe("192.168.43.2")
    expect(mockMacHotspot.join).toHaveBeenCalledWith(
      expect.any(String),
      "glasses",
      "private",
      "192.168.43.1",
      "outgoing-client",
    )
    expect(mockLegacyConnect).not.toHaveBeenCalled()
  })

  it("joins for an incoming OTA server while retaining exclusive network ownership", async () => {
    await expect(
      localNetworkTransport.connect(networkOwner, "glasses", "private", {
        gateway: "192.168.43.1",
        purpose: "incoming-server",
      }),
    ).resolves.toBe("192.168.43.2")
    expect(mockMacHotspot.join).toHaveBeenCalledWith(
      expect.any(String),
      "glasses",
      "private",
      "192.168.43.1",
      "incoming-server",
    )
    await expect(localNetworkTransport.connect(otherOwner, "other", "private")).rejects.toThrow("not been released")
    await localNetworkTransport.disconnect(otherOwner)
    expect(mockMacHotspot.leave).not.toHaveBeenCalled()
    await localNetworkTransport.disconnect(networkOwner)
    expect(mockMacHotspot.leave).toHaveBeenCalledTimes(1)
  })

  it("rejects overlap without invalidating the admitted connection", async () => {
    let finish!: (address: string) => void
    mockMacHotspot.join.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const first = localNetworkTransport.connect(networkOwner, "glasses", "private")
    await expect(localNetworkTransport.connect(otherOwner, "other", "private")).rejects.toThrow("not been released")
    finish("192.168.43.2")
    await expect(first).resolves.toBe("192.168.43.2")
    expect(mockMacHotspot.join).toHaveBeenCalledTimes(1)
  })

  it("retains custody until late native completion has been released", async () => {
    let finish!: (address: string) => void
    let released!: () => void
    mockMacHotspot.join.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    mockMacHotspot.leave.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          released = resolve
        }),
    )
    const connection = localNetworkTransport.connect(networkOwner, "glasses", "private")
    const failure = expect(connection).rejects.toThrow("superseded")
    const leaving = localNetworkTransport.disconnect(networkOwner)
    await expect(localNetworkTransport.connect(otherOwner, "other", "private")).rejects.toThrow("not been released")
    finish("192.168.43.2")
    released()
    await leaving
    await failure
  })

  it("preserves the original association error when cleanup also fails", async () => {
    const original = new Error("association refused")
    mockMacHotspot.join.mockRejectedValueOnce(original)
    mockMacHotspot.leave.mockRejectedValueOnce(new Error("cleanup refused"))
    await expect(localNetworkTransport.connect(networkOwner, "glasses", "private")).rejects.toBe(original)
    await expect(localNetworkTransport.connect(otherOwner, "other", "private")).rejects.toThrow("not been released")
    await localNetworkTransport.disconnect(networkOwner)
    await expect(localNetworkTransport.connect(networkOwner, "glasses", "private")).resolves.toBe("192.168.43.2")
  })

  it.each([
    [Symbol("ota"), Symbol("gallery")],
    [Symbol("gallery"), Symbol("ota")],
  ])("does not let a refused caller release the admitted caller", async (admitted, refused) => {
    await localNetworkTransport.connect(admitted, "glasses", "private")
    await expect(localNetworkTransport.connect(refused, "glasses", "private")).rejects.toThrow("not been released")
    await localNetworkTransport.disconnect(refused)
    expect(mockMacHotspot.leave).not.toHaveBeenCalled()
    await expect(localNetworkTransport.connect(refused, "glasses", "private")).rejects.toThrow("not been released")
    await localNetworkTransport.disconnect(admitted)
    expect(mockMacHotspot.leave).toHaveBeenCalledTimes(1)
  })
})

describe("localNetworkErrorDetails", () => {
  it("recovers exact owned legacy Expo causes without exposing arbitrary native text", () => {
    const error = Object.assign(new Error("Call to function joinLocalHotspot was rejected\n→ Caused by: Hotspot join timed out"), {code: "ERR_UNEXPECTED"})
    expect(localNetworkErrorDetails(error)).toEqual({code: "ERR_UNEXPECTED", message: "Hotspot join timed out"})
    expect(localNetworkErrorDetails({code: "ERR_UNEXPECTED", message: "Mac Wi-Fi scan failed (com.apple.wifi, -3905)"})).toEqual({
      code: "ERR_UNEXPECTED", message: "Mac Wi-Fi scan failed (com.apple.wifi, -3905)",
    })
    for (const message of ["private native description", "Hotspot join timed out with private network", "Mac Wi-Fi scan failed (private domain, -3905)", "a".repeat(2049)]) {
      expect(localNetworkErrorDetails({code: "ERR_UNEXPECTED", message})).toEqual({code: "ERR_UNEXPECTED"})
    }
  })
  it("retains bounded hotspot bridge messages without copying arbitrary native descriptions", () => {
    const error = Object.assign(new Error("Mac Wi-Fi scan failed (com.apple.wifi, -3905)"), {
      code: "ERR_HOTSPOT_JOIN", userInfo: {networkName: "fixture confidential network", opaque: "fixture confidential value"},
    })
    expect(localNetworkErrorDetails(error)).toEqual({
      code: "ERR_HOTSPOT_JOIN", message: "Mac Wi-Fi scan failed (com.apple.wifi, -3905)",
    })
    expect(localNetworkErrorDetails({code: "ERR_UNEXPECTED", message: "private NSError description"})).toEqual({code: "ERR_UNEXPECTED"})
    expect(localNetworkErrorDetails({code: "ERR_HOTSPOT_NATIVE", message: "\n\t" + "a".repeat(600)}).message).toBe("a".repeat(512))
    expect(JSON.stringify(localNetworkErrorDetails(error))).not.toMatch(/fixture confidential|networkName|opaque/)
  })
  it("preserves bridged domain and underlying code without a native stack or private userInfo", () => {
    const error = Object.assign(new Error("internal error"), {
      code: "unableToConnect",
      domain: "NEHotspotConfigurationErrorDomain",
      nativeStackIOS: Array(100).fill("long native stack"),
      userInfo: {
        SSID: "private network",
        password: "private password",
        NSUnderlyingError: {domain: "NSPOSIXErrorDomain", code: "22", message: "private detail"},
      },
    })
    expect(localNetworkErrorDetails(error)).toEqual({
      code: "unableToConnect",
      domain: "NEHotspotConfigurationErrorDomain",
      underlying: {domain: "NSPOSIXErrorDomain", code: "22"},
    })
    expect(JSON.stringify(localNetworkErrorDetails(error)).length).toBeLessThan(256)
  })

  it("reads non-enumerable native facts and refuses arbitrary text or malformed values", () => {
    const error = new Error("private message")
    Object.defineProperty(error, "domain", {value: "NEHotspotConfigurationErrorDomain"})
    Object.defineProperty(error, "code", {value: 8})
    expect(localNetworkErrorDetails(error)).toEqual({code: 8, domain: "NEHotspotConfigurationErrorDomain"})
    expect(localNetworkErrorDetails({code: "secret with spaces", domain: "x".repeat(129), userInfo: null})).toEqual({})
    expect(localNetworkErrorDetails(null)).toEqual({})
  })
})

describe("localNetworkTransport", () => {
  beforeEach(async () => {
    jest.clearAllMocks()
    await localNetworkTransport.disconnect(networkOwner)
  })

  it("uses the scoped native connection on supported Android phones", async () => {
    await localNetworkTransport.connect(networkOwner, "AndroidShare_test", "password")

    expect(mockNativeModule.connect).toHaveBeenCalledWith("AndroidShare_test", "password")
    expect(mockLegacyConnect).not.toHaveBeenCalled()
    expect(localNetworkTransport.isScopedConnectionActive()).toBe(true)
  })

  it("records an acquired Android network before the caller checks a replaced OTA owner", async () => {
    let resolve!: (value: {connected: boolean; ssid: string; localAddress: string}) => void
    mockNativeModule.connect.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    let current = true
    const connecting = localNetworkTransport.connect(networkOwner, "AndroidShare_test", "password", {
      retryIosInternalError: true,
      assertCurrent: () => {
        if (!current) throw new Error("OTA owner changed")
      },
    })
    current = false
    resolve({connected: true, ssid: "AndroidShare_test", localAddress: "192.168.43.2"})
    await expect(connecting).resolves.toBe("192.168.43.2")
    expect(localNetworkTransport.isScopedConnectionActive()).toBe(true)
    await localNetworkTransport.disconnect(networkOwner)
    expect(mockNativeModule.disconnect).toHaveBeenCalled()
    expect(localNetworkTransport.isScopedConnectionActive()).toBe(false)
  })

  it("routes glasses HTTP through the captured WiFi network", async () => {
    await localNetworkTransport.connect(networkOwner, "AndroidShare_test", "password")

    const response = await localNetworkTransport.fetch("http://192.168.43.1:8089/api/health")

    expect(mockNativeModule.request).toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({ok: true})
  })

  it("forwards caller-specific timeouts to scoped HTTP requests", async () => {
    await localNetworkTransport.connect(networkOwner, "AndroidShare_test", "password")

    await localNetworkTransport.fetch("http://192.168.43.1:8089/api/v3/hash", undefined, 10 * 60 * 1000)

    expect(mockNativeModule.request).toHaveBeenCalledWith(
      expect.stringMatching(/^request_/),
      "http://192.168.43.1:8089/api/v3/hash",
      "GET",
      {},
      null,
      10 * 60 * 1000,
    )
  })

  it("releases the scoped connection during cleanup", async () => {
    await localNetworkTransport.connect(networkOwner, "AndroidShare_test", "password")
    await localNetworkTransport.disconnect(networkOwner)

    expect(mockNativeModule.disconnect).toHaveBeenCalled()
    expect(localNetworkTransport.isScopedConnectionActive()).toBe(false)
  })

  it("reports failed native release and retains the active connection for later cleanup", async () => {
    await localNetworkTransport.connect(networkOwner, "AndroidShare_test", "password")
    const failure = new Error("Native network release failed")
    mockNativeModule.disconnect.mockRejectedValueOnce(failure)
    await expect(localNetworkTransport.disconnect(networkOwner)).rejects.toBe(failure)
    expect(localNetworkTransport.isScopedConnectionActive()).toBe(true)
    await localNetworkTransport.disconnect(networkOwner)
    expect(localNetworkTransport.isScopedConnectionActive()).toBe(false)
  })

  it("cancels a native request when its AbortSignal fires", async () => {
    mockNativeModule.request.mockImplementationOnce(() => new Promise(() => {}))
    await localNetworkTransport.connect(networkOwner, "AndroidShare_test", "password")
    const controller = new AbortController()

    void localNetworkTransport.fetch("http://192.168.43.1:8089/api/sync", {signal: controller.signal})
    controller.abort()
    await Promise.resolve()

    expect(mockNativeModule.cancel).toHaveBeenCalledWith(expect.stringMatching(/^request_/))
  })

  it("cancels native downloads and preserves sync cancellation semantics", async () => {
    let rejectDownload: (error: Error) => void = () => {}
    mockNativeModule.download.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectDownload = reject
        }),
    )
    await localNetworkTransport.connect(networkOwner, "AndroidShare_test", "password")

    const handle = localNetworkTransport.downloadFile({
      fromUrl: "http://192.168.43.1:8089/api/download?file=video.mp4",
      toFile: "/tmp/video.mp4",
    })
    localNetworkTransport.stopDownload(handle.jobId)
    rejectDownload(new Error("socket closed"))

    await expect(handle.promise).rejects.toThrow("Sync cancelled")
    expect(mockNativeModule.cancel).toHaveBeenCalledWith(expect.stringMatching(/^download_/))
  })

  it("forwards native response metadata before download progress", async () => {
    let resolveDownload: (result: {
      statusCode: number
      bytesWritten: number
      headers: Record<string, string>
    }) => void = () => {}
    mockNativeModule.download.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDownload = resolve
        }),
    )
    await localNetworkTransport.connect(networkOwner, "AndroidShare_test", "password")
    const begin = jest.fn()

    const handle = localNetworkTransport.downloadFile({
      fromUrl: "http://192.168.43.1:8089/api/download?file=photo.jpg",
      toFile: "/tmp/photo.jpg",
      begin,
    })
    const requestId = (mockNativeModule.download as jest.Mock).mock.calls[0][0]
    emitLocalNetworkEvent("downloadProgress", {
      requestId,
      bytesWritten: 0,
      contentLength: 4,
      statusCode: 206,
      headers: {"Content-Range": "bytes 0-3/4"},
    })

    expect(begin).toHaveBeenCalledWith({
      jobId: handle.jobId,
      statusCode: 206,
      contentLength: 4,
      headers: {"Content-Range": "bytes 0-3/4"},
    })
    resolveDownload({statusCode: 206, bytesWritten: 4, headers: {"Content-Range": "bytes 0-3/4"}})
    await expect(handle.promise).resolves.toMatchObject({statusCode: 206, bytesWritten: 4})
  })

  it("uses scoped transport only on Android when the native module is available", () => {
    expect(shouldUseScopedLocalNetwork("android", true)).toBe(true)
    expect(shouldUseScopedLocalNetwork("android", false)).toBe(false)
    expect(shouldUseScopedLocalNetwork("ios", true)).toBe(false)
  })
})

const internalJoinError = (code = 8, completed: unknown = true) =>
  Object.assign(new Error("internal error"), {
    code: "unableToConnect",
    domain: "NEHotspotConfigurationErrorDomain",
    userInfo: {
      RNWifiNativeError: {
        domain: "NEHotspotConfigurationErrorDomain",
        code,
        completed,
        password: "private secret",
        underlying: {domain: "NSPOSIXErrorDomain", code: 22, private: "hidden"},
      },
    },
  })
const retryOptions = {retryIosInternalError: true as const, assertCurrent: () => {}}

describe("completed iOS hotspot join recovery", () => {
  beforeEach(async () => {
    jest.useFakeTimers()
    Object.assign(Platform, {OS: "ios"})
    mockLegacyConnect.mockReset().mockResolvedValue(undefined)
    await localNetworkTransport.disconnect(networkOwner)
  })
  afterEach(() => {
    jest.useRealTimers()
    Object.assign(Platform, {OS: "android"})
  })

  it("retains sanitized original numeric facts beyond React Native's mapped code", () => {
    expect(localNetworkErrorDetails(internalJoinError())).toEqual({
      code: "unableToConnect",
      domain: "NEHotspotConfigurationErrorDomain",
      native: {
        domain: "NEHotspotConfigurationErrorDomain",
        code: 8,
        completed: true,
        underlying: {domain: "NSPOSIXErrorDomain", code: 22},
      },
    })
    expect(JSON.stringify(localNetworkErrorDetails(internalJoinError()))).not.toMatch(/private|secret|hidden/)
    expect(localNetworkErrorDetails(internalJoinError(8, "true")).native).toBeUndefined()
    expect(localNetworkErrorDetails(internalJoinError(Number.NaN)).native).toBeUndefined()
  })

  it("retries the same hotspot once the original apply has rejected, then returns actual native success", async () => {
    const original = internalJoinError()
    mockLegacyConnect.mockRejectedValueOnce(original)
    const pending = localNetworkTransport.connect(networkOwner, "test-hotspot", "test-passphrase", retryOptions)
    await Promise.resolve()
    await Promise.resolve()
    expect(mockLegacyConnect).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(3000)
    await expect(pending).resolves.toBeUndefined()
    expect(mockLegacyConnect.mock.calls).toEqual([
      ["test-hotspot", "test-passphrase", false, false],
      ["test-hotspot", "test-passphrase", false, false],
    ])
  })

  it("keeps the last real rejection after three answered failures", async () => {
    const original = internalJoinError()
    const final = internalJoinError()
    mockLegacyConnect.mockRejectedValueOnce(original).mockRejectedValueOnce(original).mockRejectedValueOnce(final)
    const pending = localNetworkTransport.connect(networkOwner, "test-hotspot", "test-passphrase", retryOptions)
    const failure = pending.catch((error) => error)
    await jest.advanceTimersByTimeAsync(6000)
    expect(await failure).toBe(final)
    expect(mockLegacyConnect).toHaveBeenCalledTimes(3)
  })

  it.each([7, 1, 2, 9, 13, 14])("does not retry native code %s", async (code) => {
    const error = internalJoinError(code)
    mockLegacyConnect.mockRejectedValueOnce(error)
    await expect(
      localNetworkTransport.connect(networkOwner, "test-hotspot", "test-passphrase", retryOptions),
    ).rejects.toBe(error)
    expect(mockLegacyConnect).toHaveBeenCalledTimes(1)
  })

  it("never retries a generic mapped error or nests retries for Gallery's existing caller", async () => {
    const error = {code: "unableToConnect", domain: "NEHotspotConfigurationErrorDomain"}
    mockLegacyConnect.mockRejectedValueOnce(error)
    await expect(
      localNetworkTransport.connect(networkOwner, "test-hotspot", "test-passphrase", retryOptions),
    ).rejects.toBe(error)
    mockLegacyConnect.mockRejectedValueOnce(internalJoinError())
    await expect(localNetworkTransport.connect(networkOwner, "test-hotspot", "test-passphrase")).rejects.toMatchObject({
      code: "unableToConnect",
    })
    expect(mockLegacyConnect).toHaveBeenCalledTimes(2)
  })

  it("does not admit a retry when the timer resumes after its admission budget", async () => {
    const original = internalJoinError()
    mockLegacyConnect.mockRejectedValueOnce(original)
    const pending = localNetworkTransport.connect(networkOwner, "test-hotspot", "test-passphrase", retryOptions)
    const failure = pending.catch((error) => error)
    await Promise.resolve()
    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(2900)
    jest.setSystemTime(Date.now() + 31_000)
    await jest.advanceTimersByTimeAsync(100)
    expect(await failure).toBe(original)
    expect(mockLegacyConnect).toHaveBeenCalledTimes(1)
  })

  it("joins a pending native call without overlapping or timing out into another apply", async () => {
    let reject!: (error: unknown) => void
    mockLegacyConnect.mockReturnValueOnce(
      new Promise((_, r) => {
        reject = r
      }),
    )
    const pending = localNetworkTransport.connect(networkOwner, "test-hotspot", "test-passphrase", retryOptions)
    const failure = pending.catch((error) => error)
    await jest.advanceTimersByTimeAsync(31_000)
    expect(mockLegacyConnect).toHaveBeenCalledTimes(1)
    const original = internalJoinError()
    reject(original)
    expect(await failure).toBe(original)
    expect(mockLegacyConnect).toHaveBeenCalledTimes(1)
  })

  it("returns successful iOS acquisition to caller cleanup after OTA ownership changes", async () => {
    let resolve!: () => void
    mockLegacyConnect.mockReturnValueOnce(
      new Promise<void>((r) => {
        resolve = r
      }),
    )
    let current = true
    const pending = localNetworkTransport.connect(networkOwner, "test-hotspot", "test-passphrase", {
      ...retryOptions,
      assertCurrent: () => {
        if (!current) throw new Error("OTA owner changed")
      },
    })
    current = false
    resolve()
    await expect(pending).resolves.toBeUndefined()
    expect(mockLegacyConnect).toHaveBeenCalledTimes(1)
  })

  it("does not resend after disconnect or owner replacement during the retry delay", async () => {
    mockLegacyConnect.mockRejectedValueOnce(internalJoinError())
    const pending = localNetworkTransport.connect(networkOwner, "test-hotspot", "test-passphrase", retryOptions)
    const failure = pending.catch((error) => error)
    await Promise.resolve()
    await Promise.resolve()
    await localNetworkTransport.disconnect(networkOwner)
    await jest.advanceTimersByTimeAsync(3000)
    expect(await failure).toEqual(expect.objectContaining({message: "Local network connection was superseded"}))
    expect(mockLegacyConnect).toHaveBeenCalledTimes(1)
  })

  it("checks current OTA ownership after every completed callback and retry delay", async () => {
    let current = true
    const assertCurrent = () => {
      if (!current) throw new Error("OTA owner changed")
    }
    mockLegacyConnect.mockRejectedValueOnce(internalJoinError())
    const pending = localNetworkTransport.connect(networkOwner, "test-hotspot", "test-passphrase", {
      ...retryOptions,
      assertCurrent,
    })
    const failure = pending.catch((error) => error)
    await Promise.resolve()
    await Promise.resolve()
    current = false
    await jest.advanceTimersByTimeAsync(3000)
    expect(await failure).toEqual(expect.objectContaining({message: "OTA owner changed"}))
    expect(mockLegacyConnect).toHaveBeenCalledTimes(1)
  })
})
