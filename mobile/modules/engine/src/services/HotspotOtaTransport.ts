import BluetoothSdk, {MentraOtaServer} from "@mentra/bluetooth-sdk/internal"
import {Platform} from "react-native"
import WifiManager from "react-native-wifi-reborn"
import {isGlassesConnected, useGlassesStore} from "../stores/glasses"
import {BgTimer} from "../utils/timers"
import {localNetworkTransport} from "./asg/localNetworkTransport"
import {
  cleanupArtifacts,
  planArtifacts,
  prepareArtifacts,
  rewriteManifestForLocalServer,
  type OtaArtifactDownloadProgress,
  type PreparedOtaArtifact,
} from "./OtaArtifactDownloader"
import type {OtaCheckCurrentGlassesResult} from "./OtaUpdateCheckService"

/**
 * Hotspot-served OTA session (OS-1676): when the glasses have no WiFi, the phone
 * downloads the artifacts (OtaArtifactDownloader), brings the glasses' hotspot up, joins
 * it, serves the rewritten manifest via the LocalOtaServer, and hands the coordinator a
 * local manifest URL for ota_start.
 *
 * Lifecycle:
 *
 * - `beginSession(checkResult)` — user consented to the update: download artifacts, then
 *   establish the hotspot link and the server. Called before the install coordinator
 *   attaches.
 * - `ensureSession()` — called by the coordinator at every ota_start-resolution point.
 *   Returns the local manifest URL, transparently re-establishing the whole link when it
 *   died — which it always does at the APK step: the install kills the asg process that
 *   owns the LocalOnlyHotspot reservation, and credentials rotate on restart.
 * - `endSession()` — terminal cleanup (server, scoped network, glasses hotspot, and the
 *   artifact store when the update is done with them).
 *
 * While a session is active the transport polls the glasses' camera-web-server health
 * endpoint over the hotspot: the glasses' idle monitor stops the hotspot after 120s
 * without inbound HTTP, and during phone-served OTA the glasses are the HTTP client, so
 * nothing else feeds it. Health polling works on every field build.
 */

export type HotspotOtaErrorCode =
  | "hotspot_start_failed"
  | "hotspot_join_failed"
  | "glasses_unreachable"
  | "ota_server_start_failed"

export class HotspotOtaError extends Error {
  constructor(public readonly code: HotspotOtaErrorCode, message: string) {
    super(message)
    this.name = "HotspotOtaError"
  }
}

export type HotspotOtaPhase = "idle" | "downloading" | "connecting" | "serving"

interface ActiveSession {
  manifestBody: string
  artifacts: PreparedOtaArtifact[]
  /** Set once the hotspot link + server are up; null while (re)connecting. */
  manifestUrl: string | null
  hotspotSsid: string | null
}

const HOTSPOT_STATUS_TIMEOUT_MS = 30_000
const HOTSPOT_SETTLE_DELAY_MS = 3_000
const JOIN_MAX_ATTEMPTS = 3
const JOIN_RETRY_DELAY_MS = 3_000
const IOS_SSID_VERIFY_ATTEMPTS = 30
const IOS_SSID_VERIFY_INTERVAL_MS = 500
const GLASSES_HEALTH_ATTEMPTS = 20
const GLASSES_HEALTH_INTERVAL_MS = 500
const GLASSES_HEALTH_TIMEOUT_MS = 3_000
const KEEPALIVE_INTERVAL_MS = 30_000
const GLASSES_SERVER_PORT = 8089

class HotspotOtaTransport {
  private session: ActiveSession | null = null
  private phase: HotspotOtaPhase = "idle"
  private keepAliveTimer: ReturnType<typeof BgTimer.setInterval> | null = null
  private openInFlight: Promise<string> | null = null
  private phaseListeners = new Set<(phase: HotspotOtaPhase) => void>()

  isActive(): boolean {
    return this.session != null
  }

  currentPhase(): HotspotOtaPhase {
    return this.phase
  }

  onPhaseChange(listener: (phase: HotspotOtaPhase) => void): () => void {
    this.phaseListeners.add(listener)
    return () => this.phaseListeners.delete(listener)
  }

