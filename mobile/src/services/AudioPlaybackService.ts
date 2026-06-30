import {createAudioPlayer, AudioPlayer, AudioStatus, setAudioModeAsync} from "expo-audio"
import BluetoothSdk from "@mentra/bluetooth-sdk"
import {BgTimer} from "@mentra/island"

interface AudioPlayRequest {
  requestId: string
  audioUrl: string
  appId?: string
  volume?: number
  stopOtherAudio?: boolean
}

interface PlaybackState {
  requestId: string
  appId?: string
  startTime: number
  completed: boolean // Guard against double callbacks
  onComplete: (requestId: string, success: boolean, error: string | null, duration: number | null) => void
}

class AudioPlaybackService {
  private static instance: AudioPlaybackService | null = null
  // Reuse a single AudioPlayer to avoid AudioTrack exhaustion
  // Creating new ExoPlayer instances per request leads to -12 ENOMEM errors
  private player: AudioPlayer | null = null
  private currentPlayback: PlaybackState | null = null
  private audioModeConfigured: boolean = false
  // Debounce timer for notifying native that audio stopped
  // Prevents mic toggle flicker when playing back-to-back audio
  // Uses BgTimer to work reliably when app is backgrounded on Android
  private audioStopDebounceTimer: number | null = null
  // Original glasses media volume captured before we bump it for A2DP playback.
  private glassesVolumeRestoreLevel: number | null = null
  private static readonly AUDIO_STOP_DEBOUNCE_MS = 1500
  private static readonly A2DP_TAIL_DRAIN_MS = 900
  /** If glasses report step volume at or below this, bump to FLOOR before A2DP playback. */
  private static readonly GLASSES_VOLUME_LOW_THRESHOLD = 2
  private static readonly GLASSES_VOLUME_FLOOR = 9

  private constructor() {}

  /**
   * Configure audio mode for playback, re-asserting it on EVERY play.
   *
   * This must run before each play — not just once — because other parts of the
   * app put the shared iOS AVAudioSession into a record-oriented category and
   * never restore it. In particular the phone mic (PhoneMic.swift) switches the
   * session to `.playAndRecord` (sometimes `.voiceChat`/earpiece routing) while
   * capturing and only deactivates it on stop, leaving the category sticky. A
   * miniapp like the Recorder records and then immediately plays back through
   * this service; if we kept the old "configure once" guard, playback would land
   * in the leftover `.playAndRecord` session and be inaudible on the phone
   * speaker (the symptom: the progress bar runs but no sound comes out). Calling
   * setAudioModeAsync with no `allowsRecording` maps to category `.playback`,
   * reclaiming the speaker route. `audioModeConfigured` is kept only to gate the
   * one-time log.
   */
  private async ensureAudioModeConfigured(): Promise<void> {
    try {
      await setAudioModeAsync({
        shouldPlayInBackground: true,
        playsInSilentMode: true,
        interruptionMode: "duckOthers",
      })
      if (!this.audioModeConfigured) {
        this.audioModeConfigured = true
        console.log("AUDIO: Audio mode configured for playback")
      }
    } catch (error) {
      console.error("AUDIO: Failed to configure audio mode:", error)
      // Don't block playback if audio mode config fails
    }
  }

  public static getInstance(): AudioPlaybackService {
    if (!AudioPlaybackService.instance) {
      AudioPlaybackService.instance = new AudioPlaybackService()
    }
    return AudioPlaybackService.instance
  }

  /**
   * Ensure we have a reusable player instance
   */
  private ensurePlayer(): AudioPlayer {
    if (!this.player) {
      console.log("AUDIO: Creating reusable AudioPlayer instance")
      this.player = createAudioPlayer(null)

      // Add status listener once - it will handle all playback completions
      this.player.addListener("playbackStatusUpdate", (status: AudioStatus) => {
        this.onPlaybackStatusUpdate(status)
      })
    }
    return this.player
  }

