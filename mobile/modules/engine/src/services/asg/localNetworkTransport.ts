import * as RNFS from "@dr.pogodin/react-native-fs"
import {otaLocalNetwork, type OtaLocalNetworkDownloadProgress} from "@mentra/bluetooth-sdk/ota-transport"
import CrustModule from "@mentra/crust"
import {glassesHotspot} from "@mentra/glasses-media"
import {Buffer} from "buffer"
import {Platform} from "react-native"
import WifiManager from "react-native-wifi-reborn"
import {BgTimer} from "../../utils/timers"

type DownloadOptions = Parameters<typeof RNFS.downloadFile>[0]
type DownloadHandle = ReturnType<typeof RNFS.downloadFile>

let connectionGeneration = 0
let scopedConnectionActive = false
let nextJobId = 1_000_000
const nativeJobs = new Map<number, string>()
const cancelledNativeJobs = new Set<number>()
let macHotspotOwner: {caller: symbol; nativeId: string} | null = null

export type LocalNetworkErrorDetails = {
  code?: string | number
  domain?: string
  message?: string
  underlying?: {code?: string | number; domain?: string}
  native?: {code: number; domain: string; completed: true; underlying?: {code: number; domain: string}}
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
    ["ERR_HOTSPOT_JOIN", "ERR_HOTSPOT_CANCELLED", "ERR_HOTSPOT_NATIVE"].includes(details.code) &&
    message !== undefined
      ? message.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 512)
      : details.code === "ERR_UNEXPECTED" && message !== undefined ? legacyHotspotCause(message) : undefined
  const userInfo = (error as {userInfo?: unknown} | null | undefined)?.userInfo
  const underlying = facts(
    userInfo && typeof userInfo === "object"
      ? (userInfo as {NSUnderlyingError?: unknown}).NSUnderlyingError
      : undefined,
  )
  const nativeValue =
    userInfo && typeof userInfo === "object" ? (userInfo as {RNWifiNativeError?: unknown}).RNWifiNativeError : undefined
  const nativeFacts = facts(nativeValue)
  const native =
    nativeValue &&
    typeof nativeValue === "object" &&
    (nativeValue as {completed?: unknown}).completed === true &&
    typeof nativeFacts.code === "number" &&
    Number.isSafeInteger(nativeFacts.code) &&
    nativeFacts.domain
      ? {code: nativeFacts.code, domain: nativeFacts.domain, completed: true as const}
      : undefined
  const nativeUnderlying = facts((nativeValue as {underlying?: unknown} | undefined)?.underlying)
  return {
    ...details,
    ...(hotspotMessage ? {message: hotspotMessage} : {}),
    ...(Object.keys(underlying).length ? {underlying} : {}),
    ...(native
      ? {
          native: {
            ...native,
            ...(typeof nativeUnderlying.code === "number" &&
            Number.isSafeInteger(nativeUnderlying.code) &&
            nativeUnderlying.domain
              ? {underlying: {code: nativeUnderlying.code, domain: nativeUnderlying.domain}}
              : {}),
          },
        }
      : {}),
  }
}

export function shouldUseScopedLocalNetwork(os: string, moduleAvailable: boolean): boolean {
  return os === "android" && moduleAvailable
}

