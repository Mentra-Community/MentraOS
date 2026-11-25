// This public adapter is the package-owned boundary over its native implementation.
// eslint-disable-next-line no-restricted-imports
import MentraLocalNetwork, {type NetworkDiagnostics} from "../_private/MentraLocalNetworkModule"
// eslint-disable-next-line no-restricted-imports
import MentraOtaServer from "../ota-server"

// eslint-disable-next-line no-restricted-imports
export type {
  NetworkCapabilitiesDiagnostic,
  NetworkDiagnostics,
  NetworkObservation,
} from "../_private/MentraLocalNetworkModule"

export type OtaTransportSubscription = {remove(): void}

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
 * The phone's network as OTA sees it. The glasses Wi-Fi link, and every request over it, is the
 * Bluetooth SDK's glasses Wi-Fi service's own.
 */
export const otaLocalNetwork = Object.freeze({
  isAvailable: (): boolean => MentraLocalNetwork != null,
  /** Synchronous local observation; no network I/O, route changes or network identities. */
  getNetworkDiagnostics: (): NetworkDiagnostics | null => MentraLocalNetwork?.getNetworkDiagnostics?.() ?? null,
})

/** Native HTTP server and artifact downloader used by the Engine OTA coordinator. */
export const otaServer = Object.freeze({
  start: (
    manifestJson: string,
    artifactPaths: Record<string, string>,
    host?: string | null,
  ): Promise<OtaServerResult> => MentraOtaServer.startOtaServer(manifestJson, artifactPaths, host),
  stop: (): Promise<void> => MentraOtaServer.stopOtaServer(),
  downloadArtifact: (source: string, destination: string): Promise<{statusCode: number; bytesWritten: number}> =>
    MentraOtaServer.downloadArtifact(source, destination),
  onArtifactDownloadProgress: (listener: (event: OtaArtifactDownloadProgress) => void): OtaTransportSubscription =>
    MentraOtaServer.addListener("artifactDownloadProgress", listener),
})
