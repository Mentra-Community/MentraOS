export type OtaArtifactFailureCategory =
  | "internet"
  | "connection"
  | "server"
  | "timeout"
  | "storage"
  | "save"
  | "secure_connection"
  | "download"
  | "verify"

export interface OtaArtifactFailure {
  artifact: "apk" | "mtk" | "bes" | null
  stage: "download" | "verify" | "save"
  category: OtaArtifactFailureCategory
  httpStatus?: number
  bytesWritten: number
  contentLength: number
  nativeErrors: {name?: string; code?: string; domain?: string; message?: string}[]
}

/** Never retain artifact URLs, local paths, headers, or arbitrary native userInfo. */
function privateErrorText(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined
  return String(value)
    .replace(/(?:https?|file):\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")
    .replace(/\/(?:data|var|private|storage|Users)\/[^\s"'<>]*/g, "[REDACTED_PATH]")
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi, "[REDACTED_HEADER]")
    .replace(
      /\b(?:bearer\s+\S+|(?:token|password|signature|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+))/gi,
      "[REDACTED]",
    )
    .slice(0, 500)
}

/** Preserve Error's non-enumerable fields before JSON serialization drops them. */
export function otaArtifactFailure(
  error: unknown,
  context: Omit<OtaArtifactFailure, "category" | "nativeErrors">,
): OtaArtifactFailure {
  const nativeErrors: OtaArtifactFailure["nativeErrors"] = []
  const seen = new Set<unknown>()
  let current = error
  for (let depth = 0; current != null && depth < 4 && !seen.has(current); depth++) {
    seen.add(current)
    if (typeof current !== "object") {
      nativeErrors.push({message: privateErrorText(current)})
      break
    }
    const detail = current as Record<string, unknown>
    nativeErrors.push({
      name: privateErrorText(detail.name),
      code: privateErrorText(detail.code),
      domain: privateErrorText(detail.domain),
      message: privateErrorText(detail.message),
    })
    current = detail.cause
  }
  const text = nativeErrors.map((entry) => Object.values(entry).join(" ")).join(" ")
  let httpStatus = context.httpStatus
  if (context.stage === "download" && httpStatus === undefined) {
    // BackgroundOtaArtifactDownloader.swift rejects non-2xx responses instead of
    // resolving a status. Expo can wrap this exact producer message in another Error.
    for (const entry of nativeErrors) {
      const response = /\bArtifact download failed with HTTP ([1-5]\d{2})\b/.exec(entry.message ?? "")
      if (response) {
        httpStatus = Number(response[1])
        break
      }
    }
  }
  // A DNS error, timeout, reset, or HTTP failure alone does not establish no internet.
  let category: OtaArtifactFailureCategory = context.stage === "verify" ? "verify" : "download"
  if (/\bENOSPC\b|No space left on device/i.test(text)) category = "storage"
  else if (context.stage === "save") category = "save"
  else if (context.stage === "download") {
    if (/\b(?:EACCES|EROFS)\b|Permission denied|Read-only file system/i.test(text)) category = "save"
    else if (
      httpStatus !== undefined &&
      httpStatus >= 100 &&
      httpStatus <= 599 &&
      httpStatus !== 200 &&
      httpStatus !== 206
    )
      category = "server"
    else if (
      nativeErrors.some((entry) => entry.domain === "NSURLErrorDomain" && entry.code === "-1009") ||
      /\b(?:ENETDOWN|NSURLErrorNotConnectedToInternet)\b|Network is down|not connected to the Internet/i.test(text)
    )
      category = "internet"
    else if (/\b(?:ETIMEDOUT|SocketTimeoutException)\b|timed? out/i.test(text)) category = "timeout"
    else if (/\b(?:SSLHandshakeException|SSLPeerUnverifiedException|CERTIFICATE_VERIFY_FAILED)\b/i.test(text))
      category = "secure_connection"
    else if (
      /\b(?:ENETUNREACH|ECONNRESET|ECONNABORTED|EPIPE|UnknownHostException|EAI_NODATA|EAI_AGAIN)\b|Software caused connection abort|Connection reset|Unable to resolve host/i.test(
        text,
      )
    )
      category = "connection"
  }
  return {...context, httpStatus, category, nativeErrors}
}
