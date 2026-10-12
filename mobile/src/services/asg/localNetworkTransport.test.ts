jest.mock("react-native", () => ({Platform: {OS: "android", Version: 33}, AppState: {currentState: "active"}}))
jest.mock("@mentra/crust", () => ({__esModule: true, default: {isIOSAppOnMac: false}}))
jest.mock("expo-location", () => ({
  getForegroundPermissionsAsync: jest.fn(async () => ({status: "granted"})),
  requestForegroundPermissionsAsync: jest.fn(async () => ({status: "granted"})),
}))
jest.mock("@mentra/glasses-media", () => ({
  glassesHotspot: {
    waitForMacAssociation: jest.fn(),
    verifiedMacAddress: jest.fn(),
    releaseMacAssociation: jest.fn(async () => {}),
  },
}))

jest.mock("react-native-wifi-reborn", () => ({
  __esModule: true,
  default: {connectToProtectedSSID: jest.fn()},
}))
jest.mock("@dr.pogodin/react-native-fs", () => ({
  downloadFile: jest.fn(),
  stopDownload: jest.fn(),
}))

import {
  localNetworkErrorDetails,
  localNetworkTransport,
  shouldUseScopedLocalNetwork,
} from "../../../modules/engine/src/services/asg/localNetworkTransport"
import {Platform} from "react-native"
import {emitLocalNetworkEvent, mentraLocalNetworkMock as mockNativeModule} from "../../test-utils/mockBluetoothSdk"
const mockLegacyConnect = jest.requireMock("react-native-wifi-reborn").default.connectToProtectedSSID as jest.Mock

describe("localNetworkErrorDetails", () => {
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
    await localNetworkTransport.disconnect()
  })

  it("uses the scoped native connection on supported Android phones", async () => {
    await localNetworkTransport.connect("AndroidShare_test", "password")

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
    const connecting = localNetworkTransport.connect("AndroidShare_test", "password", {
      retryIosInternalError: true,
      assertCurrent: () => {
        if (!current) throw new Error("OTA owner changed")
      },
    })
    current = false
    resolve({connected: true, ssid: "AndroidShare_test", localAddress: "192.168.43.2"})
    await expect(connecting).resolves.toBe("192.168.43.2")
    expect(localNetworkTransport.isScopedConnectionActive()).toBe(true)
    await localNetworkTransport.disconnect()
    expect(mockNativeModule.disconnect).toHaveBeenCalled()
    expect(localNetworkTransport.isScopedConnectionActive()).toBe(false)
  })

  it("routes glasses HTTP through the captured WiFi network", async () => {
    await localNetworkTransport.connect("AndroidShare_test", "password")

    const response = await localNetworkTransport.fetch("http://192.168.43.1:8089/api/health")

    expect(mockNativeModule.request).toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({ok: true})
  })

  it("forwards caller-specific timeouts to scoped HTTP requests", async () => {
    await localNetworkTransport.connect("AndroidShare_test", "password")

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
    await localNetworkTransport.connect("AndroidShare_test", "password")
    await localNetworkTransport.disconnect()

    expect(mockNativeModule.disconnect).toHaveBeenCalled()
    expect(localNetworkTransport.isScopedConnectionActive()).toBe(false)
  })

  it("reports failed native release and retains the active connection for later cleanup", async () => {
    await localNetworkTransport.connect("AndroidShare_test", "password")
    const failure = new Error("Native network release failed")
    mockNativeModule.disconnect.mockRejectedValueOnce(failure)
    await expect(localNetworkTransport.disconnect()).rejects.toBe(failure)
    expect(localNetworkTransport.isScopedConnectionActive()).toBe(true)
    await localNetworkTransport.disconnect()
    expect(localNetworkTransport.isScopedConnectionActive()).toBe(false)
  })

  it("cancels a native request when its AbortSignal fires", async () => {
    mockNativeModule.request.mockImplementationOnce(() => new Promise(() => {}))
    await localNetworkTransport.connect("AndroidShare_test", "password")
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
    await localNetworkTransport.connect("AndroidShare_test", "password")

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
    await localNetworkTransport.connect("AndroidShare_test", "password")
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
    await localNetworkTransport.disconnect()
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
    const pending = localNetworkTransport.connect("test-hotspot", "test-passphrase", retryOptions)
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
    const pending = localNetworkTransport.connect("test-hotspot", "test-passphrase", retryOptions)
    const failure = pending.catch((error) => error)
    await jest.advanceTimersByTimeAsync(6000)
    expect(await failure).toBe(final)
    expect(mockLegacyConnect).toHaveBeenCalledTimes(3)
  })

  it.each([7, 1, 2, 9, 13, 14])("does not retry native code %s", async (code) => {
    const error = internalJoinError(code)
    mockLegacyConnect.mockRejectedValueOnce(error)
    await expect(localNetworkTransport.connect("test-hotspot", "test-passphrase", retryOptions)).rejects.toBe(error)
    expect(mockLegacyConnect).toHaveBeenCalledTimes(1)
  })

  it("never retries a generic mapped error or nests retries for Gallery's existing caller", async () => {
    const error = {code: "unableToConnect", domain: "NEHotspotConfigurationErrorDomain"}
    mockLegacyConnect.mockRejectedValueOnce(error)
    await expect(localNetworkTransport.connect("test-hotspot", "test-passphrase", retryOptions)).rejects.toBe(error)
    mockLegacyConnect.mockRejectedValueOnce(internalJoinError())
    await expect(localNetworkTransport.connect("test-hotspot", "test-passphrase")).rejects.toMatchObject({
      code: "unableToConnect",
    })
    expect(mockLegacyConnect).toHaveBeenCalledTimes(2)
  })

  it("does not admit a retry when the timer resumes after its admission budget", async () => {
    const original = internalJoinError()
    mockLegacyConnect.mockRejectedValueOnce(original)
    const pending = localNetworkTransport.connect("test-hotspot", "test-passphrase", retryOptions)
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
    const pending = localNetworkTransport.connect("test-hotspot", "test-passphrase", retryOptions)
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
    const pending = localNetworkTransport.connect("test-hotspot", "test-passphrase", {
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
    const pending = localNetworkTransport.connect("test-hotspot", "test-passphrase", retryOptions)
    const failure = pending.catch((error) => error)
    await Promise.resolve()
    await Promise.resolve()
    await localNetworkTransport.disconnect()
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
    const pending = localNetworkTransport.connect("test-hotspot", "test-passphrase", {...retryOptions, assertCurrent})
    const failure = pending.catch((error) => error)
    await Promise.resolve()
    await Promise.resolve()
    current = false
    await jest.advanceTimersByTimeAsync(3000)
    expect(await failure).toEqual(expect.objectContaining({message: "OTA owner changed"}))
    expect(mockLegacyConnect).toHaveBeenCalledTimes(1)
  })
})

