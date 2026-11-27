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
  /** Android: the joined network went away. */
  networkLost: (event: {ssid: string}) => void
  /** iOS: the hotspot join has waited a few seconds for Local Network access. */
  hotspotPermissionRequired: (event: {id: string; systemAnswer?: string}) => void
  /** iOS: the phone left the joined hotspot. */
  hotspotLost: (event: {id: string; reason?: string}) => void
}

/**
 * The glasses Wi-Fi link's native side. Android: `connect`, `connectWifiDirect`, `disconnect` and
 * network-bound `request`; iOS: `joinHotspot` and `leaveHotspot`. Both: `download`, `cancel`,
 * `cacheDirectory` and `delay`.
 */
declare class MentraLocalNetworkNativeModule extends NativeModule<LocalNetworkEvents> {
  getNetworkDiagnostics(): NetworkDiagnostics
  joinHotspot(
    id: string,
    ssid: string,
    password: string,
    gateway: string | null,
    purpose: string,
    frequency: number | null,
  ): Promise<string | undefined>
  leaveHotspot(id: string): Promise<void>
  cacheDirectory(): string
  /** Resolves after `ms`, also while the app is in the background. */
  delay(ms: number): Promise<void>
  connect(
    ssid: string,
    password: string,
    incoming: boolean,
  ): Promise<{connected: boolean; ssid: string; localAddress?: string; gateway?: string}>
  connectWifiDirect(incoming: boolean): Promise<{connected: boolean; ssid: string; localAddress?: string; gateway?: string}>
  wifiDirectAvailable(): Promise<boolean>
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