  /**
   * Start a hotspot OTA session: download + verify every artifact the pending update
   * needs (over the phone's current network), then bring the hotspot link up. Throws
   * OtaArtifactError/HotspotOtaError; the session is cleaned up on failure except for
   * downloaded artifacts, which are kept for a retry.
   */
  async beginSession(
    checkResult: OtaCheckCurrentGlassesResult,
    onDownloadProgress?: (progress: OtaArtifactDownloadProgress) => void,
  ): Promise<void> {
    if (this.session) {
      throw new HotspotOtaError("hotspot_start_failed", "A hotspot OTA session is already active")
    }
    if (!checkResult.manifestBody) {
      throw new HotspotOtaError("hotspot_start_failed", "Check result carries no manifest body")
    }
    this.setPhase("downloading")
    try {
      const plan = planArtifacts(checkResult)
      const artifacts = await prepareArtifacts(plan, onDownloadProgress)
      this.session = {
        manifestBody: checkResult.manifestBody,
        artifacts,
        manifestUrl: null,
        hotspotSsid: null,
      }
      await this.ensureSession()
    } catch (error) {
      await this.endSession({deleteArtifacts: false})
      throw error
    }
  }

  /**
   * Resolve the local manifest URL for an ota_start send, re-establishing the hotspot
   * link and server first when they are not verifiably up. Serialized: concurrent callers
   * share one bring-up.
   */
  async ensureSession(): Promise<string> {
    const session = this.session
    if (!session) {
      throw new HotspotOtaError("hotspot_start_failed", "No hotspot OTA session is active")
    }
    if (this.openInFlight) {
      return this.openInFlight
    }
    const inFlight = (async () => {
      if (session.manifestUrl && (await this.isLinkHealthy())) {
        return session.manifestUrl
      }
      return this.openLink(session)
    })()
    this.openInFlight = inFlight
    try {
      return await inFlight
    } finally {
      this.openInFlight = null
    }
  }

  /** Tear the session down. Artifacts are only deleted when the update is done with them. */
  async endSession(options: {deleteArtifacts: boolean}): Promise<void> {
    const session = this.session
    this.session = null
    this.stopKeepAlive()
    this.setPhase("idle")
    try {
      await MentraOtaServer.stopOtaServer()
    } catch {}
    try {
      await localNetworkTransport.disconnect()
    } catch {}
    if (session?.hotspotSsid && isGlassesConnected(useGlassesStore.getState().connection)) {
      try {
        await BluetoothSdk.setHotspotState(false)
      } catch {}
    }
    if (options.deleteArtifacts) {
      try {
        await cleanupArtifacts()
      } catch {}
    }
  }

  // --- link bring-up ---------------------------------------------------------

