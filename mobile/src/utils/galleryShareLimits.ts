export const MAX_GALLERY_SHARE_ITEMS = 50

export function canShareGallerySelection(itemCount: number): boolean {
  return itemCount > 0 && itemCount <= MAX_GALLERY_SHARE_ITEMS
}
