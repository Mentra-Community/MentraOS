import * as RNFS from "@dr.pogodin/react-native-fs"

import {localStorageService} from "../../../modules/engine/src/services/asg/localStorageService"
import {reportInvalidGalleryMedia} from "../../../modules/engine/src/services/asg/GalleryMediaIntegrityReportService"
import {useGallerySyncStore} from "../../../modules/engine/src/stores/gallerySync"

jest.mock("@dr.pogodin/react-native-fs", () => ({
  exists: jest.fn(),
  stat: jest.fn(),
  read: jest.fn(),
  writeFile: jest.fn(),
  unlink: jest.fn(() => Promise.resolve()),
}))

jest.mock("@mentra/crust", () => ({
  __esModule: true,
  default: {},
}))

jest.mock("../../../modules/engine/src/services/asg/asgCameraApi", () => ({
  asgCameraApi: {
    deleteFilesFromServer: jest.fn(),
  },
}))

jest.mock("../../../modules/engine/src/services/asg/localStorageService", () => ({
  localStorageService: {
    convertToDownloadedFile: jest.fn((info: any) => info),
    saveDownloadedFile: jest.fn(),
  },
}))

jest.mock("../../../modules/engine/src/services/asg/GalleryMediaIntegrityReportService", () => ({
  reportInvalidGalleryMedia: jest.fn(),
}))

jest.mock("../../../modules/engine/src/utils/permissions/MediaLibraryPermissions", () => ({
  MediaLibraryPermissions: {
    saveToLibrary: jest.fn(),
  },
}))

import {mediaProcessingQueue} from "../../../modules/engine/src/services/asg/mediaProcessingQueue"

describe("mediaProcessingQueue", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    useGallerySyncStore.getState().reset()
  })

  it("does not save metadata when local file is zero bytes", async () => {
    ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
    ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 0})

    mediaProcessingQueue.reset()
    mediaProcessingQueue.enqueue({
      id: "VID_zero",
      type: "video",
      primaryPath: "/tmp/VID_zero/base.mp4",
      totalSize: 0,
      shouldProcess: false,
      shouldAutoSave: false,
      deleteFromGlasses: ["VID_zero"],
    })

    await expect(mediaProcessingQueue.waitUntilDrained(5000)).resolves.toBeUndefined()

    expect(localStorageService.saveDownloadedFile).not.toHaveBeenCalled()
    expect(reportInvalidGalleryMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "VID_zero",
        mediaKind: "video",
        stage: "processing_validation",
        reason: expect.stringContaining("zero-byte file VID_zero"),
      }),
    )
    expect(useGallerySyncStore.getState().failedFiles).toContain("VID_zero")
  })

  it("does not compare processed output size against capture total size", async () => {
    ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
    ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 100})
    ;(RNFS.read as jest.Mock).mockResolvedValue(Buffer.from([0xff, 0xd8, 0x76, 0x61, 0x6c, 0x69, 0x64]).toString("base64"))

    mediaProcessingQueue.reset()
    mediaProcessingQueue.enqueue({
      id: "IMG_with_sidecar",
      type: "photo",
      primaryPath: "/tmp/IMG_with_sidecar/base.jpg",
      totalSize: 200,
      shouldProcess: false,
      shouldAutoSave: false,
    })

    await expect(mediaProcessingQueue.waitUntilDrained(5000)).resolves.toBeUndefined()

    expect(localStorageService.saveDownloadedFile).toHaveBeenCalled()
    expect(useGallerySyncStore.getState().failedFiles).not.toContain("IMG_with_sidecar")
  })
})
