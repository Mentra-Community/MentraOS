import CoreModule from "@mentra/bluetooth-sdk"

import {getRuntimeHooks, ISLAND_SETTINGS_KEYS} from "../runtime/config"
import sttModelManager from "./STTModelManager"

/**
 * Decides whether on-device Sherpa STT should produce transcripts for local
 * miniapps, instead of (or in addition to) cloud transcription. The chooser
 * is connection-state-driven: when the WebSocket to cloud is down AND a
 * local miniapp is subscribed to transcription, we activate on-device STT.
 *
 * Activation flips `localSttFallbackActive` in the settings store, which
 * the bluetooth-sdk native side reads to decide whether to feed PCM into
 * the SherpaOnnxTranscriber. Local transcripts then flow back through the
 * `local_transcription` Bridge event; the host wires that event to
 * `localMiniappRuntime.forwardEvent`, with this coordinator providing the
 * subscription-active gate so we never publish transcripts to miniapps
 * that aren't asking for them.
 *
 * VAD is restored on the phone side independently of this coordinator;
 * for now we treat connection state as the only switching signal. Future
 * versions can use VAD-driven utterance boundaries for cleaner hand-off.
 */
class LocalSttFallbackCoordinator {
  private static instance: LocalSttFallbackCoordinator

  private hasTranscriptionSubscription = false
  private activeLanguage: string | null = null
  /**
   * Default to "cloud is up" so we never accidentally activate local STT
   * before the host has had a chance to wire `cloudConnection` via
   * `configureRuntime`. The adapter is attached lazily on the first
   * subscription/reconcile pass; once attached, this field reflects the
   * real WS status.
   */
  private cloudConnected = true
  private localActive = false
  private cloudAdapterAttached = false

  private constructor() {
    const settings = getRuntimeHooks().settings
    // Reset the persisted mirror flag on boot — the in-memory state in this
    // coordinator is the source of truth, and a stale "true" left from the
    // previous session would cause native to feed Sherpa before any miniapp
    // registered a subscription.
    settings?.setSetting(ISLAND_SETTINGS_KEYS.localSttFallbackActive, false)
  }

  /**
   * Lazy-attach the cloud connection adapter. The coordinator is constructed
   * at module load (singleton import), before `configureRuntime` runs on the
   * host. We defer reading the adapter until the first place we actually
   * need cloud state — which is reconcile().
   */
  private attachCloudAdapterIfReady(): void {
    if (this.cloudAdapterAttached) return
    const cloud = getRuntimeHooks().cloudConnection
    if (!cloud) return
    this.cloudConnected = cloud.isConnected()
    cloud.addListener((connected) => {
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

  onSubscriptionChange(hasTranscription: boolean, language: string | null): void {
    this.log(`onSubscriptionChange(hasTx=${hasTranscription}, lang=${language})`)
    this.hasTranscriptionSubscription = hasTranscription
    this.activeLanguage = hasTranscription ? language : null
    void this.reconcile()
  }

  /**
   * Called by the host when a cloud transcript arrives. Right now it's
   * informational — the cloud-connected listener is authoritative — but
   * the hook is kept so future VAD-driven hysteresis can use cloud-result
   * arrival as a "cloud is healthy enough" signal.
   */
  onCloudTranscript(): void {}

  private async reconcile(): Promise<void> {
    this.attachCloudAdapterIfReady()
    const shouldBeActive = this.hasTranscriptionSubscription && !this.cloudConnected
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
    try {
      await CoreModule.restartTranscriber()
    } catch (err) {
      this.log(`restartTranscriber failed: ${err}`)
    }
    getRuntimeHooks().settings?.setSetting(ISLAND_SETTINGS_KEYS.localSttFallbackActive, true)
    this.localActive = true
  }

  private stopLocalStt(reason: string): void {
    this.log(`stopping local stt: ${reason}`)
    getRuntimeHooks().settings?.setSetting(ISLAND_SETTINGS_KEYS.localSttFallbackActive, false)
    this.localActive = false
  }

  private log(msg: string): void {
    console.log(`[LocalSttFallback] ${msg}`)
  }
}

const localSttFallbackCoordinator = LocalSttFallbackCoordinator.getInstance()
export default localSttFallbackCoordinator
