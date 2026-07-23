jest.mock("react-native", () => ({Platform: {OS: "android", Version: 33}}))

const mockLegacyConnect = jest.fn(() => Promise.resolve())
jest.mock("react-native-wifi-reborn", () => ({
  __esModule: true,
  default: {connectToProtectedSSID: mockLegacyConnect},
}))
jest.mock("@dr.pogodin/react-native-fs", () => ({
  downloadFile: jest.fn(),
  stopDownload: jest.fn(),
}))

import {
  localNetworkTransport,
  shouldUseScopedLocalNetwork,
} from "../../../modules/engine/src/services/asg/localNetworkTransport"
import {
  emitLocalNetworkEvent,
  mentraLocalNetworkMock as mockNativeModule,
} from "../../test-utils/mockBluetoothSdk"

describe("localNetworkTransport", () => {
  beforeEach(async () => {
    jest.clearAllMocks()
    await localNetworkTransport.disconnect()
  })

  it("uses the scoped native connection on Android 10+", async () => {
    await localNetworkTransport.connect("AndroidShare_test", "password")

    expect(mockNativeModule.connect).toHaveBeenCalledWith("AndroidShare_test", "password")
    expect(mockLegacyConnect).not.toHaveBeenCalled()
    expect(localNetworkTransport.isScopedConnectionActive()).toBe(true)
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
    let resolveDownload: (result: {statusCode: number; bytesWritten: number; headers: Record<string, string>}) => void =
      () => {}
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

  it("keeps Android 9 on the legacy transport", () => {
    expect(shouldUseScopedLocalNetwork("android", 28, true)).toBe(false)
    expect(shouldUseScopedLocalNetwork("android", 29, true)).toBe(true)
    expect(shouldUseScopedLocalNetwork("ios", 18, true)).toBe(false)
  })
})
