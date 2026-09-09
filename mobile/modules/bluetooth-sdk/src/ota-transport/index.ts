// This public adapter is the package-owned boundary over its native implementation.
// eslint-disable-next-line no-restricted-imports
import MentraLocalNetwork from "../_private/MentraLocalNetworkModule"
// eslint-disable-next-line no-restricted-imports
import MentraOtaServer from "../ota-server"

export type OtaTransportSubscription = {remove(): void}

export type OtaLocalNetworkConnection = {
  connected: boolean
  ssid: string
  localAddress?: string
}

export type OtaLocalNetworkLostEvent = {ssid: string}

export type OtaLocalNetworkResponse = {
  status: number
  headers: Record<string, string>
  bodyBase64: string
}

export type OtaLocalNetworkDownloadResult = {
  statusCode: number
  bytesWritten: number
  headers: Record<string, string>
}

export type OtaLocalNetworkDownloadProgress = {
  requestId: string
  bytesWritten: number
  contentLength: number
  statusCode?: number
  headers?: Record<string, string>
}

export type OtaArtifactDownloadProgress = {
  destination: string
  bytesWritten: number
  contentLength: number
}

export type OtaServerResult = {
  baseUrl: string
  host: string
  manifestUrl: string
  port: number
}

/**
 * Scoped networking for traffic that must stay on a Mentra Live hotspot while
 * the phone's default route remains on cellular or another Wi-Fi network.
 *
 * The module is optional because iOS uses its system Wi-Fi join flow instead.
 */
export const otaLocalNetwork = Object.freeze({
  isAvailable: (): boolean => MentraLocalNetwork != null,
  connect: async (ssid: string, password: string): Promise<OtaLocalNetworkConnection> => {
    if (!MentraLocalNetwork) throw new Error("Scoped local networking is not available in this native build")
    return MentraLocalNetwork.connect(ssid, password)
  },
  request: async (
    requestId: string,
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
    timeoutMs: number,
  ): Promise<OtaLocalNetworkResponse> => {
    if (!MentraLocalNetwork) throw new Error("Scoped local networking is not available in this native build")
    return MentraLocalNetwork.request(requestId, url, method, headers, body, timeoutMs)
  },
  download: async (
    requestId: string,
    url: string,
    destination: string,
    headers: Record<string, string>,
    connectionTimeoutMs: number,
    readTimeoutMs: number,
  ): Promise<OtaLocalNetworkDownloadResult> => {
    if (!MentraLocalNetwork) throw new Error("Scoped local networking is not available in this native build")
    return MentraLocalNetwork.download(requestId, url, destination, headers, connectionTimeoutMs, readTimeoutMs)
  },
  cancel: async (requestId: string): Promise<void> => {
    if (!MentraLocalNetwork) return
    await MentraLocalNetwork.cancel(requestId)
  },
  disconnect: async (): Promise<void> => {
    if (!MentraLocalNetwork) return
    await MentraLocalNetwork.disconnect()
  },
  onDownloadProgress: (listener: (event: OtaLocalNetworkDownloadProgress) => void): OtaTransportSubscription => {
    if (!MentraLocalNetwork) return {remove() {}}
    return MentraLocalNetwork.addListener("downloadProgress", listener)
  },
  onNetworkLost: (listener: (event: OtaLocalNetworkLostEvent) => void): OtaTransportSubscription => {
    if (!MentraLocalNetwork) return {remove() {}}
    return MentraLocalNetwork.addListener("networkLost", listener)
  },
})

/** Native HTTP server and artifact downloader used by the Engine OTA coordinator. */
export const otaServer = Object.freeze({
  start: (
    manifestJson: string,
    artifactPaths: Record<string, string>,
    host?: string | null,
  ): Promise<OtaServerResult> => MentraOtaServer.startOtaServer(manifestJson, artifactPaths, host),
  stop: (): Promise<void> => MentraOtaServer.stopOtaServer(),
  waitForWifiAddress: (gateway: string, timeoutMs: number): Promise<string> =>
    MentraOtaServer.waitForWifiAddress(gateway, timeoutMs),
  downloadArtifact: (source: string, destination: string): Promise<{statusCode: number; bytesWritten: number}> =>
    MentraOtaServer.downloadArtifact(source, destination),
  onArtifactDownloadProgress: (listener: (event: OtaArtifactDownloadProgress) => void): OtaTransportSubscription =>
    MentraOtaServer.addListener("artifactDownloadProgress", listener),
})
