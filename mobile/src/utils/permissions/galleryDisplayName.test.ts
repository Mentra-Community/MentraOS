import {deriveGalleryDisplayName} from "../../../modules/engine/src/utils/permissions/galleryDisplayName"

describe("deriveGalleryDisplayName", () => {
  it("uses capture folder name for base.jpg in capture directories", () => {
    expect(
      deriveGalleryDisplayName(
        "/data/user/0/com.mentra.mentra/files/MentraPhotos/IMG_20260608_024955_542_146/base.jpg",
      ),
    ).toBe("IMG_20260608_024955_542_146.jpg")
  })

  it("uses capture folder name for processed photo outputs", () => {
    expect(
      deriveGalleryDisplayName(
        "/data/user/0/com.mentra.mentra/files/MentraPhotos/IMG_20260608_024955_542_146/base.jpg.processed.jpg",
      ),
    ).toBe("IMG_20260608_024955_542_146.jpg")
  })

  it("uses capture folder name for base.mp4 in capture directories", () => {
    expect(deriveGalleryDisplayName("/tmp/VID_20260606_090222_158_588/base.mp4")).toBe(
      "VID_20260606_090222_158_588.mp4",
    )
  })

  it("uses capture folder name for stabilized video outputs", () => {
    expect(
      deriveGalleryDisplayName("/tmp/VID_20260606_090222_158_588/base.mp4.stabilized.mp4"),
    ).toBe("VID_20260606_090222_158_588.mp4")
  })

  it("keeps legacy flat filenames unchanged", () => {
    expect(deriveGalleryDisplayName("/data/MentraPhotos/IMG_20260513_135936_005_426.jpg")).toBe(
      "IMG_20260513_135936_005_426.jpg",
    )
  })
})