  private async getGlassesMediaVolumeWithTiming() {
    const startedAt = Date.now()
    try {
      const result = await BluetoothSdk.getGlassesMediaVolume()
      console.log(`AUDIO: Glasses media volume read completed in ${Date.now() - startedAt}ms`)
      return result
    } catch (error) {
      console.warn(
        `AUDIO: Glasses media volume read failed after ${Date.now() - startedAt}ms:`,
        error instanceof Error ? error.message : String(error),
      )
      throw error
    }
  }

  private async setGlassesMediaVolumeWithTiming(level: number) {
    const startedAt = Date.now()
    try {
      const result = await BluetoothSdk.setGlassesMediaVolume(level)
      console.log(`AUDIO: Glasses media volume set(${level}) completed in ${Date.now() - startedAt}ms`)
      return result
    } catch (error) {
      console.warn(
        `AUDIO: Glasses media volume set(${level}) failed after ${Date.now() - startedAt}ms:`,
        error instanceof Error ? error.message : String(error),
      )
      throw error
    }
  }

  /**
   * Mentra Live: raise glasses media volume over BLE when it is very low so A2DP prompts are audible.
   * Fail-open on unsupported devices, timeouts, or errors.
   */
  private async ensureGlassesMediaVolumeForA2dp(playback: PlaybackState): Promise<void> {
    if (this.glassesVolumeRestoreLevel !== null) {
      console.log(
        `AUDIO: Keeping bumped glasses media volume at ${AudioPlaybackService.GLASSES_VOLUME_FLOOR} during ongoing playback`,
      )
      return
    }

    try {
      const raw = await this.getGlassesMediaVolumeWithTiming()
      const level = Number(raw.level)
      const statusCode = Number(raw.statusCode)
      if (!Number.isFinite(level)) {
        console.log("AUDIO: Received glasses media volume response without numeric level:", JSON.stringify(raw))
        return
      }
      const k900S = Number.isFinite(statusCode) && statusCode >= 0 ? ` K900_S=${statusCode}` : ""
      console.log(`AUDIO: Glasses media step volume (wearable knob, 0-15 scale): ${level}/15.${k900S}`)
      if (level > AudioPlaybackService.GLASSES_VOLUME_LOW_THRESHOLD) {
        return
      }
      if (this.currentPlayback !== playback || playback.completed) {
        console.log("AUDIO: Skipping glasses volume bump; playback already ended")
        return
      }
      console.log(`AUDIO: Raising glasses media volume (was ${level})`)
      await this.setGlassesMediaVolumeWithTiming(AudioPlaybackService.GLASSES_VOLUME_FLOOR)
      if (this.currentPlayback === playback && !playback.completed) {
        this.glassesVolumeRestoreLevel = level
      } else {
        console.log("AUDIO: Restoring glasses volume immediately; playback ended during volume bump")
        await this.setGlassesMediaVolumeWithTiming(level)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn("AUDIO: Skipping glasses volume bump:", msg)
    }
  }

  /**
   * Restore the user's original glasses media step volume after A2DP playback finishes.
   */
  private async restoreGlassesMediaVolume(): Promise<void> {
    const restoreLevel = this.glassesVolumeRestoreLevel
    if (restoreLevel === null) {
      return
    }

    try {
      console.log(`AUDIO: Restoring glasses media volume to ${restoreLevel}`)
      await this.setGlassesMediaVolumeWithTiming(restoreLevel)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`AUDIO: Failed to restore glasses volume to ${restoreLevel}:`, msg)
    } finally {
      this.glassesVolumeRestoreLevel = null
    }
  }

  private pauseFinishedPlayerAfterTail(playback: PlaybackState): void {
    BgTimer.setTimeout(() => {
      if (this.currentPlayback) return
      if (!this.player) return
      try {
        this.player.pause()
        console.log(
          `AUDIO: Paused finished player for ${playback.requestId} after ${AudioPlaybackService.A2DP_TAIL_DRAIN_MS}ms tail drain`,
        )
      } catch (e) {
        console.warn("AUDIO: Error pausing player after tail drain:", e)
      }
    }, AudioPlaybackService.A2DP_TAIL_DRAIN_MS)
  }

