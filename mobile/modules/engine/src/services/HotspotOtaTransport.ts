import BluetoothSdk, {isEnabledHotspotStatus, MentraOtaServer} from "@mentra/bluetooth-sdk/internal"
// One coordinator selects the native Android or iOS staging implementation at runtime.
// eslint-disable-next-line react-native/split-platform-components
import {PermissionsAndroid, Platform} from "react-native"
import type {OtaCheckCurrentGlassesResult} from "./OtaUpdateCheckService"
import {
  cleanupArtifacts,
  OtaArtifactError,
  planArtifacts,
  prepareArtifacts,
  rewriteManifestForLocalServer,
  verifyPreparedArtifacts,
  type OtaArtifactDownloadProgress,
  type PreparedOtaArtifact,
} from "./OtaArtifactDownloader"
import {localNetworkTransport} from "./asg/localNetworkTransport"

export type HotspotOtaPhase = "idle" | "downloading" | "starting_hotspot" | "joining_hotspot" | "serving"

export type HotspotOtaProgress = {
  phase: HotspotOtaPhase
  artifact?: OtaArtifactDownloadProgress
}

export type HotspotOtaErrorCode =
  | "hotspot_ota_phone_unsupported"
  | "hotspot_wifi_permission_denied"
  | "hotspot_start_failed"
  | "hotspot_join_failed"
  | "hotspot_server_failed"
  | "hotspot_keepalive_failed"

export class HotspotOtaTransportError extends Error {
  constructor(
    public readonly code: HotspotOtaErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "HotspotOtaTransportError"
  }
}

/** Owns the single phone-side endpoint and network lease for one hotspot OTA attempt. */
class HotspotOtaTransport {
  private active = false
  private prepared: PreparedOtaArtifact[] = []
  private hotspotRequested = false
  private localNetworkConnected = false
  private serverStarted = false
  private keepaliveStarted = false
  private teardownPromise: Promise<void> | null = null

  async prepare(
    checkResult: OtaCheckCurrentGlassesResult,
    onProgress?: (progress: HotspotOtaProgress) => void,
  ): Promise<string> {
    if (this.teardownPromise) await this.teardownPromise
    if (this.active) {
      throw new Error("A hotspot OTA transport is already active")
    }
    if (!checkResult.manifestBody) {
      throw new Error("The selected OTA check has no manifest body")
    }

    let phase: HotspotOtaPhase = "downloading"
    let manifestPublished = false
    try {
      if (!(await MentraOtaServer.isSupported())) {
        throw new HotspotOtaTransportError(
          "hotspot_ota_phone_unsupported",
          "This phone does not support the hotspot OTA transport",
        )
      }
      await this.ensureAndroidWifiPermission()
      onProgress?.({phase: "downloading"})
      this.prepared = await prepareArtifacts(
        planArtifacts(checkResult),
        (artifact) => onProgress?.({phase: "downloading", artifact}),
        Platform.OS === "ios" ? this.downloadIosArtifact : undefined,
      )

      phase = "starting_hotspot"
      onProgress?.({phase: "starting_hotspot"})
      this.hotspotRequested = true
      const hotspot = await BluetoothSdk.setHotspotState(true)
      if (!isEnabledHotspotStatus(hotspot)) {
        throw new HotspotOtaTransportError("hotspot_start_failed", "Mentra Live did not return hotspot credentials")
      }
      phase = "joining_hotspot"
      onProgress?.({phase: "joining_hotspot"})
      const localAddress = await localNetworkTransport.connect(hotspot.ssid, hotspot.password)
      this.localNetworkConnected = true
      await verifyPreparedArtifacts(this.prepared)

      const artifactPaths = Object.fromEntries(this.prepared.map((artifact) => [artifact.sha256, artifact.filePath]))
      // Start exactly one native listener to learn its selected port, then atomically replace
      // the placeholder with the immutable rewritten manifest before ota_start is sent.
      const server = await MentraOtaServer.startOtaServer("{}", artifactPaths, localAddress)
      this.serverStarted = true
      const manifest = rewriteManifestForLocalServer(checkResult.manifestBody, this.prepared, server.baseUrl)
      const published = await MentraOtaServer.startOtaServer(manifest, artifactPaths, server.host)
      if (published.manifestUrl !== server.manifestUrl) {
        throw new Error("Local OTA server endpoint changed while publishing the manifest")
      }
      manifestPublished = true

      await localNetworkTransport.startHealthKeepalive(`http://${hotspot.localIp}:8089/api/health`, 30_000)
      this.keepaliveStarted = true
      this.active = true
      onProgress?.({phase: "serving"})
      return published.manifestUrl
    } catch (error) {
      const joined = this.localNetworkConnected
      await this.teardown()
      if (error instanceof OtaArtifactError || error instanceof HotspotOtaTransportError) {
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      if (phase === "starting_hotspot") {
        throw new HotspotOtaTransportError("hotspot_start_failed", message)
      }
      if (phase === "joining_hotspot" && !joined) {
        throw new HotspotOtaTransportError("hotspot_join_failed", message)
      }
      if (!manifestPublished) {
        throw new HotspotOtaTransportError("hotspot_server_failed", message)
      }
      throw new HotspotOtaTransportError("hotspot_keepalive_failed", message)
    }
  }

  /** Android 13+ requires the nearby-WiFi runtime grant before WifiNetworkSpecifier is usable. */
  private async ensureAndroidWifiPermission(): Promise<void> {
    const apiLevel = typeof Platform.Version === "number" ? Platform.Version : Number.parseInt(Platform.Version, 10)
    if (Platform.OS !== "android" || !Number.isFinite(apiLevel) || apiLevel < 33) return

    const permission = PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES
    if (await PermissionsAndroid.check(permission)) return
    const result = await PermissionsAndroid.request(permission)
    if (result !== PermissionsAndroid.RESULTS.GRANTED) {
      throw new HotspotOtaTransportError(
        "hotspot_wifi_permission_denied",
        "Nearby devices permission is required to connect to the glasses hotspot",
      )
    }
  }

  private downloadIosArtifact = async (
    entry: {url: string},
    destination: string,
    onProgress?: (bytesWritten: number, contentLength: number) => void,
  ): Promise<{statusCode: number}> => {
    const subscription = MentraOtaServer.addListener("artifactDownloadProgress", (event) => {
      if (event.destination === destination) onProgress?.(event.bytesWritten, event.contentLength)
    })
    try {
      return await MentraOtaServer.downloadArtifact(entry.url, destination)
    } finally {
      subscription.remove()
    }
  }

  async teardown(): Promise<void> {
    if (this.teardownPromise) return this.teardownPromise
    this.teardownPromise = (async () => {
      if (this.keepaliveStarted) await localNetworkTransport.stopHealthKeepalive().catch(() => {})
      if (this.serverStarted) await MentraOtaServer.stopOtaServer().catch(() => {})
      if (this.localNetworkConnected) await localNetworkTransport.disconnect().catch(() => {})
      if (this.hotspotRequested) await BluetoothSdk.setHotspotState(false).catch(() => {})
      await cleanupArtifacts().catch(() => {})
      this.prepared = []
      this.active = false
      this.keepaliveStarted = false
      this.serverStarted = false
      this.localNetworkConnected = false
      this.hotspotRequested = false
    })()
    try {
      await this.teardownPromise
    } finally {
      this.teardownPromise = null
    }
  }
}

export const hotspotOtaTransport = new HotspotOtaTransport()
