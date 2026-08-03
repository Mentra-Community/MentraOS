/** Convert current or legacy app-container paths into a portable Documents-relative path. */
export function toPortableGalleryPath(path: string, documentDirectoryPath: string): string | null {
  if (!path) return null
  const cleanPath = path.replace(/^file:\/\//, "")
  const docPath = documentDirectoryPath.replace(/\/$/, "")
  let candidate: string | null = null
  if (cleanPath.startsWith(`${docPath}/`)) candidate = cleanPath.substring(docPath.length + 1)
  else if (!cleanPath.startsWith("/")) candidate = cleanPath.replace(/^\/+/, "")

  if (!candidate) {
    const documentsMarker = "/Documents/"
    const documentsIndex = cleanPath.indexOf(documentsMarker)
    if (documentsIndex >= 0) candidate = cleanPath.substring(documentsIndex + documentsMarker.length)
  }

  if (!candidate || candidate.includes("\0")) return null
  const segments = candidate.split("/")
  if (segments[0] !== "MentraPhotos" || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null
  }
  return segments.join("/")
}
