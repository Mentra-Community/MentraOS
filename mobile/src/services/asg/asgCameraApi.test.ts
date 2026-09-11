/* eslint-disable no-restricted-imports */
import * as RNFS from "@dr.pogodin/react-native-fs"

import {AsgCameraApiClient} from "../../../modules/engine/src/services/asg/asgCameraApi"
import {localNetworkTransport} from "../../../modules/engine/src/services/asg/localNetworkTransport"

jest.mock("@dr.pogodin/react-native-fs", () => ({
  exists: jest.fn(() => Promise.resolve(false)),
  mkdir: jest.fn(() => Promise.resolve()),
  unlink: jest.fn(() => Promise.resolve()),
  moveFile: jest.fn(() => Promise.resolve()),
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
  galleryTransferLedger: {},
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
