/**
 * Pure path helper for BlobStore. No React Native / Expo imports, so it's
 * unit-testable in isolation (see blobPaths.test.ts).
 */

/** Filesystem-safe path segment. Strips traversal + unsafe chars; never empty. */
export function sanitizeSegment(s: string): string {
  const cleaned = (s || "").replace(/[^A-Za-z0-9._-]/g, "_")
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "_"
  return cleaned.slice(0, 120)
}

/**
 * Filesystem-safe display name for a shared blob, guaranteed to carry an
 * extension. The on-disk blob name is a generated, extension-less id, so the OS
 * share sheet (which keys off the file path, not any metadata) would otherwise
 * emit an extension-less file — breaking "open with"/preview on the receiving
 * side. Derives the extension from the mimeType when the stored name lacks one.
 */
export function shareFileName(meta: {name?: string; fileName: string; mimeType: string}): string {
  const raw = (meta.name || meta.fileName).trim()
  // Replace path separators + characters illegal on common filesystems (keep
  // spaces, hyphens, dots, etc. — they're valid and keep names readable).
  // eslint-disable-next-line no-control-regex
  let safe = raw.replace(/[/\\<>:"|?*\x00-\x1f]/g, "_").trim()
  if (!safe) safe = meta.fileName
  const dot = safe.lastIndexOf(".")
  const hasExt = dot > 0 && dot < safe.length - 1
  if (hasExt) return safe
  const ext = extForMime(meta.mimeType)
  return ext ? `${safe}.${ext}` : safe
}

/** Best-effort file extension (no dot) for a MIME type. Inverse of inferMime in BlobStore. */
export function extForMime(mime: string): string | undefined {
  const m = (mime || "").split(";")[0].trim().toLowerCase()
  const map: Record<string, string> = {
    "application/pdf": "pdf",
    "application/epub+zip": "epub",
    "application/zip": "zip",
    "application/json": "json",
    "text/plain": "txt",
    "text/csv": "csv",
    "text/html": "html",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/ogg": "ogg",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
  }
  return map[m]
}
