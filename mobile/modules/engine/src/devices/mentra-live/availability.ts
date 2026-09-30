import {BgTimer} from "../../utils/timers"
import {RevisionedSnapshot} from "../../ota/RevisionedSnapshot"
import type {OtaSnapshot} from "../../facades/ota"
import type {
  OtaCheckCurrentGlassesOptions,
  OtaCheckCurrentGlassesResult,
  VersionJson,
} from "../../services/OtaUpdateCheckService"

export function getPendingUpdatePromptAction(
  returnedHome: boolean,
  wifiStatusKnown: boolean,
  wifiConnected: boolean,
  hotspotOtaSupported: boolean,
): "install" | "wifi_setup" | null {
  if (!wifiStatusKnown) return null
  if (!returnedHome && !wifiConnected && !hotspotOtaSupported) return null
  return wifiConnected || hotspotOtaSupported ? "install" : "wifi_setup"
}

export interface LiveAvailabilityPrompt {
  readonly id: number
  readonly action: "install" | "wifi_setup"
  readonly updates: readonly string[]
  readonly isDowngrade: boolean
}

export interface LiveAvailabilityPorts {
  snapshot(): OtaSnapshot
  subscribe(listener: () => void): () => void
  check(options: OtaCheckCurrentGlassesOptions): Promise<OtaCheckCurrentGlassesResult>
  fetchManifest(url: string): Promise<VersionJson | null>
  clearMtkSession(): void
  /** Explicit registration policy and native identity, supplied by the composition root. */
  target(): string | null
  owned(): boolean
}

/** Background Live checks outlive the host view. The host only supplies home context and renders prompts. */
export class LiveAvailabilityMonitor {
  private snapshots = new RevisionedSnapshot<{revision: number; prompt: LiveAvailabilityPrompt | null}>({
    revision: 0,
    prompt: null,
  })
  private unsubscribe: (() => void) | null = null
  private checkTimer: number | null = null
  private pollTimer: number | null = null
  private generation = 0
  private identity: string | null = null
  private versions: Array<string | null> = [null, null, null]
  private checked = false
  private prompted = false
  private wifiPrompted = false
  private home = false
  private wasAway = false
  private pending: {updates: readonly string[]; isDowngrade: boolean} | null = null
  private baseline: {url: string; body: string} | null = null
  private nextPromptId = 0
  private claimedPromptId = 0

  constructor(private readonly ports: LiveAvailabilityPorts) {}

