import * as RNFS from "@dr.pogodin/react-native-fs"
import {glassesWifiLink} from "@mentra/bluetooth-sdk/glasses-wifi"
import {Buffer} from "buffer"

type DownloadOptions = Parameters<typeof RNFS.downloadFile>[0]
type DownloadHandle = ReturnType<typeof RNFS.downloadFile>

let nextJobId = 1_000_000
const nativeJobs = new Map<number, string>()
const cancelledNativeJobs = new Set<number>()

export type LocalNetworkErrorDetails = {
  code?: string | number
  domain?: string
  message?: string
  underlying?: {code?: string | number; domain?: string}
}

// Existing native builds wrap these app-authored LocalMediaError causes in ERR_UNEXPECTED.
// Expo keeps the cause in Error.message, but normal Error serialization omits it.
// Recover only exact owned causes, never arbitrary NSError descriptions or network identities.
const legacyHotspotCauses = new Set([
  "Previous hotspot session has not been released",
  "Previous hotspot session has not finished cleaning up",
  "Invalid hotspot access purpose",
  "The glasses reported an invalid hotspot gateway",
  "The glasses did not report their hotspot gateway",
  "The glasses hotspot is already in use",
  "Hotspot join timed out",
  "Hotspot join cancelled",
  "Location access is required to identify the glasses hotspot on Mac",
  "Mac hotspot Location authorization is unavailable",
  "Location access is required to verify the current Mac Wi-Fi network",
  "Mac Wi-Fi did not associate with the requested glasses hotspot",
  "Mac Wi-Fi framework is unavailable",
  "Mac Wi-Fi interface is unavailable",
  "Mac Wi-Fi interface does not support hotspot association",
  "Mac Wi-Fi interface has no identity",
  "Mac Wi-Fi interface disappeared during association",
  "The requested glasses hotspot was not found by Mac Wi-Fi",
  "Mac Wi-Fi has no verified glasses hotspot address",
  "Local connection to the glasses timed out",
])

function legacyHotspotCause(message: string): string | undefined {
  if (message.length > 2048) return undefined
  const cause = message.split("\n→ Caused by: ").at(-1)!
  if (legacyHotspotCauses.has(cause)) return cause
  return /^Mac Wi-Fi (scan|association) failed \([A-Za-z0-9_.-]{1,128}, -?\d{1,12}\)$/.test(cause) ? cause : undefined
}

/** Keep native connection facts ahead of large stacks and private NSError userInfo. */
export function localNetworkErrorDetails(error: unknown): LocalNetworkErrorDetails {
  const facts = (value: unknown): {code?: string | number; domain?: string} => {
    if (!value || typeof value !== "object") return {}
    const {code, domain} = value as {code?: unknown; domain?: unknown}
    return {
      ...(typeof code === "number" && Number.isFinite(code)
        ? {code}
        : typeof code === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(code)
        ? {code}
        : {}),
      ...(typeof domain === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(domain) ? {domain} : {}),
    }
  }
  const details = facts(error)
  const message = error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message
    : undefined
  const hotspotMessage =
    typeof details.code === "string" &&
    ["ERR_HOTSPOT_JOIN", "ERR_HOTSPOT_CANCELLED", "ERR_HOTSPOT_NATIVE", "ERR_HOTSPOT_USER_DENIED"].includes(
      details.code,
    ) &&
    message !== undefined
      ? message.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 512)
      : details.code === "ERR_UNEXPECTED" && message !== undefined ? legacyHotspotCause(message) : undefined
  const userInfo = (error as {userInfo?: unknown} | null | undefined)?.userInfo
  const underlying = facts(
    userInfo && typeof userInfo === "object"
      ? (userInfo as {NSUnderlyingError?: unknown}).NSUnderlyingError
      : undefined,
  )
  return {
    ...details,
    ...(hotspotMessage ? {message: hotspotMessage} : {}),
    ...(Object.keys(underlying).length ? {underlying} : {}),
  }
}

function normalizeHeaders(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) {
    const result: Record<string, string> = {}
    headers.forEach((value, key) => {
      result[key] = value
    })
    return result
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return {...headers}
}

function requestId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

/**
 * Requests to the glasses over the glasses Wi-Fi link, which the Bluetooth SDK's glasses Wi-Fi
 * service brings up: on Android they go over its joined `Network`, else the system's route.
 */
export const localNetworkTransport = {
  async fetch(url: string | URL | Request, init?: RequestInit, timeoutMs = 30_000): Promise<Response> {
    if (!glassesWifiLink.isScoped() || typeof url !== "string") {
      return globalThis.fetch(url, init)
    }

    const nativeModule = glassesWifiLink
    const id = requestId("request")
    const signal = init?.signal
    const cancel = () => void nativeModule.cancel(id)
    if (signal?.aborted) throw new Error("Request aborted")
    signal?.addEventListener("abort", cancel, {once: true})
    try {
      const result = await nativeModule.request(
        id,
        url,
        init?.method || "GET",
        normalizeHeaders(init?.headers),
        typeof init?.body === "string" ? init.body : null,
        timeoutMs,
      )
      const bytes = Buffer.from(result.bodyBase64, "base64")
      return new Response(bytes as unknown as BodyInit, {
        status: result.status,
        headers: result.headers,
      })
    } finally {
      signal?.removeEventListener("abort", cancel)
    }
  },

  downloadFile(options: DownloadOptions): DownloadHandle {
    if (!glassesWifiLink.isScoped()) return RNFS.downloadFile(options)

    const jobId = nextJobId++
    const id = requestId("download")
    let began = false
    nativeJobs.set(jobId, id)
    const subscription = glassesWifiLink.onDownloadProgress((event) => {
      if (event.requestId !== id) return
      if (!began) {
        began = true
        options.begin?.({
          jobId,
          statusCode: event.statusCode || 200,
          contentLength: event.contentLength,
          headers: event.headers || {},
        })
      }
      options.progress?.({
        jobId,
        contentLength: event.contentLength,
        bytesWritten: event.bytesWritten,
      })
    })

    const promise = glassesWifiLink
      .download(
        id,
        options.fromUrl,
        options.toFile,
        options.headers || {},
        options.connectionTimeout || 30_000,
        options.readTimeout || 30_000,
      )
      .then((result) => {
        if (!began) {
          options.begin?.({
            jobId,
            statusCode: result.statusCode,
            contentLength: result.bytesWritten,
            headers: result.headers,
          })
        }
        return {
          jobId,
          statusCode: result.statusCode,
          bytesWritten: result.bytesWritten,
        }
      })
      .catch((error) => {
        if (cancelledNativeJobs.has(jobId)) throw new Error("Sync cancelled")
        throw error
      })
      .finally(() => {
        nativeJobs.delete(jobId)
        cancelledNativeJobs.delete(jobId)
        subscription()
      })

    return {jobId, promise} as DownloadHandle
  },

  stopDownload(jobId: number): void {
    const nativeId = nativeJobs.get(jobId)
    if (nativeId) {
      cancelledNativeJobs.add(jobId)
      void glassesWifiLink.cancel(nativeId)
      return
    }
    RNFS.stopDownload(jobId)
  },
}
