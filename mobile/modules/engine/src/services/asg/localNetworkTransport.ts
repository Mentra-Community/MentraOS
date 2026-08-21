import * as RNFS from "@dr.pogodin/react-native-fs"
import {MentraLocalNetwork, type LocalNetworkDownloadProgress} from "@mentra/bluetooth-sdk/internal"
import {Buffer} from "buffer"
import {Platform} from "react-native"
import WifiManager from "react-native-wifi-reborn"

type DownloadOptions = Parameters<typeof RNFS.downloadFile>[0]
type DownloadHandle = ReturnType<typeof RNFS.downloadFile>

let scopedConnectionActive = false
let nextJobId = 1_000_000
const nativeJobs = new Map<number, string>()
const cancelledNativeJobs = new Set<number>()

export function shouldUseScopedLocalNetwork(os: string, moduleAvailable: boolean): boolean {
  return os === "android" && moduleAvailable
}

function supportsScopedConnection(): boolean {
  return shouldUseScopedLocalNetwork(Platform.OS, MentraLocalNetwork != null)
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

  async connect(ssid: string, password: string): Promise<string | undefined> {
    scopedConnectionActive = false
    nativeJobs.clear()
    if (!supportsScopedConnection()) {
      await WifiManager.connectToProtectedSSID(ssid, password, false, false)
      return undefined
    }
    const result = await MentraLocalNetwork!.connect(ssid, password)
    scopedConnectionActive = true
    return result.localAddress
  },

  async disconnect(): Promise<void> {
    if (supportsScopedConnection()) {
      await MentraLocalNetwork!.disconnect().catch(() => {})
    }
    scopedConnectionActive = false
    nativeJobs.clear()
  },

  async fetch(url: string | URL | Request, init?: RequestInit, timeoutMs = 30_000): Promise<Response> {
    if (!scopedConnectionActive || !MentraLocalNetwork || typeof url !== "string") {
      return globalThis.fetch(url, init)
    }

    const nativeModule = MentraLocalNetwork
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
    if (!scopedConnectionActive || !MentraLocalNetwork) return RNFS.downloadFile(options)

    const jobId = nextJobId++
    const id = requestId("download")
    let began = false
    nativeJobs.set(jobId, id)
    const subscription = MentraLocalNetwork.addListener("downloadProgress", (event: LocalNetworkDownloadProgress) => {
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

    const promise = MentraLocalNetwork.download(
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
    if (nativeId && MentraLocalNetwork) {
      cancelledNativeJobs.add(jobId)
      void MentraLocalNetwork.cancel(nativeId)
      return
    }
    RNFS.stopDownload(jobId)
  },
}

MentraLocalNetwork?.addListener("networkLost", () => {
  scopedConnectionActive = false
  nativeJobs.clear()
})
