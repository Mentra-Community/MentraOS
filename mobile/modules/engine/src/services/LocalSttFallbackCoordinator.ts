import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import {ISLAND_SETTINGS_KEYS} from "../runtime/config"
import {useSettingsStore} from "../stores/settings"
import {cloudClientService} from "./CloudClientService"
import {ModelRetry} from "./ModelRetry"
import offlineSpeechModelService from "./OfflineSpeechModelService"
import sttModelManager from "./STTModelManager"

/**
 * State of the on-device speech-to-text model. `idle` means no miniapp needs
 * on-device transcription right now, so no model is loaded.
 */
export interface LocalSttModelStatus {
  /** Speech-page model code, e.g. "fr". */
  code: string
  /** BCP-47 language of that model, e.g. "en-US". */
  language: string
  state: "idle" | "downloading" | "loading" | "ready" | "unavailable"
  /** 0–100 while downloading. */
  progress?: number
  /** Why the model is unavailable. */
  reason?: string
}

/**
 * Decides whether on-device Sherpa STT should produce transcripts for local
 * miniapps, instead of (or in addition to) cloud transcription. Local STT is
 * active when the cloud is unavailable or any subscription requires
 * `forceLocal`.
 *
 * There is one recognizer and it always runs the model picked on the Speech
 * page. When on-device transcription is needed and that model is missing, it
 * is downloaded through the Speech-page system first. A failed download or
 * load retries on the next attempt and on the shared model retry schedule.
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
  /**
   * Default to "cloud is up" so we never accidentally activate local STT before
   * the cloud client has had a chance to start. We attach lazily on the first
   * subscription/reconcile pass; once attached, this field reflects the real
   * cloud-client runtime status.
   */
  private cloudConnected = true
  private cloudAdapterAttached = false
  private selectionAttached = false
  private hydration?: Promise<unknown>
  private hydrated = false
  private localActive = false
  /** Model code the native recognizer was last confirmed to have loaded for us. */
  private loadedCode: string | null = null
  /** Bumped by every new start and every stop, so a superseded start stops at its next step. */
  private generation = 0
  private running?: Promise<void>
  private runningCode: string | null = null
  /** Model code whose last download or load failed; its retry waits for the schedule. */
  private failedCode: string | null = null
  private readonly retry = new ModelRetry()
  private status: LocalSttModelStatus = {code: "", language: "", state: "idle"}
  private readonly statusListeners = new Set<(status: LocalSttModelStatus) => void>()

  private constructor() {
    // Reset the persisted mirror flag on boot — the in-memory state in this
    // coordinator is the source of truth, and a stale "true" left from the
    // previous session would cause native to feed Sherpa before any miniapp
    // registered a subscription.
    useSettingsStore.getState().setSetting(ISLAND_SETTINGS_KEYS.localSttFallbackActive, false)
  }

  static getInstance(): LocalSttFallbackCoordinator {
    if (!LocalSttFallbackCoordinator.instance) {
      LocalSttFallbackCoordinator.instance = new LocalSttFallbackCoordinator()
    }
    return LocalSttFallbackCoordinator.instance
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
      this.reconcile()
    })
    this.cloudAdapterAttached = true
  }

  /** A model change on the Speech page reloads the recognizer while it is in use. */
  private attachSelectionIfReady(): void {
    if (this.selectionAttached) return
    this.selectionAttached = true
    sttModelManager.onSelectionChanged(() => this.reconcile())
  }

  /** True while local transcripts should reach miniapps (the picked model is loaded). */
  isActive(): boolean {
    return this.localActive
  }

  /** BCP-47 language of the loaded model, or null when local STT is inactive. */
  getActiveLanguage(): string | null {
    return this.localActive && this.loadedCode ? sttModelManager.getBcp47ForLanguage(this.loadedCode) : null
  }

  getModelStatus(): LocalSttModelStatus {
    return {...this.status}
  }

  /** Follow the model status. The listener gets the current status immediately, then every change. */
  onModelStatusChanged(listener: (status: LocalSttModelStatus) => void): () => void {
    this.statusListeners.add(listener)
    listener(this.getModelStatus())
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  onSubscriptionChange(hasTranscription: boolean, hasForceLocal = false): void {
    if (
      this.hasTranscriptionSubscription !== hasTranscription ||
      this.hasForceLocalSubscription !== (hasTranscription && hasForceLocal)
    ) {
      this.log(`onSubscriptionChange(hasTx=${hasTranscription}, forceLocal=${hasForceLocal})`)
    }
    this.hasTranscriptionSubscription = hasTranscription
    this.hasForceLocalSubscription = hasTranscription && hasForceLocal
    this.reconcile()
  }

  /**
   * Informational hook, retained for API stability. No longer called: the
   * authoritative switching signal is the cloud-client adapter (local miniapps
   * are powered only by V2). v1 cloud transcripts deliberately do NOT drive this
   * coordinator anymore. Kept for future hysteresis if connection-state alone
   * proves too coarse.
   */
  onCloudTranscript(): void {}

  private reconcile(): void {
    this.attachCloudAdapterIfReady()
    this.attachSelectionIfReady()
    if (!this.shouldUseLocalStt()) {
      this.stop(this.hasTranscriptionSubscription ? "cloud reconnected" : "subscription gone")
      return
    }
    if (!this.hydrated) {
      // Read the saved Speech-page choice first, so a miniapp that subscribes
      // during boot never loads (or downloads) the default model instead.
      this.hydration ??= sttModelManager.getCurrentLanguageFromPreferences().finally(() => {
        this.hydrated = true
        this.reconcile()
      })
      return
    }
    const code = sttModelManager.getCurrentLanguage()
    if (this.localActive && this.loadedCode === code) return
    // A failed model waits for its retry; a different model or new demand tries now.
    if (this.failedCode === code && this.retry.pending) return
    if (this.running && this.runningCode === code) return
    // Anything else supersedes the current run, which bails out at its next step.
    const run = this.start(code)
    this.running = run
    this.runningCode = code
    void run
      .catch((error) => this.log(`start failed unexpectedly: ${error}`))
      .finally(() => {
        if (this.running !== run) return
        this.running = undefined
        this.runningCode = null
      })
  }

  private async start(code: string): Promise<void> {
    const generation = ++this.generation
    const current = () =>
      generation === this.generation && this.shouldUseLocalStt() && sttModelManager.getCurrentLanguage() === code

    if (this.localActive) {
      // Switching models: hold transcripts until the new model is loaded.
      this.log(`switching local stt model ${this.loadedCode} -> ${code}`)
      this.localActive = false
    }
    this.failedCode = null
    this.retry.cancel()

    if (!(await sttModelManager.isModelAvailable(code))) {
      this.log(`local stt model ${code} is missing — downloading`)
      this.setStatus(code, {state: "downloading", progress: 0})
      try {
        await offlineSpeechModelService.downloadSttModel(code, (progress) => {
          if (current()) this.setStatus(code, {state: "downloading", progress})
        })
        if (!current()) return
        // Persist the picked model natively so the recognizer loads it.
        await sttModelManager.activateLanguage(code)
      } catch (error) {
        if (!current()) return
        this.fail(code, `Could not download the speech model: ${errorMessage(error)}`)
        return
      }
    }
    if (!current()) return

    this.log(`loading local stt model ${code}`)
    this.setStatus(code, {state: "loading"})
    try {
      // Native loads only while on-device transcription is in demand, so the
      // demand flag must reach it before the restart, not after a debounce.
      await this.setNativeDemand(true)
      await BluetoothSdk.restartTranscriber()
      // Confirm what native loaded rather than trusting promise completion.
      if (!(await BluetoothSdk.isSttModelLoaded(sttModelManager.getModelPath(code)))) {
        throw new Error("the native recognizer did not load it")
      }
    } catch (error) {
      if (!current()) return
      this.log(`loading ${code} failed: ${error}`)
      void this.setNativeDemand(false)
      this.fail(code, `Could not load the speech model: ${errorMessage(error)}`)
      return
    }
    if (!current()) return

    this.localActive = true
    this.loadedCode = code
    this.retry.reset()
    this.setStatus(code, {state: "ready"})
    this.log(`local stt ready on ${code}`)
  }

  private fail(code: string, reason: string): void {
    this.failedCode = code
    const delay = this.retry.schedule(() => this.reconcile())
    this.log(`${reason}; retrying in ${Math.round(delay / 1000)}s`)
    this.setStatus(code, {state: "unavailable", reason})
  }

  private stop(reason: string): void {
    this.generation++
    this.running = undefined
    this.runningCode = null
    this.retry.reset()
    this.failedCode = null
    if (this.localActive || this.loadedCode || this.status.state !== "idle") {
      this.log(`stopping local stt: ${reason}`)
      void this.setNativeDemand(false)
    }
    this.localActive = false
    this.loadedCode = null
    this.setStatus(sttModelManager.getCurrentLanguage(), {state: "idle"})
  }

  private async setNativeDemand(active: boolean): Promise<void> {
    useSettingsStore.getState().setSetting(ISLAND_SETTINGS_KEYS.localSttFallbackActive, active)
    if (active) {
      await BluetoothSdk.updateBluetoothSettings({[ISLAND_SETTINGS_KEYS.localSttFallbackActive]: true})
    }
  }

  private setStatus(code: string, next: Omit<LocalSttModelStatus, "code" | "language">): void {
    const status: LocalSttModelStatus = {code, language: sttModelManager.getBcp47ForLanguage(code), ...next}
    const previous = this.status
    if (
      previous.code === status.code &&
      previous.state === status.state &&
      previous.progress === status.progress &&
      previous.reason === status.reason
    ) {
      return
    }
    this.status = status
    for (const listener of this.statusListeners) {
      try {
        listener(this.getModelStatus())
      } catch (error) {
        this.log(`model status listener threw: ${error}`)
      }
    }
  }

  private shouldUseLocalStt(): boolean {
    return this.hasTranscriptionSubscription && (this.hasForceLocalSubscription || !this.cloudConnected)
  }

  private log(msg: string): void {
    console.log(`[LocalSttFallback] ${msg}`)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const localSttFallbackCoordinator = LocalSttFallbackCoordinator.getInstance()
export default localSttFallbackCoordinator
