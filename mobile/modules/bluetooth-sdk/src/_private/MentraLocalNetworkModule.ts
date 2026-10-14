import {NativeModule, requireOptionalNativeModule} from "expo"

export type NetworkCapabilitiesDiagnostic = {
  wifi: boolean
  cellular: boolean
  ethernet: boolean
  vpn: boolean
  internet: boolean
  validated: boolean
  captivePortal: boolean
}

export type NetworkObservation = {
  present: boolean
  // A present network with null capabilities has disappeared or cannot be inspected.
  capabilities: NetworkCapabilitiesDiagnostic | null
}

export type NetworkDiagnostics = {
  sampledAtMs: number
  processBound: NetworkObservation
  // ConnectivityManager.activeNetwork is the caller's active default, not a privileged global read.
  activeNetwork: NetworkObservation
  glassesLocal: NetworkObservation
  processBoundMatchesActive: boolean
  processBoundMatchesGlassesLocal: boolean
  activeNetworkMatchesGlassesLocal: boolean
}

export type LocalNetworkResponse = {
  status: number
  headers: Record<string, string>
  bodyBase64: string
}

export type LocalNetworkDownloadResult = {
  statusCode: number
  bytesWritten: number
  headers: Record<string, string>
}

export type LocalNetworkDownloadProgress = {
  requestId: string
  bytesWritten: number
  contentLength: number
  statusCode?: number
  headers?: Record<string, string>
}

type LocalNetworkEvents = {
  downloadProgress: (event: LocalNetworkDownloadProgress) => void
  networkLost: (event: {ssid: string}) => void
}

declare class MentraLocalNetworkNativeModule extends NativeModule<LocalNetworkEvents> {
  getNetworkDiagnostics(): NetworkDiagnostics
  connect(ssid: string, password: string): Promise<{connected: boolean; ssid: string; localAddress?: string}>
  request(
    requestId: string,
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
    timeoutMs: number,
  ): Promise<LocalNetworkResponse>
  download(
    requestId: string,
    url: string,
    destination: string,
    headers: Record<string, string>,
    connectionTimeoutMs: number,
    readTimeoutMs: number,
  ): Promise<LocalNetworkDownloadResult>
  cancel(requestId: string): Promise<void>
  disconnect(): Promise<void>
}

export default requireOptionalNativeModule<MentraLocalNetworkNativeModule>("MentraLocalNetwork")
