import {canShareGallerySelection, MAX_GALLERY_SHARE_ITEMS} from "./galleryShareLimits"

describe("gallery share limits", () => {
  it("allows selections up to the 50-item limit", () => {
    expect(canShareGallerySelection(1)).toBe(true)
    expect(canShareGallerySelection(MAX_GALLERY_SHARE_ITEMS)).toBe(true)
  })

  it("rejects empty and oversized selections", () => {
    expect(canShareGallerySelection(0)).toBe(false)
    expect(canShareGallerySelection(MAX_GALLERY_SHARE_ITEMS + 1)).toBe(false)
  })
})