  private async openLink(session: ActiveSession): Promise<string> {
    this.setPhase("connecting")
    session.manifestUrl = null
    this.stopKeepAlive()
    try {
      const hotspot = await this.requestHotspot()
      session.hotspotSsid = hotspot.ssid
      await delay(HOTSPOT_SETTLE_DELAY_MS)
      await this.joinHotspot(hotspot)
      await this.verifyGlassesReachable(hotspot.gatewayIp)

      // Two-step start: the manifest rewrite needs the server's base URL, which the
      // first start call reveals; the second call reconfigures the already-running
      // server with the rewritten body (start is idempotent on a live port).
      const artifactPaths = Object.fromEntries(
        session.artifacts.map((artifact) => [artifact.sha256, artifact.filePath]),
      )
      let serverInfo
      try {
        serverInfo = await MentraOtaServer.startOtaServer("{}", artifactPaths, null)
        const rewritten = rewriteManifestForLocalServer(session.manifestBody, session.artifacts, serverInfo.baseUrl)
        serverInfo = await MentraOtaServer.startOtaServer(rewritten, artifactPaths, serverInfo.host)
      } catch (error) {
        throw new HotspotOtaError(
          "ota_server_start_failed",
          `Could not start the local OTA server: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      session.manifestUrl = serverInfo.manifestUrl
      this.startKeepAlive(hotspot.gatewayIp)
      this.setPhase("serving")
      return serverInfo.manifestUrl
    } catch (error) {
      this.setPhase(this.session ? "connecting" : "idle")
      throw error
    }
  }

  /** Ask the glasses for their hotspot and wait for credentials in the store. */
  private async requestHotspot(): Promise<{ssid: string; password: string; gatewayIp: string}> {
    const current = readHotspot()
    // Credentials rotate on every hotspot start, so an "enabled" store entry is only
    // trustworthy if the link behind it still answers — callers checked that already
    // via isLinkHealthy(); by the time we are here we always want a fresh start.
    try {
      await BluetoothSdk.setHotspotState(true)
    } catch (error) {
      throw new HotspotOtaError(
        "hotspot_start_failed",
        `Glasses refused the hotspot request: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const deadline = Date.now() + HOTSPOT_STATUS_TIMEOUT_MS
    // Wait for a NEW enabled report (different ssid, or any enabled state if none known).
    for (;;) {
      const hotspot = readHotspot()
      if (hotspot && (!current || hotspot.ssid !== current.ssid || hotspot.password !== current.password)) {
        return hotspot
      }
      if (Date.now() >= deadline) {
        if (hotspot) return hotspot
        throw new HotspotOtaError("hotspot_start_failed", "Glasses did not report hotspot credentials in time")
      }
      await delay(500)
    }
  }

  private async joinHotspot(hotspot: {ssid: string; password: string}): Promise<void> {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= JOIN_MAX_ATTEMPTS; attempt++) {
      try {
        await localNetworkTransport.connect(hotspot.ssid, hotspot.password)
        if (Platform.OS === "ios") {
          await this.verifyIosSsid(hotspot.ssid)
        }
        return
      } catch (error) {
        lastError = error
        if (attempt < JOIN_MAX_ATTEMPTS) {
          await delay(JOIN_RETRY_DELAY_MS)
        }
      }
    }
    throw new HotspotOtaError(
      "hotspot_join_failed",
      `Could not join the glasses hotspot: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    )
  }

  /** NEHotspotConfiguration resolves on acceptance, not connection — poll the SSID. */
  private async verifyIosSsid(ssid: string): Promise<void> {
    for (let i = 0; i < IOS_SSID_VERIFY_ATTEMPTS; i++) {
      try {
        const current = await WifiManager.getCurrentWifiSSID()
        if (current === ssid) return
      } catch {}
      await delay(IOS_SSID_VERIFY_INTERVAL_MS)
    }
    throw new HotspotOtaError("hotspot_join_failed", "Phone never associated to the glasses hotspot")
  }

  /** The glasses' camera web server answers /api/health whenever the device is up. */
  private async verifyGlassesReachable(gatewayIp: string): Promise<void> {
    for (let i = 0; i < GLASSES_HEALTH_ATTEMPTS; i++) {
      if (await this.probeGlassesHealth(gatewayIp)) return
      await delay(GLASSES_HEALTH_INTERVAL_MS)
    }
    throw new HotspotOtaError("glasses_unreachable", "Glasses did not answer over the hotspot link")
  }

  private async probeGlassesHealth(gatewayIp: string): Promise<boolean> {
    try {
      const response = await localNetworkTransport.fetch(
        `http://${gatewayIp}:${GLASSES_SERVER_PORT}/api/health`,
        undefined,
        GLASSES_HEALTH_TIMEOUT_MS,
      )
      return response.ok
    } catch {
      return false
    }
  }

  /** A session's link counts as healthy only when the glasses still answer through it. */
  private async isLinkHealthy(): Promise<boolean> {
    const hotspot = readHotspot()
    if (!hotspot) return false
    return this.probeGlassesHealth(hotspot.gatewayIp)
  }

  // --- keep-alive ------------------------------------------------------------

  private startKeepAlive(gatewayIp: string): void {
    this.stopKeepAlive()
    this.keepAliveTimer = BgTimer.setInterval(() => {
      void this.probeGlassesHealth(gatewayIp)
    }, KEEPALIVE_INTERVAL_MS)
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer != null) {
      BgTimer.clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
  }

  private setPhase(phase: HotspotOtaPhase): void {
    if (this.phase === phase) return
    this.phase = phase
    this.phaseListeners.forEach((listener) => {
      try {
        listener(phase)
      } catch {}
    })
  }
}

function readHotspot(): {ssid: string; password: string; gatewayIp: string} | null {
  const hotspot = useGlassesStore.getState().hotspot
  if (hotspot?.state !== "enabled") return null
  if (!hotspot.ssid || !hotspot.password || !hotspot.localIp) return null
  return {ssid: hotspot.ssid, password: hotspot.password, gatewayIp: hotspot.localIp}
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => BgTimer.setTimeout(resolve, ms))
}

export const hotspotOtaTransport = new HotspotOtaTransport()
