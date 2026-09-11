// This test targets the engine source directly because the helper is intentionally internal.
import {toPortableGalleryPath} from "../../../modules/engine/src/services/asg/galleryPathMigration"

describe("toPortableGalleryPath", () => {
  const currentDocuments = "/var/mobile/Containers/Data/Application/NEW/Documents"

  it("stores current container paths relative to Documents", () => {
    expect(toPortableGalleryPath(`${currentDocuments}/MentraPhotos/IMG_1/base.jpg`, currentDocuments)).toBe(
      "MentraPhotos/IMG_1/base.jpg",
    )
  })

  it("recovers paths from an old iOS container UUID", () => {
    expect(
      toPortableGalleryPath(
        "/var/mobile/Containers/Data/Application/OLD/Documents/MentraPhotos/VID_1/base.mp4",
        currentDocuments,
      ),
    ).toBe("MentraPhotos/VID_1/base.mp4")
  })

  it("quarantines unrelated absolute paths", () => {
    expect(toPortableGalleryPath("/private/tmp/unrelated.jpg", currentDocuments)).toBeNull()
    expect(toPortableGalleryPath("/private/tmp/MentraPhotos/IMG_1/base.jpg", currentDocuments)).toBeNull()
  })

  it("rejects relative paths that escape gallery storage", () => {
    expect(toPortableGalleryPath("MentraPhotos/../outside.jpg", currentDocuments)).toBeNull()
    expect(toPortableGalleryPath("../../outside.jpg", currentDocuments)).toBeNull()
  })
})