function supportsScopedConnection(): boolean {
  return shouldUseScopedLocalNetwork(Platform.OS, otaLocalNetwork.isAvailable())
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

export const localNetworkTransport = {
  supportsScopedConnection: (): boolean => supportsScopedConnection(),
  isScopedConnectionActive: (): boolean => scopedConnectionActive,

  async connect(
    caller: symbol,
    ssid: string,
    password: string,
    options?: {
      retryIosInternalError?: true
      assertCurrent?: () => void
      gateway?: string
      purpose?: "outgoing-client" | "incoming-server"
    },
  ): Promise<string | undefined> {
    const isMac = Platform.OS === "ios" && CrustModule.isIOSAppOnMac === true
    if (isMac && macHotspotOwner) throw new Error("Previous Mac hotspot session has not been released")
    const generation = ++connectionGeneration
    const assertCurrent = () => {
      if (generation !== connectionGeneration) throw new Error("Local network connection was superseded")
      options?.assertCurrent?.()
    }
    assertCurrent()
    scopedConnectionActive = false
    nativeJobs.clear()
    if (isMac) {
      const owner = requestId("mac_hotspot")
      macHotspotOwner = {caller, nativeId: owner}
      try {
        const address = await glassesHotspot.join(
          owner,
          ssid,
          password,
          options?.gateway,
          options?.purpose ?? "outgoing-client",
        )
        assertCurrent()
        return address
      } catch (error) {
        try {
          await glassesHotspot.leave(owner)
        } catch (cleanupError) {
          console.warn("[LocalNetworkTransport] Mac hotspot cleanup failed", localNetworkErrorDetails(cleanupError))
          throw error
        }
        if (macHotspotOwner?.nativeId === owner) macHotspotOwner = null
        throw error
      }
    }
    if (!supportsScopedConnection()) {
      // Gallery already owns its retry loop. OTA opts into this same-network
      // policy only with current-attempt authority; never race a pending native call.
      const retryDeadline = Date.now() + 30_000
      for (let attempt = 1; ; attempt += 1) {
        assertCurrent()
        try {
          await WifiManager.connectToProtectedSSID(ssid, password, false, false)
          // Report acquisition first; the caller records it before its own
          // identity check and normal teardown of a replaced OTA attempt.
          return undefined
        } catch (error) {
          assertCurrent()
          const details = localNetworkErrorDetails(error)
          console.warn("[LocalNetworkTransport] hotspot join rejected", {attempt, ...details})
          if (
            !options?.retryIosInternalError ||
            Platform.OS !== "ios" ||
            attempt >= 3 ||
            details.native?.domain !== "NEHotspotConfigurationErrorDomain" ||
            details.native.code !== 8 ||
            Date.now() + 3_000 > retryDeadline
          )
            throw error
          await new Promise<void>((resolve) => BgTimer.setTimeout(resolve, 3_000))
          assertCurrent()
          if (Date.now() > retryDeadline) throw error
        }
      }
    }
    const result = await otaLocalNetwork.connect(ssid, password)
    scopedConnectionActive = true
    return result.localAddress
  },

  async disconnect(caller: symbol): Promise<void> {
    if (macHotspotOwner && macHotspotOwner.caller !== caller) return
    connectionGeneration += 1
    if (macHotspotOwner) {
      const owner = macHotspotOwner.nativeId
      await glassesHotspot.leave(owner)
      if (macHotspotOwner?.nativeId === owner) macHotspotOwner = null
    }
    if (supportsScopedConnection()) {
      await otaLocalNetwork.disconnect()
    }
    scopedConnectionActive = false
    nativeJobs.clear()
  },

  async fetch(url: string | URL | Request, init?: RequestInit, timeoutMs = 30_000): Promise<Response> {
    if (!scopedConnectionActive || !otaLocalNetwork.isAvailable() || typeof url !== "string") {
      return globalThis.fetch(url, init)
    }

    const nativeModule = otaLocalNetwork
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
    if (!scopedConnectionActive || !otaLocalNetwork.isAvailable()) return RNFS.downloadFile(options)

    const jobId = nextJobId++
    const id = requestId("download")
    let began = false
    nativeJobs.set(jobId, id)
    const subscription = otaLocalNetwork.onDownloadProgress((event: OtaLocalNetworkDownloadProgress) => {
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

    const promise = otaLocalNetwork
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
        subscription.remove()
      })

    return {jobId, promise} as DownloadHandle
  },

  stopDownload(jobId: number): void {
    const nativeId = nativeJobs.get(jobId)
    if (nativeId && otaLocalNetwork.isAvailable()) {
      cancelledNativeJobs.add(jobId)
      void otaLocalNetwork.cancel(nativeId)
      return
    }
    RNFS.stopDownload(jobId)
  },
}

otaLocalNetwork.onNetworkLost(() => {
  scopedConnectionActive = false
  nativeJobs.clear()
})
