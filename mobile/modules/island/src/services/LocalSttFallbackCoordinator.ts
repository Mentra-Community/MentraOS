import CoreModule from "@mentra/bluetooth-sdk"

import {getRuntimeHooks, ISLAND_SETTINGS_KEYS} from "../runtime/config"

/**
 * Test-mode coordinator: when the feature flag is on AND a local miniapp is
 * subscribed to transcription, always run local STT (no watchdog, no cloud
 * recovery logic). Meant for validating the local-STT pipeline end-to-end
 * before layering in cloud-failure detection.
 *
 * Settings access is host-injected via configureRuntime({settings: ...}).
 * If the host doesn't provide a settings accessor, the flag is read as
 * "off" and the coordinator stays inactive — safe default.
 */
class LocalSttFallbackCoordinator {
  private static instance: LocalSttFallbackCoordinator

  private hasTranscriptionSubscription = false
  private activeLanguage: string | null = null
  private localActive = false

  private constructor() {
    // Subscribe to flag changes if the host supports it.
    const settings = getRuntimeHooks().settings
    settings?.subscribeKey?.(
      ISLAND_SETTINGS_KEYS.localSttFallbackEnabled,
      (enabled) => {
        this.log(`feature flag changed: ${enabled}`)
        void this.reconcile()
      },
    )
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

  // Kept for API compatibility; unused in test mode.
  onVad(_isSpeaking: boolean): void {}
  onCloudTranscript(): void {}

  private async reconcile(): Promise<void> {
    const flag = this.flagEnabled()
    const shouldBeActive = flag && this.hasTranscriptionSubscription

    if (shouldBeActive && !this.localActive) {
      await this.startLocalStt()
    } else if (!shouldBeActive && this.localActive) {
      this.stopLocalStt("subscription gone or flag disabled")
    }
  }

  private async startLocalStt(): Promise<void> {
    this.log("starting local stt")
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

  private flagEnabled(): boolean {
    return !!getRuntimeHooks().settings?.getSetting(ISLAND_SETTINGS_KEYS.localSttFallbackEnabled)
  }

  private log(msg: string): void {
    console.log(`[LocalSttFallback] ${msg}`)
  }
}

const localSttFallbackCoordinator = LocalSttFallbackCoordinator.getInstance()
export default localSttFallbackCoordinator
