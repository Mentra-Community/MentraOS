import BluetoothSdk, {isEnabledHotspotStatus} from "@mentra/bluetooth-sdk"
import {otaServer} from "@mentra/bluetooth-sdk/ota-transport"
// One coordinator selects the native Android or iOS staging implementation at runtime.
// eslint-disable-next-line react-native/split-platform-components
import {PermissionsAndroid, Platform} from "react-native"
import {otaDeviceSessionRevision} from "./OtaDeviceSession"
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
import {
  localNetworkErrorDetails,
  localNetworkTransport,
  type LocalNetworkErrorDetails,
} from "./asg/localNetworkTransport"

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
    public readonly nativeError?: LocalNetworkErrorDetails,
  ) {
    super(message)
    this.name = "HotspotOtaTransportError"
  }
}

/** Owns the single phone-side endpoint and network lease for one hotspot OTA attempt. */
class HotspotOtaTransport {
  private readonly networkOwner = Symbol("hotspot-ota")
  private active = false
  private prepared: PreparedOtaArtifact[] = []
  private hotspotRequested = false
  private localNetworkConnected = false
  private localNetworkRequested = false
  private serverStarted = false
  private teardownPromise: Promise<void> | null = null
  private preparing: Promise<string> | null = null
  private generation = 0
  private ownerRevision = 0

  async prepare(
    checkResult: OtaCheckCurrentGlassesResult,
    onProgress?: (progress: HotspotOtaProgress) => void,
  ): Promise<string> {
    const ownerRevision = otaDeviceSessionRevision()
    if (this.teardownPromise) await this.teardownPromise
    if (ownerRevision !== otaDeviceSessionRevision()) throw new Error("The OTA glasses have changed")
    if (
      this.active ||
      this.preparing ||
      this.localNetworkRequested ||
      this.serverStarted ||
      this.hotspotRequested ||
      this.prepared.length
    ) {
      throw new Error("A hotspot OTA transport is active or still needs cleanup")
    }
    if (!checkResult.manifestBody) throw new Error("The selected OTA check has no manifest body")
    this.ownerRevision = ownerRevision
    const generation = ++this.generation
    const assertCurrent = () => {
      if (generation !== this.generation || ownerRevision !== otaDeviceSessionRevision()) {
        throw new Error("The OTA glasses have changed")
      }
    }
    const preparation = this.prepareAttempt(checkResult, assertCurrent, onProgress)
    this.preparing = preparation
    try {
      return await preparation
    } catch (error) {
      // Remove our promise before waiting on teardown, which joins preparation.
      if (this.preparing === preparation) this.preparing = null
      try {
        await this.teardown(ownerRevision === otaDeviceSessionRevision())
      } catch (cleanupError) {
        console.warn("[OTA_PROGRESS] cleanup failed", localNetworkErrorDetails(cleanupError))
      }
      throw error
    } finally {
      if (this.preparing === preparation) this.preparing = null
    }
  }