describe("user-operated Mac hotspot association", () => {
  const native = jest.requireMock("@mentra/glasses-media").glassesHotspot
  const crust = jest.requireMock("@mentra/crust").default
  const location = jest.requireMock("expo-location")
  const options = () => ({assertCurrent: () => {}, macJoin: {gateway: "192.168.43.1", onWaiting: jest.fn()}})
  beforeEach(async () => {
    jest.useFakeTimers()
    Object.assign(Platform, {OS: "ios"})
    crust.isIOSAppOnMac = true
    mockLegacyConnect.mockClear()
    native.waitForMacAssociation.mockReset().mockResolvedValue("192.168.43.20")
    native.verifiedMacAddress.mockReset().mockResolvedValue("192.168.43.20")
    location.getForegroundPermissionsAsync.mockResolvedValue({status: "granted"})
    location.requestForegroundPermissionsAsync.mockResolvedValue({status: "granted"})
    await localNetworkTransport.disconnect()
    native.releaseMacAssociation.mockClear()
  })
  afterEach(async () => {
    await localNetworkTransport.disconnect()
    crust.isIOSAppOnMac = false
    Object.assign(Platform, {OS: "android"})
    jest.useRealTimers()
  })
  it("exposes credentials only to presentation, observes the exact target and never calls apply", async () => {
    const opts = options()
    expect(await localNetworkTransport.connect("target", "private-passphrase", opts)).toBe("192.168.43.20")
    expect(opts.macJoin.onWaiting).toHaveBeenCalledWith({ssid: "target", password: "private-passphrase"})
    expect(native.waitForMacAssociation).toHaveBeenCalledWith(expect.any(String), "target", "192.168.43.1", 60000)
    expect(mockLegacyConnect).not.toHaveBeenCalled()
    expect(await localNetworkTransport.verifiedMacAddress()).toBe("192.168.43.20")
  })
  it("rejects an unverified or different network rather than falling back to a private address", async () => {
    await localNetworkTransport.connect("target", "private-passphrase", options())
    native.verifiedMacAddress.mockResolvedValueOnce(null)
    await expect(localNetworkTransport.verifiedMacAddress()).rejects.toThrow("requested glasses hotspot")
    expect(mockLegacyConnect).not.toHaveBeenCalled()
  })
  it("fails denied Location before exposing credentials or starting an observer", async () => {
    location.getForegroundPermissionsAsync.mockResolvedValueOnce({status: "denied"})
    location.requestForegroundPermissionsAsync.mockResolvedValueOnce({status: "denied"})
    const opts = options()
    await expect(localNetworkTransport.connect("target", "private-passphrase", opts)).rejects.toMatchObject({
      code: "hotspot_location_permission_denied",
    })
    expect(opts.macJoin.onWaiting).not.toHaveBeenCalled()
    expect(native.waitForMacAssociation).not.toHaveBeenCalled()
    expect(mockLegacyConnect).not.toHaveBeenCalled()
  })
  it("cancels an unanswered observer when OTA ownership is replaced", async () => {
    native.waitForMacAssociation.mockReturnValueOnce(new Promise(() => {}))
    let current = true
    const pending = localNetworkTransport.connect("target", "private-passphrase", {
      ...options(),
      assertCurrent: () => {
        if (!current) throw new Error("owner changed")
      },
    })
    const result = pending.catch((error) => error)
    for (let i = 0; i < 6; i++) await Promise.resolve()
    current = false
    await jest.advanceTimersByTimeAsync(250)
    expect(await result).toMatchObject({message: "owner changed"})
    expect(native.releaseMacAssociation).toHaveBeenCalledTimes(1)
    expect(mockLegacyConnect).not.toHaveBeenCalled()
  })
  it("bounds an unanswered native callback to sixty seconds and releases the observer", async () => {
    native.waitForMacAssociation.mockReturnValueOnce(new Promise(() => {}))
    const result = localNetworkTransport.connect("target", "private-passphrase", options()).catch((error) => error)
    await jest.advanceTimersByTimeAsync(60000)
    expect(await result).toMatchObject({message: "Mac hotspot join timed out"})
    expect(native.releaseMacAssociation).toHaveBeenCalledTimes(1)
    expect(mockLegacyConnect).not.toHaveBeenCalled()
  })
  it("refuses a Mac caller without a user join presentation instead of attempting native apply", async () => {
    await expect(localNetworkTransport.connect("target", "private-passphrase")).rejects.toThrow("macOS Wi-Fi controls")
    expect(mockLegacyConnect).not.toHaveBeenCalled()
  })
  it("retains the new observer when an older release callback finishes late", async () => {
    await localNetworkTransport.connect("first", "passphrase", options())
    let releaseOld!: () => void
    native.releaseMacAssociation.mockReturnValueOnce(new Promise<void>((resolve) => { releaseOld = resolve }))
    const older = localNetworkTransport.connect("second", "passphrase", options()).catch((error) => error)
    await localNetworkTransport.connect("third", "passphrase", options())
    const currentId = native.waitForMacAssociation.mock.calls[1][0]
    releaseOld()
    expect(await older).toMatchObject({message: "Local network connection was superseded"})
    expect(await localNetworkTransport.verifiedMacAddress()).toBe("192.168.43.20")
    expect(native.verifiedMacAddress).toHaveBeenLastCalledWith(currentId)
    expect(native.waitForMacAssociation).toHaveBeenCalledTimes(2)
  })
  it("rejects a verification callback from a released session", async () => {
    await localNetworkTransport.connect("target", "passphrase", options())
    let resolveAddress!: (address: string) => void
    native.verifiedMacAddress.mockReturnValueOnce(new Promise<string>((resolve) => { resolveAddress = resolve }))
    const verifying = localNetworkTransport.verifiedMacAddress().catch((error) => error)
    await localNetworkTransport.disconnect()
    resolveAddress("192.168.43.20")
    expect(await verifying).toMatchObject({message: "Local network connection was superseded"})
  })
})
