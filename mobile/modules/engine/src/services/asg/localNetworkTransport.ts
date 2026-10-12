import * as RNFS from "@dr.pogodin/react-native-fs"
import {otaLocalNetwork, type OtaLocalNetworkDownloadProgress} from "@mentra/bluetooth-sdk/ota-transport"
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

export type LocalNetworkErrorDetails = {
  code?: string | number
  domain?: string
  underlying?: {code?: string | number; domain?: string}
  native?: {code: number; domain: string; completed: true; underlying?: {code: number; domain: string}}
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
    ssid: string,
    password: string,
    options?: {retryIosInternalError: true; assertCurrent: () => void},
  ): Promise<string | undefined> {
    const generation = ++connectionGeneration
    const assertCurrent = () => {
      if (generation !== connectionGeneration) throw new Error("Local network connection was superseded")
      options?.assertCurrent()
    }
    assertCurrent()
    scopedConnectionActive = false
    nativeJobs.clear()
    if (!supportsScopedConnection()) {
      // Gallery already owns its retry loop. OTA opts into this same-network
      // policy only with current-attempt authority; never race a pending native call.
      const retryDeadline = Date.now() + 30_000
      for (let attempt = 1; ; attempt += 1) {
        assertCurrent()
        try {
          await WifiManager.connectToProtectedSSID(ssid, password, false, false)
          assertCurrent()
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

  async disconnect(): Promise<void> {
    connectionGeneration += 1
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
