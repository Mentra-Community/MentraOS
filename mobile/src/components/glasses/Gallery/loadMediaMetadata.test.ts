import * as RNFS from "@dr.pogodin/react-native-fs"
import {parse} from "exifr/src/bundles/nano.mjs"

import {PhotoInfo} from "@/types/asg"

import {loadMediaMetadata, readJpegDimensions} from "./loadMediaMetadata"

jest.mock("@dr.pogodin/react-native-fs", () => ({
  read: jest.fn(),
  stat: jest.fn(),
}))

jest.mock("exifr/src/bundles/nano.mjs", () => ({
  parse: jest.fn(),
}))

jest.mock("exifr/src/dicts/tiff-exif-keys.mjs", () => ({}))
jest.mock("exifr/src/dicts/tiff-exif-values.mjs", () => ({}))
jest.mock("exifr/src/dicts/tiff-gps-keys.mjs", () => ({}))
jest.mock("exifr/src/dicts/tiff-ifd0-keys.mjs", () => ({}))
jest.mock("exifr/src/dicts/tiff-ifd0-values.mjs", () => ({}))
jest.mock("exifr/src/dicts/tiff-revivers.mjs", () => ({}))

const PHOTO: PhotoInfo = {
  name: "IMG_test",
  url: "file:///tmp/IMG_test.jpg",
  download: "file:///tmp/IMG_test.jpg",
  filePath: "/tmp/IMG_test.jpg",
  size: 4 * 1024 * 1024,
  modified: 0,
  mime_type: "image/jpeg",
}

// SOI, an APP1 segment, a DHT segment (0xC4 sits in the frame-marker range but
// is not a frame), a fill byte, then a baseline frame header for 4032 x 3024.
const JPEG_HEADER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe1, 0x00, 0x04, 0x45, 0x78, 0xff, 0xc4, 0x00, 0x03, 0x00, 0xff, 0xff, 0xc0, 0x00, 0x11, 0x08,
  0x0b, 0xd0, 0x0f, 0xc0, 0x03,
])

describe("readJpegDimensions", () => {
  it("reads the frame header after other segments", () => {
    expect(readJpegDimensions(JPEG_HEADER)).toEqual({width: 4032, height: 3024})
  })

  it("rejects data that is not a JPEG or ends before the frame header", () => {
    expect(readJpegDimensions(Buffer.from("not a jpeg"))).toBeNull()
    expect(readJpegDimensions(JPEG_HEADER.subarray(0, 18))).toBeNull()
    expect(readJpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull()
  })
})

describe("loadMediaMetadata", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("reports the stored pixel size even without EXIF metadata", async () => {
    ;(RNFS.stat as jest.Mock).mockResolvedValue({size: PHOTO.size})
    ;(RNFS.read as jest.Mock).mockResolvedValue(JPEG_HEADER.toString("base64"))
    ;(parse as jest.Mock).mockRejectedValue(new Error("No EXIF"))

    await expect(loadMediaMetadata(PHOTO)).resolves.toEqual({
      actualSize: PHOTO.size,
      dimensions: {width: 4032, height: 3024},
      exif: null,
    })
  })

  it("swaps the stored size for quarter-turn EXIF orientations", async () => {
    ;(RNFS.stat as jest.Mock).mockResolvedValue({size: PHOTO.size})
    ;(RNFS.read as jest.Mock).mockResolvedValue(JPEG_HEADER.toString("base64"))
    ;(parse as jest.Mock).mockResolvedValue({Orientation: "Rotate 90 CW"})

    await expect(loadMediaMetadata(PHOTO)).resolves.toMatchObject({dimensions: {width: 3024, height: 4032}})
  })

  it("parses a bounded prefix instead of loading the entire photo", async () => {
    ;(RNFS.stat as jest.Mock).mockResolvedValue({size: PHOTO.size})
    ;(RNFS.read as jest.Mock).mockResolvedValue(Buffer.from("jpeg header").toString("base64"))
    ;(parse as jest.Mock).mockResolvedValue({Make: "Mentra"})

    await expect(loadMediaMetadata(PHOTO)).resolves.toEqual({
      actualSize: PHOTO.size,
      exif: {Make: "Mentra"},
    })

    expect(RNFS.read).toHaveBeenCalledWith(PHOTO.filePath, 512 * 1024, 0, "base64")
    expect(parse).toHaveBeenCalledTimes(1)
  })

  it("does not initialize the photo parser for videos", async () => {
    ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 1024})

    await expect(
      loadMediaMetadata({
        ...PHOTO,
        name: "VID_test",
        filePath: "/tmp/VID_test.mp4",
        is_video: true,
        mime_type: "video/mp4",
      }),
    ).resolves.toEqual({actualSize: 1024, exif: null})

    expect(RNFS.read).not.toHaveBeenCalled()
    expect(parse).not.toHaveBeenCalled()
  })
})
