import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import {ISLAND_SETTINGS_KEYS} from "../runtime/config"
import {useSettingsStore} from "../stores/settings"
import {cloudClientService} from "./CloudClientService"
import sttModelManager from "./STTModelManager"

/**
 * Decides whether on-device Sherpa STT should produce transcripts for local
 * miniapps, instead of (or in addition to) cloud transcription. Local STT is
 * active when the cloud is unavailable or any subscription requires
 * `forceLocal`.
 *
 * Activation flips `localSttFallbackActive` in the settings store, which
 * the bluetooth-sdk native side reads to decide whether to feed PCM into
 * the SherpaOnnxTranscriber. Local transcripts then flow back through the
 * `local_transcription` Bridge event; the host wires that event to
 * `localMiniappRuntime.forwardEvent`, with this coordinator providing the
 * subscription-active gate so we never publish transcripts to miniapps that
 * aren't asking for them. LocalMiniappRuntime filters mixed local/cloud
 * delivery per miniapp.
 */
class LocalSttFallbackCoordinator {
  private static instance: LocalSttFallbackCoordinator

  private hasTranscriptionSubscription = false
  private hasForceLocalSubscription = false
  private activeLanguage: string | null = null
  /**
   * Default to "cloud is up" so we never accidentally activate local STT before
   * the cloud client has had a chance to start. We attach lazily on the first
   * subscription/reconcile pass; once attached, this field reflects the real
   * cloud-client runtime status.
   */
  private cloudConnected = true
  private localActive = false
  private cloudAdapterAttached = false

  private constructor() {
    // Reset the persisted mirror flag on boot — the in-memory state in this
    // coordinator is the source of truth, and a stale "true" left from the
    // previous session would cause native to feed Sherpa before any miniapp
    // registered a subscription.
    useSettingsStore.getState().setSetting(ISLAND_SETTINGS_KEYS.localSttFallbackActive, false)
  }

  /**
   * Lazy-attach the engine cloud connection listener. The coordinator is
   * constructed at module load, before engine.start() brings up the cloud
   * client, so we defer until the first reconcile.
   */
  private attachCloudAdapterIfReady(): void {
    if (this.cloudAdapterAttached) return
    this.cloudConnected = cloudClientService.isConnected()
    cloudClientService.onStatusChanged((status) => {
      const connected = status.status === "connected"
      if (this.cloudConnected === connected) return
      this.log(`cloud connection -> ${connected ? "up" : "down"}`)
      this.cloudConnected = connected
      void this.reconcile()
    })
    this.cloudAdapterAttached = true
  }

  static getInstance(): LocalSttFallbackCoordinator {
    if (!LocalSttFallbackCoordinator.instance) {
      LocalSttFallbackCoordinator.instance = new LocalSttFallbackCoordinator()
    }
    return LocalSttFallbackCoordinator.instance
  }

  isActive(): boolean {
    return this.localActive
  }

  getActiveLanguage(): string | null {
    return this.activeLanguage
  }

  onSubscriptionChange(hasTranscription: boolean, language: string | null, hasForceLocal = false): void {
    this.log(`onSubscriptionChange(hasTx=${hasTranscription}, lang=${language}, forceLocal=${hasForceLocal})`)
    this.hasTranscriptionSubscription = hasTranscription
    this.hasForceLocalSubscription = hasTranscription && hasForceLocal
    this.activeLanguage = hasTranscription ? language : null
    void this.reconcile()
  }

  /**
   * Informational hook, retained for API stability. No longer called: the
   * authoritative switching signal is the cloud-client adapter (local miniapps
   * are powered only by V2). v1 cloud transcripts deliberately do NOT drive this
   * coordinator anymore. Kept for future hysteresis if connection-state alone
   * proves too coarse.
   */
  onCloudTranscript(): void {}

  private async reconcile(): Promise<void> {
    this.attachCloudAdapterIfReady()
    const shouldBeActive = this.shouldUseLocalStt()
    if (shouldBeActive && !this.localActive) {
      await this.startLocalStt()
    } else if (!shouldBeActive && this.localActive) {
      this.stopLocalStt(this.hasTranscriptionSubscription ? "cloud reconnected" : "subscription gone")
    }
  }

  private async startLocalStt(): Promise<void> {
    this.log("starting local stt")
    const modelAvailable = await sttModelManager.isModelAvailable()
    if (!modelAvailable) {
      this.log("local stt model is not available yet — skipping activation")
      return
    }
    if (!this.shouldUseLocalStt()) {
      this.log("local stt activation skipped: routing changed before start completed")
      return
    }
    try {
      // Direct btsdk call now (was a host restartTranscriber hook).
      await BluetoothSdk.restartTranscriber()
    } catch (err) {
      this.log(`restartTranscriber failed: ${err}`)
    }
    if (!this.shouldUseLocalStt()) {
      this.log("local stt activation skipped: routing changed during transcriber restart")
      return
    }
    useSettingsStore.getState().setSetting(ISLAND_SETTINGS_KEYS.localSttFallbackActive, true)
    this.localActive = true
  }

  private stopLocalStt(reason: string): void {
    this.log(`stopping local stt: ${reason}`)
    useSettingsStore.getState().setSetting(ISLAND_SETTINGS_KEYS.localSttFallbackActive, false)
    this.localActive = false
  }

  private shouldUseLocalStt(): boolean {
    return this.hasTranscriptionSubscription && (this.hasForceLocalSubscription || !this.cloudConnected)
  }

  private log(msg: string): void {
    console.log(`[LocalSttFallback] ${msg}`)
  }
}

const localSttFallbackCoordinator = LocalSttFallbackCoordinator.getInstance()
export default localSttFallbackCoordinator
