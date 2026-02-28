import {createAudioPlayer, AudioPlayer, AudioStatus, setAudioModeAsync} from "expo-audio"
import CoreModule from "modules/core"
import {BackgroundTimer} from "@/utils/timers"

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
  // Uses BackgroundTimer to work reliably when app is backgrounded on Android
  private audioStopDebounceTimer: number | null = null
  private static readonly AUDIO_STOP_DEBOUNCE_MS = 500

  private constructor() {}

  /**
   * Configure audio mode for background playback.
   * Must be called before playing audio to ensure playback continues when app is backgrounded.
   */
  private async ensureAudioModeConfigured(): Promise<void> {
    if (this.audioModeConfigured) return

    try {
      await setAudioModeAsync({
        shouldPlayInBackground: true,
        playsInSilentMode: true,
      })
      this.audioModeConfigured = true
      console.log("AUDIO: Audio mode configured for background playback")
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
        this.interruptCurrentPlayback()
      }

      // Get or create the reusable player
      const player = this.ensurePlayer()

      // Set volume
      player.volume = Math.max(0, Math.min(1, volume))

      // Store the new playback state
      this.currentPlayback = {
        requestId,
        appId,
        startTime: Date.now(),
        completed: false,
        onComplete,
      }

      // Replace the source and play
      // Using replace() reuses the existing ExoPlayer/AudioTrack instead of creating new ones
      player.replace({uri: audioUrl})
      player.play()

      // Notify native that our app is playing audio
      // Used to suspend LC3 mic during audio playback to avoid MCU overload
      // Cancel any pending "stop" notification first (handles back-to-back audio)
      if (this.audioStopDebounceTimer !== null) {
        BackgroundTimer.clearTimeout(this.audioStopDebounceTimer)
        this.audioStopDebounceTimer = null
      }
      CoreModule.setOwnAppAudioPlaying(true).catch((e) => {
        console.warn("AUDIO: Failed to notify native of audio start:", e)
      })

      console.log(`AUDIO: Started playback for ${requestId}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error loading audio"
      console.error(`AUDIO: Failed to play ${requestId}:`, errorMessage)
      onComplete(requestId, false, errorMessage, null)
    }
  }

  /**
   * Interrupt current playback and notify its callback
   */
  private interruptCurrentPlayback(): void {
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
      playback.onComplete(playback.requestId, true, null, durationMs)
      this.currentPlayback = null

      // Notify native that our app stopped playing audio (debounced)
      this.notifyAudioStopDebounced()
    }
  }

  /**
   * Notify native that audio stopped, with debouncing to prevent mic toggle flicker
   * when playing back-to-back audio files
   */
  private notifyAudioStopDebounced(): void {
    // Clear any existing timer
    if (this.audioStopDebounceTimer !== null) {
      BackgroundTimer.clearTimeout(this.audioStopDebounceTimer)
    }

    // Set a new timer - if new audio starts within this window, the timer gets cancelled
    // Uses BackgroundTimer to work reliably when app is backgrounded on Android
    this.audioStopDebounceTimer = BackgroundTimer.setTimeout(() => {
      this.audioStopDebounceTimer = null
      CoreModule.setOwnAppAudioPlaying(false).catch((e) => {
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
