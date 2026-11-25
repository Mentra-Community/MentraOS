import NetInfo from "@react-native-community/netinfo"
import {otaServer} from "@mentra/bluetooth-sdk/ota-transport"
// One coordinator selects the native Android or iOS staging implementation at runtime.
// eslint-disable-next-line react-native/split-platform-components
import {PermissionsAndroid, Platform} from "react-native"
import WifiManager from "react-native-wifi-reborn"
import {getUiSeams} from "../runtime/bootstrap"
import {BgTimer} from "../utils/timers"
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
import {useGlassesStore} from "../stores/glasses"
import {usableSerial} from "./fleet/glassesIdentity"
import {GlassesWifiError, holdGlassesWifi, type GlassesWifiHold} from "./GlassesWifi"
import {joinedGlassesIdentity} from "./HotspotGlassesIdentity"
import {hotspotStartErrorCode} from "./OtaErrorMapping"
import {
  localNetworkErrorDetails,
  type LocalNetworkErrorDetails,
} from "./asg/localNetworkTransport"

export type HotspotOtaPhase = "idle" | "downloading" | "starting_hotspot" | "joining_hotspot" | "serving"

export type HotspotOtaProgress = {
  phase: HotspotOtaPhase
  artifact?: OtaArtifactDownloadProgress
}

export type HotspotOtaErrorCode =
  | "hotspot_wifi_permission_denied"
  | "hotspot_wifi_disabled"
  | "hotspot_location_denied"
  | "hotspot_start_failed"
  | "hotspot_restart_required"
  | "hotspot_join_failed"
  | "hotspot_other_glasses"
  | "hotspot_server_failed"

/** Mac causes that need Location Services and Mentra's Location access, not Wi-Fi. */
const MAC_LOCATION_CAUSE =
  /^(Location (access is|services are) required to |Mac hotspot Location authorization is unavailable)/

/** Joins after the first that may land on other glasses before the update stops and says so. */
const WRONG_GLASSES_REJOINS = 2

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

/** Owns the single phone-side endpoint and the Wi-Fi hold for one hotspot OTA attempt. */
class HotspotOtaTransport {
  private wifi: GlassesWifiHold | null = null
  /** Aborts a hold still waiting for the link when the attempt is torn down. */
  private holding: AbortController | null = null
  private active = false
  private prepared: PreparedOtaArtifact[] = []
  private serverStarted = false
  private teardownPromise: Promise<void> | null = null
  private preparing: Promise<string> | null = null
  private generation = 0

