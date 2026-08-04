const CAPTURE_FOLDER_PATTERN = /^(IMG|VID)_/

/**
 * Derive a unique MediaStore display name for camera-roll saves.
 *
 * Capture downloads use folder layout `IMG_xxx/base.jpg` (or `VID_xxx/base.mp4`).
 * Using the leaf filename (`base.jpg`) causes MediaStore collisions on Android.
 */
export function deriveGalleryDisplayName(filePath: string): string {
  const cleanPath = filePath.replace("file://", "")
  const lastSlash = cleanPath.lastIndexOf("/")
  if (lastSlash < 0) {
    return cleanPath
  }

  const fileName = cleanPath.substring(lastSlash + 1)
  const parentDir = cleanPath.substring(0, lastSlash)
  const parentSlash = parentDir.lastIndexOf("/")
  const parentName = parentSlash < 0 ? parentDir : parentDir.substring(parentSlash + 1)

  if (!CAPTURE_FOLDER_PATTERN.test(parentName)) {
    return fileName
  }

  const isVideo = /\.(mp4|mov|m4v|avi)(\.|$)/i.test(fileName)
  const extension = isVideo ? "mp4" : "jpg"
  return `${parentName}.${extension}`
}
