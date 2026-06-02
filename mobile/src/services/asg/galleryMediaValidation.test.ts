import * as RNFS from "@dr.pogodin/react-native-fs"

import {
  INVALID_DOWNLOADED_MEDIA,
  validateCaptureMetadataForDownload,
  validateDownloadedMediaFile,
} from "./galleryMediaValidation"

jest.mock("@dr.pogodin/react-native-fs", () => ({
  exists: jest.fn(),
  stat: jest.fn(),
  read: jest.fn(),
}))

describe("galleryMediaValidation", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("validateCaptureMetadataForDownload", () => {
    it("rejects video captures with zero total_size", () => {
      expect(() =>
        validateCaptureMetadataForDownload({
          capture_id: "VID_test",
          type: "video",
          total_size: 0,
          files: [{name: "VID_test/base.mp4", size: 0, role: "primary"}],
        }),
      ).toThrow(INVALID_DOWNLOADED_MEDIA)
    })

    it("allows photo captures regardless of size rules", () => {
      expect(() =>
        validateCaptureMetadataForDownload({
          capture_id: "IMG_test",
          type: "photo",
          total_size: 0,
          files: [{name: "IMG_test/base.jpg", size: 0, role: "primary"}],
        }),
      ).not.toThrow()
    })
  })

  describe("validateDownloadedMediaFile", () => {
    it("rejects zero-byte files even when expected size is zero", async () => {
      ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
      ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 0})

      await expect(
        validateDownloadedMediaFile({
          path: "/tmp/VID_test/base.mp4",
          name: "VID_test/base.mp4",
          expectedSize: 0,
          mediaKind: "video",
        }),
      ).rejects.toThrow(INVALID_DOWNLOADED_MEDIA)
    })

    it("rejects videos without ftyp signature", async () => {
      ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
      ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 1024})
      ;(RNFS.read as jest.Mock).mockResolvedValue(Buffer.from("not-a-video-file").toString("base64"))

      await expect(
        validateDownloadedMediaFile({
          path: "/tmp/VID_test/base.mp4",
          name: "VID_test/base.mp4",
          mediaKind: "video",
        }),
      ).rejects.toThrow("invalid video container")
    })

    it("accepts valid mp4 header", async () => {
      const header = Buffer.alloc(12)
      header.writeUInt32BE(8, 0) // box size
      header.write("ftyp", 4, 4, "ascii")
      header.write("isom", 8, 4, "ascii")
      ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
      ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 1024})
      ;(RNFS.read as jest.Mock).mockResolvedValue(header.toString("base64"))

      await expect(
        validateDownloadedMediaFile({
          path: "/tmp/VID_test/base.mp4",
          name: "VID_test/base.mp4",
          expectedSize: 1024,
          mediaKind: "video",
        }),
      ).resolves.toBeUndefined()
    })

    it("accepts AVI RIFF header", async () => {
      const header = Buffer.alloc(12)
      header.write("RIFF", 0, 4, "ascii")
      header.writeUInt32LE(0, 4) // size
      header.write("AVI ", 8, 4, "ascii")
      ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
      ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 1024})
      ;(RNFS.read as jest.Mock).mockResolvedValue(header.toString("base64"))

      await expect(
        validateDownloadedMediaFile({
          path: "/tmp/VID_test/clip.avi",
          name: "VID_test/clip.avi",
          mediaKind: "video",
        }),
      ).resolves.toBeUndefined()
    })

    it("accepts EBML header for WebM/MKV", async () => {
      const header = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])
      ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
      ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 1024})
      ;(RNFS.read as jest.Mock).mockResolvedValue(header.toString("base64"))

      await expect(
        validateDownloadedMediaFile({
          path: "/tmp/VID_test/clip.webm",
          name: "VID_test/clip.webm",
          mediaKind: "video",
        }),
      ).resolves.toBeUndefined()
    })

    it("rejects AVIF files when mediaKind is video (ftyp avif brand)", async () => {
      const header = Buffer.alloc(12)
      header.writeUInt32BE(0x20, 0) // box size
      header.write("ftyp", 4, 4, "ascii")
      header.write("avif", 8, 4, "ascii")
      ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
      ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 1024})
      ;(RNFS.read as jest.Mock).mockResolvedValue(header.toString("base64"))

      await expect(
        validateDownloadedMediaFile({
          path: "/tmp/VID_test/base.mp4",
          name: "VID_test/base.mp4",
          mediaKind: "video",
        }),
      ).rejects.toThrow("invalid video container")
    })

    it("accepts AVIF files when mediaKind is photo", async () => {
      const header = Buffer.alloc(12)
      header.writeUInt32BE(0x20, 0)
      header.write("ftyp", 4, 4, "ascii")
      header.write("avif", 8, 4, "ascii")
      ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
      ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 1024})
      ;(RNFS.read as jest.Mock).mockResolvedValue(header.toString("base64"))

      await expect(
        validateDownloadedMediaFile({
          path: "/tmp/IMG_test/base.avif",
          name: "IMG_test/base.avif",
          mediaKind: "photo",
        }),
      ).resolves.toBeUndefined()
    })

    it("accepts JPEG header with high-bit bytes (atob-mangle regression)", async () => {
      // 0xFF 0xD8 0xFF 0xE0 - common JPEG (JFIF) start
      const header = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 0])
      ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
      ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 1024})
      ;(RNFS.read as jest.Mock).mockResolvedValue(header.toString("base64"))

      await expect(
        validateDownloadedMediaFile({
          path: "/tmp/IMG_test/base.jpg",
          name: "IMG_test/base.jpg",
          mediaKind: "photo",
        }),
      ).resolves.toBeUndefined()
    })

    it("accepts non-media sidecars when mediaKind is unknown", async () => {
      ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
      ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 128})

      await expect(
        validateDownloadedMediaFile({
          path: "/tmp/IMG_test/imu.json",
          name: "IMG_test/imu.json",
          expectedSize: 128,
          mediaKind: "unknown",
        }),
      ).resolves.toBeUndefined()

      expect(RNFS.read).not.toHaveBeenCalled()
    })
  })
})
