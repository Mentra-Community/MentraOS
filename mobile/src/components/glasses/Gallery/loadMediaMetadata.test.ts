import * as RNFS from "@dr.pogodin/react-native-fs"
import {parse} from "exifr/src/bundles/nano.mjs"

import {PhotoInfo} from "@/types/asg"

import {loadMediaMetadata} from "./loadMediaMetadata"

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

describe("loadMediaMetadata", () => {
  beforeEach(() => {
    jest.clearAllMocks()
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