  /**
   * Serve the update to the glasses over the glasses Wi-Fi link and return its manifest URL.
   * `onEndpoint` gets the new URL when the link comes back at another address, for example after
   * the ASG app replaced itself; the glasses resume the update from it.
   */
  async prepare(
    checkResult: OtaCheckCurrentGlassesResult,
    onProgress?: (progress: HotspotOtaProgress) => void,
    onEndpoint?: (manifestUrl: string) => void,
  ): Promise<string> {
    const ownerRevision = otaDeviceSessionRevision()
    if (this.teardownPromise) await this.teardownPromise
    if (ownerRevision !== otaDeviceSessionRevision()) throw new Error("The OTA glasses have changed")
    // A teardown whose hotspot shutdown went unconfirmed (glasses whose replies are queued behind
    // a file transfer) leaves its cleanup here. Retry it rather than refuse every later attempt.
    if (this.wifi && !this.active && !this.preparing) {
      try {
        await this.teardown()
      } catch (cleanupError) {
        console.warn("[OTA_PROGRESS] leftover cleanup failed", localNetworkErrorDetails(cleanupError))
      }
      if (ownerRevision !== otaDeviceSessionRevision()) throw new Error("The OTA glasses have changed")
    }
    if (this.wifi || this.active || this.preparing || this.serverStarted || this.prepared.length) {
      throw new Error("A hotspot OTA transport is active or still needs cleanup")
    }
    if (!checkResult.manifestBody) throw new Error("The selected OTA check has no manifest body")
    const generation = ++this.generation
    const assertCurrent = () => {
      if (generation !== this.generation || ownerRevision !== otaDeviceSessionRevision()) {
        throw new Error("The OTA glasses have changed")
      }
    }
    const preparation = this.prepareAttempt(checkResult, assertCurrent, onProgress, onEndpoint)
    this.preparing = preparation
    try {
      return await preparation
    } catch (error) {
      // Remove our promise before waiting on teardown, which joins preparation.
      if (this.preparing === preparation) this.preparing = null
      try {
        await this.teardown()
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
    onEndpoint?: (manifestUrl: string) => void,
  ): Promise<string> {
    const manifestBody = checkResult.manifestBody
    if (!manifestBody) throw new Error("The selected OTA check has no manifest body")
    try {
      await this.ensureAndroidWifiPermission()
      assertCurrent()
      await this.ensureAndroidWifiEnabled()
      assertCurrent()
      onProgress?.({phase: "downloading"})
      this.prepared = await prepareArtifacts(
        planArtifacts(checkResult),
        (artifact) => onProgress?.({phase: "downloading", artifact}),
        Platform.OS === "ios" ? this.downloadIosArtifact : undefined,
      )

      assertCurrent()
      onProgress?.({phase: "starting_hotspot"})
      const bluetoothSerial = usableSerial(useGlassesStore.getState())
      let localAddress: string | undefined
      for (let join = 1; ; join++) {
        // The glasses Wi-Fi service turns the hotspot on and joins it, or shares the link held.
        this.holding = new AbortController()
        this.wifi = await holdGlassesWifi({
          consumer: "hotspot-ota",
          // The glasses download from our listener; OTA asks their server only who they are.
          purpose: "incoming-server",
          signal: this.holding.signal,
        })
        onProgress?.({phase: "joining_hotspot"})
        assertCurrent()
        localAddress = this.wifi.binding.phoneIpv4
        // Near many pairs, the network joined may belong to other glasses; the update must reach these.
        if ((await joinedGlassesIdentity(this.wifi.binding.gateway, bluetoothSerial)) !== "other_glasses") break
        assertCurrent()
        console.warn(`[OTA_PROGRESS] the hotspot joined belongs to other glasses (join ${join}) - leaving it`)
        const wrong = this.wifi
        this.wifi = null
        await wrong.release()
        assertCurrent()
        if (join > WRONG_GLASSES_REJOINS) {
          throw new HotspotOtaTransportError(
            "hotspot_other_glasses",
            "The hotspot joined belongs to other glasses, not the connected pair",
          )
        }
      }
      const manifestUrl = await this.serve(manifestBody, localAddress, assertCurrent)
      this.active = true
      onProgress?.({phase: "serving"})
      // The phone's address comes from the link at each step: when it comes back at another one,
      // serve there and hand the glasses the new URL.
      const wifi = this.wifi
      wifi.onChange((event) => {
        if (event.type !== "restored" || this.wifi !== wifi || !this.active) return
        this.serve(manifestBody, event.binding.phoneIpv4, assertCurrent).then(
          (url) => onEndpoint?.(url),
          (error) => console.warn("[OTA_PROGRESS] serving at the restored address failed", error),
        )
      })
      return manifestUrl
    } catch (error) {
      if (error instanceof OtaArtifactError || error instanceof HotspotOtaTransportError) {
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof GlassesWifiError && error.stage === "enable") {
        throw new HotspotOtaTransportError(hotspotStartErrorCode(message), message)
      }
      if (error instanceof GlassesWifiError) {
        // Wi-Fi turned off after the preflight fails the same instant way; name the real cause.
        if (Platform.OS === "android" && (await WifiManager.isEnabled().catch(() => true)) === false) {
          throw new HotspotOtaTransportError("hotspot_wifi_disabled", "Phone Wi-Fi is off")
        }
        const nativeError = localNetworkErrorDetails(error.cause)
        if (MAC_LOCATION_CAUSE.test(nativeError.message ?? "")) {
          throw new HotspotOtaTransportError("hotspot_location_denied", message, nativeError)
        }
        throw new HotspotOtaTransportError("hotspot_join_failed", message, nativeError)
      }
      throw new HotspotOtaTransportError("hotspot_server_failed", message)
    }
  }

  /**
   * Start exactly one native listener on [address] to learn its port, then atomically replace the
   * placeholder with the manifest rewritten for it, before the glasses are given the URL.
   */
  private async serve(manifestBody: string, address: string | undefined, assertCurrent: () => void): Promise<string> {
    const artifactPaths = Object.fromEntries(this.prepared.map((artifact) => [artifact.sha256, artifact.filePath]))
    if (this.serverStarted) await otaServer.stop()
    const server = await otaServer.start("{}", artifactPaths, address)
    this.serverStarted = true
    assertCurrent()
    const manifest = rewriteManifestForLocalServer(manifestBody, this.prepared, server.baseUrl)
    const published = await otaServer.start(manifest, artifactPaths, server.host)
    assertCurrent()
    if (published.manifestUrl !== server.manifestUrl) {
      throw new Error("Local OTA server endpoint changed while publishing the manifest")
    }
    return published.manifestUrl
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

  /**
   * WifiNetworkSpecifier fails as Unavailable at once while the radio is off, which reads as a
   * broken glasses hotspot. Ask before downloading, through the host's Wi-Fi prompt when it has one.
   */
  private async ensureAndroidWifiEnabled(): Promise<void> {
    if (Platform.OS !== "android") return
    // A probe that throws is unknown, not off: the join still reports its own failure.
    if (await WifiManager.isEnabled().catch(() => true)) return
    const result = await getUiSeams()
      .requestPhoneWifiEnable?.()
      .catch(() => null)
    if (result?.enabled === true) {
      await this.waitForWifiInternet()
      return
    }
    throw new HotspotOtaTransportError("hotspot_wifi_disabled", "Phone Wi-Fi is off")
  }

  /**
   * A radio just turned on joins a saved network a few seconds later, and Android then drops
   * cellular as the default network, aborting any download started on it. Let that happen
   * first. Without a joinable network, download over the current one after the bound.
   */
  private async waitForWifiInternet(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = await NetInfo.fetch().catch(() => null)
      if (state?.type === "wifi" && state.isConnected && state.isInternetReachable !== false) return
      await new Promise<void>((resolve) => BgTimer.setTimeout(resolve, 500))
    }
    console.log("[OTA_PROGRESS] Wi-Fi is on but not the internet route yet; downloading anyway")
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

  async teardown(): Promise<void> {
    this.generation += 1
    if (this.teardownPromise) return this.teardownPromise
    this.teardownPromise = (async () => {
      // The join has no time limit: give back a hold still waiting so preparation can settle.
      this.holding?.abort()
      await this.preparing?.catch(() => {})
      const errors: unknown[] = []
      if (this.serverStarted) {
        try {
          await otaServer.stop()
          this.serverStarted = false
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
      const wifi = this.wifi
      this.wifi = null
      await wifi?.release()
    })()
    try {
      await this.teardownPromise
    } finally {
      this.teardownPromise = null
    }
  }
}

export const hotspotOtaTransport = new HotspotOtaTransport()
