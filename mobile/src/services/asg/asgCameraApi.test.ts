/* eslint-disable no-restricted-imports */
import * as RNFS from "@dr.pogodin/react-native-fs"

import {
  AsgCameraApiClient,
  GALLERY_TRANSFER_IDLE_TIMEOUT_MS,
} from "../../../modules/engine/src/services/asg/asgCameraApi"
import {localNetworkTransport} from "../../../modules/engine/src/services/asg/localNetworkTransport"
import {BgTimer} from "../../../modules/engine/src/utils/timers"

jest.mock("@dr.pogodin/react-native-fs", () => ({
  exists: jest.fn(() => Promise.resolve(false)),
  mkdir: jest.fn(() => Promise.resolve()),
  unlink: jest.fn(() => Promise.resolve()),
  moveFile: jest.fn(() => Promise.resolve()),
  stat: jest.fn(),
  writeFile: jest.fn(() => Promise.resolve()),
  readFile: jest.fn(() => Promise.resolve("")),
  appendFile: jest.fn(() => Promise.resolve()),
}))

jest.mock("../../../modules/engine/src/services/asg/localNetworkTransport", () => ({
  localNetworkTransport: {
    downloadFile: jest.fn(),
    stopDownload: jest.fn(),
  },
}))

jest.mock("../../../modules/engine/src/services/asg/localStorageService", () => ({
  localStorageService: {},
}))

jest.mock("../../../modules/engine/src/services/asg/galleryMediaValidation", () => ({
  validateDownloadedMediaFile: jest.fn(),
}))

jest.mock("../../../modules/engine/src/services/asg/GalleryMediaIntegrityReportService", () => ({
  reportInvalidGalleryMedia: jest.fn(),
}))

jest.mock("../../../modules/engine/src/services/asg/galleryTransferLedger", () => ({
  galleryTransferLedger: {markSegmentComplete: jest.fn(), markFileHash: jest.fn()},
}))

describe("AsgCameraApiClient video thumbnails", () => {
  const downloadFile = localNetworkTransport.downloadFile as jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("commits a non-empty server-generated thumbnail", async () => {
    downloadFile.mockReturnValue({
      jobId: 1,
      promise: Promise.resolve({statusCode: 200, bytesWritten: 512}),
    })
    const client = new AsgCameraApiClient()
    client.setServer("192.168.43.1")

    const result = await (client as any).downloadVideoThumbnail(
      "VID_20260723_021413_958_665/base.mp4",
      "/tmp/VID_20260723_021413_958_665/.thumb.jpg",
    )

    expect(downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fromUrl: "http://192.168.43.1:8089/api/photo?file=VID_20260723_021413_958_665%2Fbase.mp4",
        toFile: "/tmp/VID_20260723_021413_958_665/.thumb.jpg.partial",
      }),
    )
    expect(RNFS.mkdir).toHaveBeenCalledWith("/tmp/VID_20260723_021413_958_665")
    expect(RNFS.moveFile).toHaveBeenCalledWith(
      "/tmp/VID_20260723_021413_958_665/.thumb.jpg.partial",
      "/tmp/VID_20260723_021413_958_665/.thumb.jpg",
    )
    expect(result).toBe("/tmp/VID_20260723_021413_958_665/.thumb.jpg")
  })

  it("keeps a thumbnail failure non-fatal for the downloaded video", async () => {
    downloadFile.mockReturnValue({
      jobId: 1,
      promise: Promise.resolve({statusCode: 500, bytesWritten: 0}),
    })
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    const client = new AsgCameraApiClient()
    client.setServer("192.168.43.1")

    await expect(
      (client as any).downloadVideoThumbnail("VID_failed/base.mp4", "/tmp/VID_failed/.thumb.jpg"),
    ).resolves.toBeUndefined()
    expect(RNFS.moveFile).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      "[ASG Camera API] Failed to download video thumbnail for VID_failed/base.mp4:",
      expect.any(Error),
    )
  })

  it("propagates cancellation instead of acknowledging a thumbnail-less capture", async () => {
    downloadFile.mockReturnValue({
      jobId: 7,
      promise: new Promise(() => {}),
    })
    const controller = new AbortController()
    controller.abort()
    const client = new AsgCameraApiClient()
    client.setServer("192.168.43.1")

    await expect(
      (client as any).downloadVideoThumbnail(
        "VID_cancelled/base.mp4",
        "/tmp/VID_cancelled/.thumb.jpg",
        controller.signal,
      ),
    ).rejects.toThrow("Sync cancelled")
    expect(localNetworkTransport.stopDownload).toHaveBeenCalledWith(7)
  })
})

describe("AsgCameraApiClient resumable segments", () => {
  const downloadFile = localNetworkTransport.downloadFile as jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(console, "log").mockImplementation(() => {})
    jest.spyOn(console, "warn").mockImplementation(() => {})
    // Run the retry backoff immediately.
    jest.spyOn(BgTimer, "setTimeout").mockImplementation((callback) => {
      callback()
      return 0
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("times out a stalled segment and retries it before the glasses' 120 s hotspot idle cutoff", async () => {
    const file = {name: "VID_1/base.mp4", size: 4, etag: '"gen-1"', role: "primary" as const}
    downloadFile
      .mockReturnValueOnce({jobId: 1, promise: Promise.reject(new Error("The request timed out."))})
      .mockImplementationOnce((options) => {
        options.begin?.({
          jobId: 2,
          statusCode: 206,
          contentLength: 4,
          headers: {"Content-Range": "bytes 0-3/4", "ETag": '"gen-1"'},
        })
        return {jobId: 2, promise: Promise.resolve({jobId: 2, statusCode: 206, bytesWritten: 4})}
      })
    ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 4})
    const client = new AsgCameraApiClient()
    client.setServer("192.168.43.1")
    ;(client as any).galleryCapabilities = null

    await (client as any).downloadResumableCaptureFile("VID_1", file, "/tmp/VID_1/base.mp4")

    expect(downloadFile).toHaveBeenCalledTimes(2)
    for (const [options] of downloadFile.mock.calls) {
      expect(options).toMatchObject({
        headers: expect.objectContaining({Range: "bytes=0-3"}),
        connectionTimeout: GALLERY_TRANSFER_IDLE_TIMEOUT_MS,
        readTimeout: GALLERY_TRANSFER_IDLE_TIMEOUT_MS,
      })
    }
    // A stalled attempt and its replacement request must both land inside the hotspot's idle window.
    expect(2 * GALLERY_TRANSFER_IDLE_TIMEOUT_MS).toBeLessThan(120_000)
    expect(RNFS.moveFile).toHaveBeenLastCalledWith("/tmp/VID_1/base.mp4.assembling.gen-1", "/tmp/VID_1/base.mp4")
  })
})
