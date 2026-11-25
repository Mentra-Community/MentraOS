jest.mock("react-native", () => ({Platform: {OS: "android", Version: 33}}))

jest.mock("react-native-wifi-reborn", () => ({__esModule: true, default: {}}))
jest.mock("@dr.pogodin/react-native-fs", () => ({
  downloadFile: jest.fn(),
  stopDownload: jest.fn(),
}))

import {localNetworkErrorDetails, localNetworkTransport} from "../../../modules/engine/src/services/asg/localNetworkTransport"
import {
  emitLocalNetworkEvent,
  glassesWifiMock,
  mentraLocalNetworkMock as mockNativeModule,
} from "../../test-utils/mockBluetoothSdk"

/** Whether the Bluetooth SDK's glasses Wi-Fi link has a scoped Android network up. */
const scoped = (up: boolean) => glassesWifiMock.glassesWifiLink.isScoped.mockReturnValue(up)

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
  beforeEach(() => {
    jest.clearAllMocks()
    scoped(true)
  })

  it("uses the system route while the link has no scoped network", async () => {
    scoped(false)
    const fetch = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"))
    await localNetworkTransport.fetch("http://192.168.43.1:8089/api/health")
    expect(mockNativeModule.request).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalled()
    fetch.mockRestore()
  })

  it("routes glasses HTTP through the captured WiFi network", async () => {
    const response = await localNetworkTransport.fetch("http://192.168.43.1:8089/api/health")

    expect(mockNativeModule.request).toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({ok: true})
  })

  it("forwards caller-specific timeouts to scoped HTTP requests", async () => {
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

  it("cancels a native request when its AbortSignal fires", async () => {
    mockNativeModule.request.mockImplementationOnce(() => new Promise(() => {}))
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

})
