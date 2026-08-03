import {buildMediaDetails, flattenExifMetadata, formatFileSize, formatMediaDuration} from "./mediaMetadata"

describe("gallery media metadata", () => {
  it("formats file sizes and video durations", () => {
    expect(formatFileSize(512)).toBe("512 B")
    expect(formatFileSize(1_572_864)).toBe("1.50 MB")
    expect(formatMediaDuration(65_000)).toBe("1:05")
    expect(formatMediaDuration(3_665_000)).toBe("1:01:05")
  })

  it("builds the core details available for every gallery item", () => {
    const rows = buildMediaDetails(
      {
        name: "capture/IMG_123.jpg",
        url: "file:///photos/IMG_123.jpg",
        download: "file:///photos/IMG_123.jpg",
        filePath: "/photos/IMG_123.jpg",
        size: 1000,
        modified: "2026-01-01T12:00:00.000Z",
        mime_type: "image/jpeg",
        glassesModel: "Mentra Live",
      },
      {width: 4032, height: 3024},
      2048,
    )

    expect(rows).toEqual(
      expect.arrayContaining([
        {label: "Filename", value: "IMG_123.jpg"},
        {label: "Resolution", value: "4032 × 3024"},
        {label: "File size", value: "2.00 KB"},
        {label: "Captured with", value: "Mentra Live"},
      ]),
    )
  })

  it("shows scalar EXIF fields while omitting binary payloads", () => {
    expect(
      flattenExifMetadata({
        Make: "Mentra",
        FNumber: 2.8,
        GPSLatitude: [37, 46, 30],
        MakerNote: new Uint8Array([1, 2, 3]),
        Empty: undefined,
      }),
    ).toEqual([
      {label: "FNumber", value: "2.8"},
      {label: "GPSLatitude", value: "37, 46, 30"},
      {label: "Make", value: "Mentra"},
    ])
  })
})
