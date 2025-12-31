import {Audio, AVPlaybackStatus} from "expo-av"

interface AudioPlayRequest {
  requestId: string
  audioUrl: string
  appId?: string
  volume?: number
  stopOtherAudio?: boolean
}

interface PlaybackState {
  sound: Audio.Sound
  requestId: string
  appId?: string
  startTime: number
  completed: boolean // Guard against double callbacks
  onComplete: (requestId: string, success: boolean, error: string | null, duration: number | null) => void
}

class AudioPlaybackService {
  private static instance: AudioPlaybackService | null = null
  private activePlaybacks: Map<string, PlaybackState> = new Map()
  private isInitialized = false

  private constructor() {}

  public static getInstance(): AudioPlaybackService {
    if (!AudioPlaybackService.instance) {
      AudioPlaybackService.instance = new AudioPlaybackService()
    }
    return AudioPlaybackService.instance
  }

  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized) return

    try {
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: true,
      })
      this.isInitialized = true
      console.log("AUDIO: Audio mode initialized")
    } catch (error) {
      console.error("AUDIO: Failed to initialize audio mode:", error)
      throw error
    }
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
      await this.ensureInitialized()

      // Stop all other playback if requested
      if (stopOtherAudio && this.activePlaybacks.size > 0) {
        console.log(`AUDIO: Stopping ${this.activePlaybacks.size} active playback(s)`)
        await this.stopAllPlaybacks()
      }

      // Create and load the sound
      const {sound} = await Audio.Sound.createAsync(
        {uri: audioUrl},
        {
          shouldPlay: true,
          volume: Math.max(0, Math.min(1, volume)),
        },
        (status: AVPlaybackStatus) => this.onPlaybackStatusUpdate(status, requestId),
      )

      const playbackState: PlaybackState = {
        sound,
        requestId,
        appId,
        startTime: Date.now(),
        completed: false,
        onComplete,
      }

      this.activePlaybacks.set(requestId, playbackState)
      console.log(`AUDIO: Started playback for ${requestId}, active count: ${this.activePlaybacks.size}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error loading audio"
      console.error(`AUDIO: Failed to play ${requestId}:`, errorMessage)
      onComplete(requestId, false, errorMessage, null)
    }
  }

  /**
   * Handle playback status updates from expo-av
   */
  private onPlaybackStatusUpdate(status: AVPlaybackStatus, requestId: string): void {
    const playback = this.activePlaybacks.get(requestId)

    // Guard against callbacks for unknown or completed playbacks
    if (!playback || playback.completed) {
      return
    }

    if (!status.isLoaded) {
      // Handle error state
      if (status.error) {
        console.error(`AUDIO: Playback error for ${requestId}:`, status.error)
        playback.completed = true
        playback.onComplete(requestId, false, status.error, null)
        this.cleanupPlayback(requestId)
      }
      return
    }

    // Check if playback finished
    if (status.didJustFinish) {
      const durationMs = status.durationMillis || 0
      console.log(`AUDIO: Playback finished for ${requestId}, duration: ${durationMs}ms`)
      playback.completed = true
      playback.onComplete(requestId, true, null, durationMs)
      this.cleanupPlayback(requestId)
    }
  }

  /**
   * Stop playback for a specific app.
   * If appId is not provided, stops all playback.
   */
  public async stopForApp(appId?: string): Promise<void> {
    if (this.activePlaybacks.size === 0) return

    if (!appId) {
      // No appId provided - stop all
      console.log("AUDIO: Stopping all playback (no appId specified)")
      await this.stopAllPlaybacks()
      return
    }

    // Find and stop all playbacks for this app
    const toStop: string[] = []
    for (const [reqId, playback] of this.activePlaybacks) {
      if (playback.appId === appId) {
        toStop.push(reqId)
      }
    }

    if (toStop.length > 0) {
      console.log(`AUDIO: Stopping ${toStop.length} playback(s) for app ${appId}`)
      await Promise.all(toStop.map(reqId => this.stopPlayback(reqId)))
    }
  }

  /**
   * Stop all audio playback
   */
  public async stopAll(): Promise<void> {
    if (this.activePlaybacks.size > 0) {
      console.log(`AUDIO: Stopping all ${this.activePlaybacks.size} playback(s)`)
      await this.stopAllPlaybacks()
    }
  }

  /**
   * Internal method to stop all playbacks
   */
  private async stopAllPlaybacks(): Promise<void> {
    const requestIds = Array.from(this.activePlaybacks.keys())
    await Promise.all(requestIds.map(reqId => this.stopPlayback(reqId)))
  }

  /**
   * Internal method to stop a specific playback by requestId
   */
  private async stopPlayback(requestId: string): Promise<void> {
    const playback = this.activePlaybacks.get(requestId)
    if (!playback) return

    playback.completed = true // Mark as completed to prevent callback

    try {
      await playback.sound.stopAsync()
      await playback.sound.unloadAsync()
      console.log(`AUDIO: Stopped and unloaded ${requestId}`)
    } catch (error) {
      console.error(`AUDIO: Error stopping playback ${requestId}:`, error)
    }

    // Notify that playback was interrupted so cloud can clear the request mapping
    const elapsedMs = Date.now() - playback.startTime
    playback.onComplete(requestId, true, null, elapsedMs)

    this.activePlaybacks.delete(requestId)
  }

  /**
   * Cleanup after playback completes naturally
   */
  private async cleanupPlayback(requestId: string): Promise<void> {
    const playback = this.activePlaybacks.get(requestId)
    if (!playback) return

    try {
      await playback.sound.unloadAsync()
    } catch (error) {
      console.error(`AUDIO: Error unloading sound ${requestId}:`, error)
    }
    this.activePlaybacks.delete(requestId)
    console.log(`AUDIO: Cleaned up ${requestId}, active count: ${this.activePlaybacks.size}`)
  }

  /**
   * Check if audio is currently playing
   */
  public isPlaying(): boolean {
    for (const playback of this.activePlaybacks.values()) {
      if (!playback.completed) {
        return true
      }
    }
    return false
  }

  /**
   * Get current playback app IDs (all active)
   */
  public getActiveAppIds(): string[] {
    const appIds: string[] = []
    for (const playback of this.activePlaybacks.values()) {
      if (!playback.completed && playback.appId) {
        appIds.push(playback.appId)
      }
    }
    return appIds
  }

  /**
   * Get number of active playbacks
   */
  public getActiveCount(): number {
    return this.activePlaybacks.size
  }
}

const audioPlaybackService = AudioPlaybackService.getInstance()
export default audioPlaybackService
