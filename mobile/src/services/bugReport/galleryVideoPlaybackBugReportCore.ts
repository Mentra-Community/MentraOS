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

export function galleryVideoIncidentDedupeKey(photoName: string, parsed: SerializedVideoPlayerError): string {
  return `${photoName}|${parsed.domain ?? ""}|${String(parsed.code ?? "")}`
}

/**
 * @param registry - mutable dedupe store
 * @returns true if caller should skip filing (duplicate within window)
 */
export function galleryVideoReportDedupeShouldSkip(
  key: string,
  nowMs: number,
  windowMs: number,
  registry: Map<string, number>,
): boolean {
  const prev = registry.get(key)
  if (prev !== undefined && nowMs - prev < windowMs) {
    return true
  }
  registry.set(key, nowMs)
  for (const [k, t] of registry) {
    if (nowMs - t > windowMs * 3) {
      registry.delete(k)
    }
  }
  return false
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
