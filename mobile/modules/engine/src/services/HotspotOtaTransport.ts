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
  type OtaArtifactDownloadProgress,
  type PreparedOtaArtifact,
} from "./OtaArtifactDownloader"
import {disableHotspotWithRetry} from "./HotspotShutdown"
import {localNetworkTransport} from "./asg/localNetworkTransport"

export type HotspotOtaPhase = "idle" | "downloading" | "starting_hotspot" | "joining_hotspot" | "serving"

export type HotspotOtaProgress = {
  phase: HotspotOtaPhase
  artifact?: OtaArtifactDownloadProgress
}

export type HotspotOtaErrorCode =
  | "hotspot_wifi_permission_denied"
  | "hotspot_start_failed"
  | "hotspot_join_failed"
  | "hotspot_server_failed"

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
    try {
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
      const scopedAddress = await localNetworkTransport.connect(hotspot.ssid, hotspot.password)
      this.localNetworkConnected = true
      let localAddress = scopedAddress
      if (Platform.OS === "ios") {
        try {
          localAddress = await MentraOtaServer.waitForWifiAddress(hotspot.localIp, 15_000)
        } catch (error) {
          throw new HotspotOtaTransportError(
            "hotspot_join_failed",
            error instanceof Error ? error.message : String(error),
          )
        }
      }
      const artifactPaths = Object.fromEntries(this.prepared.map((artifact) => [artifact.sha256, artifact.filePath]))
      // Start exactly one native listener to learn its selected port, then atomically replace
      // the placeholder with the immutable rewritten manifest before ota_start is sent.
      const server = await MentraOtaServer.startOtaServer("{}", artifactPaths, localAddress)
      this.serverStarted = true
      const manifest = rewriteManifestForLocalServer(
        checkResult.manifestBody,
        this.prepared,
        server.baseUrl,
        checkResult.manifestUrl,
      )
      const published = await MentraOtaServer.startOtaServer(manifest, artifactPaths, server.host)
      if (published.manifestUrl !== server.manifestUrl) {
        throw new Error("Local OTA server endpoint changed while publishing the manifest")
      }
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
      throw new HotspotOtaTransportError("hotspot_server_failed", message)
    }
  }

  /** Android 13+ requires the nearby-WiFi runtime grant before WifiNetworkSpecifier is usable. */
  private async ensureAndroidWifiPermission(): Promise<void> {
    if (Platform.OS !== "android") return

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
      if (this.hotspotRequested) {
        const hotspotStopped = await disableHotspotWithRetry(() => BluetoothSdk.setHotspotState(false), {
          // A completed APK step has just replaced ASG. Let the new command path
          // settle before asking it to tear down the SystemUI-owned access point.
          initialDelayMs: this.serverStarted ? 750 : 0,
        })
        if (!hotspotStopped) {
          console.warn("[OTA_PROGRESS] glasses hotspot shutdown was not confirmed after bounded retries")
        }
      }
      if (this.serverStarted) await MentraOtaServer.stopOtaServer().catch(() => {})
      if (this.localNetworkConnected) await localNetworkTransport.disconnect().catch(() => {})
      await cleanupArtifacts().catch(() => {})
      this.prepared = []
      this.active = false
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