  snapshot = () => this.snapshots.snapshot()
  subscribe = (listener: (snapshot: ReturnType<LiveAvailabilityMonitor["snapshot"]>) => void) =>
    this.snapshots.subscribe(listener)

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.ports.subscribe(this.refresh)
    this.pollTimer = BgTimer.setInterval(() => void this.poll(), 60_000)
    this.refresh()
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.pollTimer) BgTimer.clearInterval(this.pollTimer)
    this.pollTimer = null
    this.invalidate()
    this.baseline = null
    // Location belongs to the mounted host. Auth suspension must not erase it;
    // the host still calls setHome(false) when it leaves or unmounts.
  }

  setHome(home: boolean): void {
    this.home = home
    if (!home) this.wasAway = true
    this.refresh()
  }

  /** A replay/remount must not present an already-visible native alert twice. */
  claimPrompt(id: number): boolean {
    if (!this.home || !this.current(this.generation)) return false
    if (id <= this.claimedPromptId || this.snapshot().prompt?.id !== id) return false
    this.claimedPromptId = id
    return true
  }

  dismiss(id: number): void {
    const prompt = this.snapshot().prompt
    if (prompt?.id !== id) return
    if (prompt.action === "wifi_setup") {
      this.pending = null
      this.wifiPrompted = false
    }
    this.snapshots.publish({prompt: null})
  }

  refresh = (): void => {
    if (!this.unsubscribe) return
    const s = this.ports.snapshot()
    const identity = this.ports.target()
    const versions = [s.buildNumber, s.mtkFirmwareVersion, s.besFirmwareVersion]
    const versionChanged = versions.some(
      (version, index) => version && this.versions[index] && version !== this.versions[index],
    )
    if (!s.connected || identity !== this.identity || versionChanged) {
      this.invalidate()
      if (!s.connected || identity !== this.identity) this.baseline = null
      if (!s.connected && s.mtkUpdatedThisSession) this.ports.clearMtkSession()
    }
    this.identity = identity
    this.versions = versions.map((value, index) => value || this.versions[index])
    if (!identity || !s.connected || this.ports.owned() || s.inProgress) {
      // Invalidate in-flight background results before they can replace an approved offer.
      if (this.checkTimer || this.checked || this.pending) this.invalidate()
      return
    }
    this.offerPending(false)
    if (!this.home || !s.buildNumber || this.checked || this.checkTimer) return
    const generation = this.generation
    this.checkTimer = BgTimer.setTimeout(() => {
      this.checkTimer = null
      if (!this.current(generation) || !this.home) return
      this.checked = true
      void this.check(generation)
    }, 500)
  }

  private current(generation: number): boolean {
    const s = this.ports.snapshot()
    return (
      !!this.unsubscribe &&
      generation === this.generation &&
      this.identity === this.ports.target() &&
      s.connected &&
      !s.inProgress &&
      !this.ports.owned()
    )
  }

  private invalidate(): void {
    this.generation++
    if (this.checkTimer) BgTimer.clearTimeout(this.checkTimer)
    this.checkTimer = null
    this.checked = false
    this.prompted = false
    this.wifiPrompted = false
    this.pending = null
    if (this.snapshot().prompt) this.snapshots.publish({prompt: null})
  }

  private async check(generation: number): Promise<void> {
    try {
      const result = await this.ports.check({
        waitForBuildNumberMs: 0,
        waitForBesVersionMs: 5000,
        waitForMtkVersionMs: 0,
        refreshVersionInfo: false,
        canPublish: () => this.current(generation),
      })
      if (!this.current(generation) || result.skippedReason) return
      if (result.manifestUrl && result.manifestBody)
        this.baseline = {url: result.manifestUrl, body: result.manifestBody}
      if (!result.updates.length || !result.latestVersionInfo || this.prompted) return
      this.pending = {updates: result.updates, isDowngrade: result.isApkDowngrade}
      if (!this.ports.snapshot().wifiStatusKnown) this.wasAway = true
      this.offerPending(true)
    } catch (error) {
      console.warn("OTA: background availability check failed", error)
    }
  }

  private offerPending(freshCheck: boolean): void {
    const s = this.ports.snapshot()
    if (!this.home || !this.pending || this.prompted || !s.connected || this.ports.owned()) return
    const action = getPendingUpdatePromptAction(
      freshCheck || this.wasAway,
      s.wifiStatusKnown,
      s.wifiConnected,
      s.hotspotOtaVersion === 1,
    )
    if (!action) return
    this.wasAway = false
    if (action === "wifi_setup" && this.wifiPrompted) return
    const prompt = {...this.pending, action, id: ++this.nextPromptId}
    if (action === "install") {
      this.prompted = true
      this.wifiPrompted = false
      this.pending = null
    } else this.wifiPrompted = true
    this.snapshots.publish({prompt})
  }

  private async poll(): Promise<void> {
    const generation = this.generation
    const s = this.ports.snapshot()
    if (!this.identity || !s.buildNumber || !this.baseline || !s.manifestUrl || !this.current(generation)) return
    const url = s.manifestUrl
    try {
      const manifest = await this.ports.fetchManifest(url)
      if (!manifest || !this.current(generation) || !this.baseline) return
      const body = JSON.stringify(manifest)
      if (this.baseline.url === url && this.baseline.body === body) return
      this.baseline = {url, body}
      this.invalidate()
      this.refresh()
    } catch (error) {
      console.warn("OTA: background manifest poll failed", error)
    }
  }
}