  private async prepareAttempt(
    checkResult: OtaCheckCurrentGlassesResult,
    assertCurrent: () => void,
    onProgress?: (progress: HotspotOtaProgress) => void,
  ): Promise<string> {
    const manifestBody = checkResult.manifestBody
    if (!manifestBody) throw new Error("The selected OTA check has no manifest body")
    let phase: HotspotOtaPhase = "downloading"
    try {
      await this.ensureAndroidWifiPermission()
      assertCurrent()
      onProgress?.({phase: "downloading"})
      this.prepared = await prepareArtifacts(
        planArtifacts(checkResult),
        (artifact) => onProgress?.({phase: "downloading", artifact}),
        Platform.OS === "ios" ? this.downloadIosArtifact : undefined,
      )

      assertCurrent()
      phase = "starting_hotspot"
      onProgress?.({phase: "starting_hotspot"})
      assertCurrent()
      this.hotspotRequested = true
      const hotspot = await BluetoothSdk.setHotspotState(true)
      assertCurrent()
      if (!isEnabledHotspotStatus(hotspot)) {
        throw new HotspotOtaTransportError("hotspot_start_failed", "Mentra Live did not return hotspot credentials")
      }
      phase = "joining_hotspot"
      onProgress?.({phase: "joining_hotspot"})
      assertCurrent()
      this.localNetworkRequested = true
      const scopedAddress = await localNetworkTransport.connect(this.networkOwner, hotspot.ssid, hotspot.password, {
        retryIosInternalError: true,
        assertCurrent,
        gateway: hotspot.localIp,
      })
      this.localNetworkConnected = true
      assertCurrent()
      let localAddress = scopedAddress
      if (Platform.OS === "ios" && !localAddress) {
        try {
          localAddress = await otaServer.waitForWifiAddress(hotspot.localIp, 15_000)
          assertCurrent()
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
      const server = await otaServer.start("{}", artifactPaths, localAddress)
      this.serverStarted = true
      assertCurrent()
      const manifest = rewriteManifestForLocalServer(manifestBody, this.prepared, server.baseUrl)
      const published = await otaServer.start(manifest, artifactPaths, server.host)
      assertCurrent()
      if (published.manifestUrl !== server.manifestUrl) {
        throw new Error("Local OTA server endpoint changed while publishing the manifest")
      }
      this.active = true
      onProgress?.({phase: "serving"})
      return published.manifestUrl
    } catch (error) {
      const joined = this.localNetworkConnected
      if (error instanceof OtaArtifactError || error instanceof HotspotOtaTransportError) {
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      if (phase === "starting_hotspot") {
        throw new HotspotOtaTransportError("hotspot_start_failed", message)
      }
      if (phase === "joining_hotspot" && !joined) {
        throw new HotspotOtaTransportError("hotspot_join_failed", message, localNetworkErrorDetails(error))
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
    const subscription = otaServer.onArtifactDownloadProgress((event) => {
      if (event.destination === destination) onProgress?.(event.bytesWritten, event.contentLength)
    })
    try {
      return await otaServer.downloadArtifact(entry.url, destination)
    } finally {
      subscription.remove()
    }
  }

  async teardown(disableGlassesHotspot = true): Promise<void> {
    this.generation += 1
    if (this.teardownPromise) return this.teardownPromise
    this.teardownPromise = (async () => {
      await this.preparing?.catch(() => {})
      const errors: unknown[] = []
      if (disableGlassesHotspot && this.ownerRevision === otaDeviceSessionRevision() && this.hotspotRequested) {
        try {
          const hotspotStopped = await disableHotspotWithRetry(
            () =>
              this.ownerRevision === otaDeviceSessionRevision()
                ? BluetoothSdk.setHotspotState(false)
                : Promise.resolve({state: "enabled" as const}),
            {
              // A completed APK step has just replaced ASG. Let the new command path
              // settle before asking it to tear down the SystemUI-owned access point.
              initialDelayMs: this.serverStarted ? 750 : 0,
            },
          )
          if (hotspotStopped) this.hotspotRequested = false
          else errors.push(new Error("The glasses hotspot shutdown was not confirmed"))
        } catch (error) {
          errors.push(error)
        }
      } else this.hotspotRequested = false
      if (this.serverStarted) {
        try {
          await otaServer.stop()
          this.serverStarted = false
        } catch (error) {
          errors.push(error)
        }
      }
      if (this.localNetworkRequested) {
        try {
          await localNetworkTransport.disconnect(this.networkOwner)
          this.localNetworkRequested = false
          this.localNetworkConnected = false
        } catch (error) {
          errors.push(error)
        }
      }
      if (!this.serverStarted) {
        // A server that has not stopped can still read these files.
        try {
          await cleanupArtifacts()
          this.prepared = []
        } catch (error) {
          errors.push(error)
        }
      }
      this.active = false
      if (errors.length) throw errors[0]
    })()
    try {
      await this.teardownPromise
    } finally {
      this.teardownPromise = null
    }
  }
}

export const hotspotOtaTransport = new HotspotOtaTransport()