  /**
   * Play audio from a URL.
   * Returns a promise that resolves with playback result when audio finishes or errors.
   */
  public async play(
    request: AudioPlayRequest,
    onComplete: (requestId: string, success: boolean, error: string | null, duration: number | null) => void,
  ): Promise<void> {
    const {requestId, audioUrl, appId, volume = 1.0, stopOtherAudio = true} = request

    console.log(`AUDIO: Play request ${requestId}${appId ? ` from ${appId}` : ""}: ${audioUrl}`)

    try {
      // Ensure audio mode is configured for background playback
      await this.ensureAudioModeConfigured()

      // Stop current playback if any (notify previous callback)
      if (stopOtherAudio && this.currentPlayback && !this.currentPlayback.completed) {
        console.log(`AUDIO: Interrupting current playback for new request`)
        this.interruptCurrentPlayback(true)
      }

      // Get or create the reusable player
      const player = this.ensurePlayer()

      // Set volume
      player.volume = Math.max(0, Math.min(1, volume))

      // Store the new playback state
      const playback: PlaybackState = {
        requestId,
        appId,
        startTime: Date.now(),
        completed: false,
        onComplete,
      }
      this.currentPlayback = playback

      // Replace the source and play
      // Using replace() reuses the existing ExoPlayer/AudioTrack instead of creating new ones
      player.replace({uri: audioUrl})
      player.play()

      // Mentra Live volume reads can block up to 5s when the glasses don't
      // answer. Do not put that in front of playback; guard it against late
      // completion so a stale volume response cannot bump after this request is
      // already over.
      void this.ensureGlassesMediaVolumeForA2dp(playback)

      // Notify native that our app is playing audio
      // Used to suspend LC3 mic during audio playback to avoid MCU overload
      // Cancel any pending "stop" notification first (handles back-to-back audio)
      if (this.audioStopDebounceTimer !== null) {
        BgTimer.clearTimeout(this.audioStopDebounceTimer)
        this.audioStopDebounceTimer = null
      }
      BluetoothSdk.setOwnAppAudioPlaying(true).catch((e) => {
        console.warn("AUDIO: Failed to notify native of audio start:", e)
      })

      console.log(`AUDIO: Started playback for ${requestId}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error loading audio"
      console.error(`AUDIO: Failed to play ${requestId}:`, errorMessage)
      void this.restoreGlassesMediaVolume()
      onComplete(requestId, false, errorMessage, null)
    }
  }

  /**
   * Interrupt current playback and notify its callback
   */
  private interruptCurrentPlayback(preserveGlassesMediaVolume: boolean = false): void {
    if (!this.currentPlayback || this.currentPlayback.completed) return

    const playback = this.currentPlayback
    playback.completed = true
    this.currentPlayback = null

    // Stop the player
    if (this.player) {
      try {
        this.player.pause()
      } catch (error) {
        console.error("AUDIO: Error pausing player:", error)
      }
    }

    // Notify native that our app stopped playing audio (debounced)
    this.notifyAudioStopDebounced()
    if (!preserveGlassesMediaVolume) {
      void this.restoreGlassesMediaVolume()
    }

    // Notify that playback was interrupted
    const elapsedMs = Date.now() - playback.startTime
    playback.onComplete(playback.requestId, true, null, elapsedMs)
    console.log(`AUDIO: Interrupted ${playback.requestId} after ${elapsedMs}ms`)
  }

  /**
   * Handle playback status updates from expo-audio
   */
  private onPlaybackStatusUpdate(status: AudioStatus): void {
    const playback = this.currentPlayback

    // Guard against callbacks for unknown or completed playbacks
    if (!playback || playback.completed) {
      return
    }

    // Check if playback finished
    if (status.didJustFinish) {
      const durationMs = (status.duration || 0) * 1000 // expo-audio uses seconds
      console.log(`AUDIO: Playback finished for ${playback.requestId}, duration: ${durationMs}ms`)
      playback.completed = true

      // ExoPlayer can report finished before an A2DP sink has audibly drained
      // the last buffered audio. Pausing immediately can clip the tail on
      // Mentra Live; defer cleanup unless another playback has started.
      this.pauseFinishedPlayerAfterTail(playback)

      playback.onComplete(playback.requestId, true, null, durationMs)
      this.currentPlayback = null

      // Notify native that our app stopped playing audio (debounced)
      this.notifyAudioStopDebounced()
      void this.restoreGlassesMediaVolume()
      return
    }

    // Detect silent playback failures: expo-audio doesn't surface errors to JS,
    // so when ExoPlayer fails to load/play a URL (network error, HTTP 500, etc.),
    // the player state goes to "idle" with nothing loaded and no buffering.
    // We wait 1500ms after play() to avoid false positives during initial load.
    if (status.playbackState === "idle" && !status.isBuffering && !status.isLoaded) {
      const elapsedMs = Date.now() - playback.startTime
      if (elapsedMs > 1500) {
        console.error(`AUDIO: Playback failed for ${playback.requestId} (player went idle after ${elapsedMs}ms)`)
        playback.completed = true
        playback.onComplete(playback.requestId, false, "Playback failed (player went idle)", null)
        this.currentPlayback = null
        this.notifyAudioStopDebounced()
        void this.restoreGlassesMediaVolume()
      }
    }
  }

  /**
   * Notify native that audio stopped, with debouncing to prevent mic toggle flicker
   * when playing back-to-back audio files
   */
  private notifyAudioStopDebounced(): void {
    // Clear any existing timer
    if (this.audioStopDebounceTimer !== null) {
      BgTimer.clearTimeout(this.audioStopDebounceTimer)
    }

    // Set a new timer - if new audio starts within this window, the timer gets cancelled
    // Uses BgTimer to work reliably when app is backgrounded on Android
    this.audioStopDebounceTimer = BgTimer.setTimeout(() => {
      this.audioStopDebounceTimer = null
      BluetoothSdk.setOwnAppAudioPlaying(false).catch((e) => {
        console.warn("AUDIO: Failed to notify native of audio stop:", e)
      })
    }, AudioPlaybackService.AUDIO_STOP_DEBOUNCE_MS)
  }

  /**
   * Stop playback for a specific app.
   * If appId is not provided, stops all playback.
   */
  public async stopForApp(appId?: string): Promise<void> {
    if (!this.currentPlayback || this.currentPlayback.completed) return

    if (!appId || this.currentPlayback.appId === appId) {
      console.log(`AUDIO: Stopping playback for app ${appId || "(all)"}`)
      this.interruptCurrentPlayback()
    }
  }

  /**
   * Stop all audio playback
   */
  public async stopAll(): Promise<void> {
    if (this.currentPlayback && !this.currentPlayback.completed) {
      console.log("AUDIO: Stopping all playback")
      this.interruptCurrentPlayback()
    }
  }

  /**
   * Check if audio is currently playing
   */
  public isPlaying(): boolean {
    return this.currentPlayback !== null && !this.currentPlayback.completed
  }

  /**
   * Get current playback app IDs (all active)
   */
  public getActiveAppIds(): string[] {
    if (this.currentPlayback && !this.currentPlayback.completed && this.currentPlayback.appId) {
      return [this.currentPlayback.appId]
    }
    return []
  }

  /**
   * Get number of active playbacks
   */
  public getActiveCount(): number {
    return this.currentPlayback && !this.currentPlayback.completed ? 1 : 0
  }

  /**
   * Release the player entirely (call when app is shutting down)
   */
  public release(): void {
    if (this.currentPlayback && !this.currentPlayback.completed) {
      this.interruptCurrentPlayback()
    } else {
      void this.restoreGlassesMediaVolume()
    }

    if (this.player) {
      try {
        this.player.remove()
        console.log("AUDIO: Released AudioPlayer")
      } catch (error) {
        console.error("AUDIO: Error releasing player:", error)
      }
      this.player = null
    }
  }
}

const audioPlaybackService = AudioPlaybackService.getInstance()
export default audioPlaybackService
