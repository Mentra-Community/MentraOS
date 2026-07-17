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
import {mentraLocalNetworkMock as mockNativeModule} from "../../test-utils/mockBluetoothSdk"

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

  it("keeps Android 9 on the legacy transport", () => {
    expect(shouldUseScopedLocalNetwork("android", 28, true)).toBe(false)
    expect(shouldUseScopedLocalNetwork("android", 29, true)).toBe(true)
    expect(shouldUseScopedLocalNetwork("ios", 18, true)).toBe(false)
  })
})
