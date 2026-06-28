export const GALLERY_VIDEO_REPORT_DEDUPE_MS = 90_000

export interface SerializedVideoPlayerError {
  domain?: string
  code?: string | number
  localizedDescription?: string
  errorString?: string
  raw: string
}

export function serializeReactNativeVideoOnError(error: unknown): SerializedVideoPlayerError {
  const e = error as {
    error?: {
      domain?: string
      code?: number | string
      localizedDescription?: string
      errorString?: string
    }
  }
  const inner = e?.error
  let raw: string
  try {
    raw = JSON.stringify(error ?? null)
  } catch {
    raw = String(error)
  }
  return {
    domain: inner?.domain,
    code: inner?.code,
    localizedDescription: inner?.localizedDescription,
    errorString: inner?.errorString,
    raw,
  }
}

export function galleryVideoReportDedupeKey(photoName: string, parsed: SerializedVideoPlayerError): string {
  return `${photoName}|${parsed.domain ?? ""}|${String(parsed.code ?? "")}`
}

export function uriSchemeFromPlaybackUrl(url: string): string {
  if (url.startsWith("file:") || url.startsWith("/")) {
    return "file"
  }
  if (url.startsWith("https:")) {
    return "https"
  }
  if (url.startsWith("http:")) {
    return "http"
  }
  return "other"
}
