import {createAudioPlayer, AudioPlayer, AudioStatus, setAudioModeAsync} from "expo-audio"
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import {AppState, Platform} from "react-native"
import {BgTimer} from "../utils/timers"
import {setAudioCloudUplinkSuppressed} from "./AudioCloudUplink"
import {SILENT_AUDIO_SOURCE} from "./audioPlaybackAssets"

const RESTORE_GLASSES_VOLUME_AFTER_PLAYBACK = false

interface AudioPlayRequest {
  requestId: string
  audioUrl: string
  appId?: string
  volume?: number
  stopOtherAudio?: boolean
  /**
   * Suppress microphone audio sent to cloud STT while this audio is audible.
   * Opt-in and off by default: the suppression is global to the uplink, so a
   * caller that sets this silences STT for every running app, not just itself.
   * No platform path sets it today (see AudioCloudUplink and OS-1741).
   */
  suppressCloudUplink?: boolean
}

export type AudioPlaybackCompletionReason = "completed" | "interrupted" | "error"

type AudioPlaybackCompletion = (
  requestId: string,
  success: boolean,
  error: string | null,
  duration: number | null,
  reason: AudioPlaybackCompletionReason,
) => void

interface PlaybackState {
  requestId: string
  audioUrl: string
  uplinkSuppressionId: string
  appId?: string
  startTime: number
  completed: boolean // Guard against double callbacks
  suppressCloudUplink: boolean
  onComplete: AudioPlaybackCompletion
}

interface PendingPlaybackState {
  cancelled: boolean
  audioUrl: string
  appId?: string
  createdAt: number
}

/** Open request for a live PCM output stream (miniapp speaker.createStream). */
export interface AudioStreamOpenRequest {
  streamId: string
  appId: string
  /** PCM sample rate in Hz (16000 / 24000 / 48000). */
  sampleRate: number
  /** Channel count. v1 is mono. */
  channels: number
  volume?: number
  stopOtherAudio?: boolean
  /**
   * Called when the stream ends for any reason (drained after close, aborted,
   * interrupted by other audio, or native error).
   */
  onEnded: (streamId: string, success: boolean, error: string | null, durationMs: number | null) => void
}

/** One live PCM stream session, backed by native streaming audio. */
interface StreamState {
  streamId: string
  appId: string
  startTime: number
  ended: boolean // Guard against double onEnded
  onEnded: AudioStreamOpenRequest["onEnded"]
}

class AudioPlaybackService {
  private static instance: AudioPlaybackService | null = null
  // Reuse a single AudioPlayer to avoid AudioTrack exhaustion
  // Creating new ExoPlayer instances per request leads to -12 ENOMEM errors
  private player: AudioPlayer | null = null
  // The source currently loaded into the reusable player. Keep object identity
  // so a delayed tail cleanup from an older request cannot unload a newer one.
  private loadedPlayback: PlaybackState | null = null
  private currentPlayback: PlaybackState | null = null
  // Requests that entered play() but have not yet reached the native player.
  // Keeping these addressable prevents a cancelled request from starting after
  // an async audio-mode or stream-cleanup step finishes.
  private pendingPlaybacks = new Map<string, PendingPlaybackState>()
  // Live PCM streams (speaker.createStream), keyed by streamId. The runtime
  // enforces one per app; stopOtherAudio interrupts across apps.
  private streams = new Map<string, StreamState>()
  private audioModeConfigured: boolean = false
  // Debounce timer for notifying native that audio stopped
  // Prevents mic toggle flicker when playing back-to-back audio
  // Uses BgTimer to work reliably when app is backgrounded on Android
  private audioStopDebounceTimer: number | null = null
  // Mentra Live's A2DP route may go idle between prompts. Keep a short warm
  // window after actual audio so we only pre-roll the first sound after idle.
  private audioRouteWarmUntil = 0
  private audioRouteWarmupPromise: Promise<void> | null = null
  // Playback that opted into suppression stays suppressed briefly while its
  // A2DP tail drains. Track those completed sources so a later unsuppressed
  // sound can resume listening immediately instead of inheriting that gate.
  private tailUplinkSuppressions = new Set<string>()
  // Original glasses media volume captured before we bump it for A2DP playback.
  private glassesVolumeRestoreLevel: number | null = null
  private static readonly AUDIO_STOP_DEBOUNCE_MS = 1500
  private static readonly A2DP_TAIL_DRAIN_MS = 700
  private static readonly AUDIO_ROUTE_WARM_WINDOW_MS = 1500
  private static readonly AUDIO_ROUTE_PREWARM_MS = 200
  private static readonly AUDIO_ROUTE_PREWARM_SAMPLE_RATE = 16_000
  /** Break accidental same-app replay storms without affecting deliberate later replays. */
  private static readonly DUPLICATE_PLAY_WINDOW_MS = 750
  private static readonly AUDIO_ROUTE_PREWARM_PCM_BASE64 =
    "AAAA".repeat(
      Math.floor(
        (AudioPlaybackService.AUDIO_ROUTE_PREWARM_MS * AudioPlaybackService.AUDIO_ROUTE_PREWARM_SAMPLE_RATE * 2) /
          (1000 * 3),
      ),
    ) + "AA=="
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

  private markAudioRouteWarm(): void {
    this.audioRouteWarmUntil = Date.now() + AudioPlaybackService.AUDIO_ROUTE_WARM_WINDOW_MS
  }

  private isAudioRouteWarm(): boolean {
    return this.currentPlayback !== null || this.streams.size > 0 || Date.now() < this.audioRouteWarmUntil
  }

  /**
   * Wake a cold Android A2DP route with silent PCM before a user-facing sound.
   *
   * Do not call pcmStreamClose here: some Bluetooth routes do not advance an
   * idle AudioTrack playback head, so close waits for its drain timeout. After
   * exactly 200ms of silence we abort the stream instead, which releases the
   * pre-roll immediately and lets the real URL playback begin.
   */
  private async prewarmAudioRouteIfCold(): Promise<void> {
    if (Platform.OS !== "android" || this.isAudioRouteWarm()) return
    // This silent PCM pre-roll is only an anti-clipping optimization. Some
    // Android devices defer opening its AudioTrack until the host Activity
    // resumes even though the real URL player supports background playback.
    // Never let that optional pre-roll block a glasses-initiated prompt.
    if (AppState.currentState !== "active") {
      console.log(`AUDIO: Skipping cold-route prewarm while app is ${AppState.currentState}`)
      return
    }
    if (this.audioRouteWarmupPromise) return this.audioRouteWarmupPromise

    const streamId = `audio-route-prewarm-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const warmup = (async () => {
      let opened = false
      const startedAt = Date.now()
      try {
        console.log(`AUDIO: Cold route; prewarming with ${AudioPlaybackService.AUDIO_ROUTE_PREWARM_MS}ms silence`)
        await BluetoothSdk.pcmStreamOpen(streamId, AudioPlaybackService.AUDIO_ROUTE_PREWARM_SAMPLE_RATE, 1, 1)
        opened = true
        await BluetoothSdk.pcmStreamWrite(streamId, AudioPlaybackService.AUDIO_ROUTE_PREWARM_PCM_BASE64)
        await new Promise<void>((resolve) => {
          BgTimer.setTimeout(resolve, AudioPlaybackService.AUDIO_ROUTE_PREWARM_MS)
        })
        await BluetoothSdk.pcmStreamAbort(streamId)
        opened = false
        this.markAudioRouteWarm()
        console.log(`AUDIO: Cold-route prewarm completed in ${Date.now() - startedAt}ms`)
      } catch (error) {
        console.warn("AUDIO: Cold-route prewarm failed; continuing with requested audio:", error)
      } finally {
        if (opened) await BluetoothSdk.pcmStreamAbort(streamId).catch(() => {})
      }
    })()
    this.audioRouteWarmupPromise = warmup
    try {
      await warmup
    } finally {
      if (this.audioRouteWarmupPromise === warmup) this.audioRouteWarmupPromise = null
    }
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
      } else if (RESTORE_GLASSES_VOLUME_AFTER_PLAYBACK) {
        console.log("AUDIO: Restoring glasses volume immediately; playback ended during volume bump")
        await this.setGlassesMediaVolumeWithTiming(level)
      } else {
        console.log("AUDIO: Leaving bumped glasses media volume unchanged after playback")
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
    if (!RESTORE_GLASSES_VOLUME_AFTER_PLAYBACK) {
      this.glassesVolumeRestoreLevel = null
      console.log("AUDIO: Leaving bumped glasses media volume unchanged after playback")
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

  private unloadPlaybackSource(playback: PlaybackState, reason: string): void {
    if (this.loadedPlayback !== playback) return
    const player = this.player
    if (!player) {
      this.loadedPlayback = null
      return
    }

    try {
      player.pause()
    } catch (e) {
      console.warn(`AUDIO: Error pausing ${playback.requestId} during ${reason}:`, e)
    }

    try {
      // replace(null) fails native argument casting on iOS, while remove()
      // destroys the ExoPlayer that Android must reuse to avoid AudioTrack
      // exhaustion. Replacing with bundled silence detaches the previous media
      // item on both platforms and leaves the native player alive.
      player.replace(SILENT_AUDIO_SOURCE)
      console.log(`AUDIO: Cleared source for ${playback.requestId} during ${reason}`)
    } catch (e) {
      console.warn(`AUDIO: Error clearing ${playback.requestId} during ${reason}:`, e)
    } finally {
      if (this.loadedPlayback === playback) this.loadedPlayback = null
    }
  }

  private clearFinishedPlayerAfterTail(playback: PlaybackState): void {
    if (playback.suppressCloudUplink) {
      this.tailUplinkSuppressions.add(playback.uplinkSuppressionId)
    }
    BgTimer.setTimeout(() => {
      // ExoPlayer's completion event precedes the final A2DP audio reaching the
      // glasses. Keep cloud STT gated until that audible tail has drained, then
      // accept fresh microphone audio immediately without restarting LC3.
      if (playback.suppressCloudUplink && this.tailUplinkSuppressions.delete(playback.uplinkSuppressionId)) {
        setAudioCloudUplinkSuppressed(playback.uplinkSuppressionId, false)
      }
      this.unloadPlaybackSource(playback, `${AudioPlaybackService.A2DP_TAIL_DRAIN_MS}ms A2DP tail drain`)
    }, AudioPlaybackService.A2DP_TAIL_DRAIN_MS)
  }

  private releaseTailUplinkSuppressions(): void {
    for (const sourceId of this.tailUplinkSuppressions) {
      setAudioCloudUplinkSuppressed(sourceId, false)
    }
    this.tailUplinkSuppressions.clear()
  }

  /**
   * Play audio from a URL.
   * Returns a promise that resolves with playback result when audio finishes or errors.
   */
  public async play(request: AudioPlayRequest, onComplete: AudioPlaybackCompletion): Promise<void> {
    const {requestId, audioUrl, appId, volume = 1.0, stopOtherAudio = true, suppressCloudUplink = false} = request
    const now = Date.now()
    const activeDuplicate =
      this.currentPlayback &&
      !this.currentPlayback.completed &&
      this.currentPlayback.appId === appId &&
      this.currentPlayback.audioUrl === audioUrl &&
      now - this.currentPlayback.startTime < AudioPlaybackService.DUPLICATE_PLAY_WINDOW_MS
    const pendingDuplicate = [...this.pendingPlaybacks.values()].some(
      (candidate) =>
        !candidate.cancelled &&
        candidate.appId === appId &&
        candidate.audioUrl === audioUrl &&
        now - candidate.createdAt < AudioPlaybackService.DUPLICATE_PLAY_WINDOW_MS,
    )
    if (activeDuplicate || pendingDuplicate) {
      console.warn(`AUDIO: Suppressed duplicate play request ${requestId}${appId ? ` from ${appId}` : ""}`)
      onComplete(requestId, false, "Duplicate audio request suppressed", 0, "error")
      return
    }

    const pending: PendingPlaybackState = {cancelled: false, audioUrl, appId, createdAt: now}
    this.pendingPlaybacks.set(requestId, pending)

    console.log(`AUDIO: Play request ${requestId}${appId ? ` from ${appId}` : ""}: ${audioUrl}`)

    try {
      // Ensure audio mode is configured for background playback
      await this.ensureAudioModeConfigured()
      if (pending.cancelled) {
        onComplete(requestId, true, null, 0, "interrupted")
        return
      }
      await this.prewarmAudioRouteIfCold()
      if (pending.cancelled) {
        onComplete(requestId, true, null, 0, "interrupted")
        return
      }

      // URL playback reuses one native player, so replacing its source always
      // interrupts the previous URL even when stopOtherAudio is false. Notify
      // that request before replacing it so its promise cannot hang. The option
      // still controls whether separate PCM streams are interrupted below.
      if (this.currentPlayback && !this.currentPlayback.completed) {
        console.log(`AUDIO: Interrupting current URL playback for new request`)
        this.interruptCurrentPlayback(true)
      }
      // Live PCM streams count as "other audio" too.
      if (stopOtherAudio) {
        await this.abortAllStreams()
      }
      if (pending.cancelled) {
        onComplete(requestId, true, null, 0, "interrupted")
        return
      }

      if (!suppressCloudUplink) {
        this.releaseTailUplinkSuppressions()
      }

      // Get or create the reusable player
      const player = this.ensurePlayer()

      // Set volume
      player.volume = Math.max(0, Math.min(1, volume))

      // Store the new playback state
      const playback: PlaybackState = {
        requestId,
        audioUrl,
        uplinkSuppressionId: `url:${requestId}`,
        appId,
        startTime: Date.now(),
        completed: false,
        suppressCloudUplink,
        onComplete,
      }
      this.currentPlayback = playback
      this.pendingPlaybacks.delete(requestId)
      this.markAudioRouteWarm()
      if (playback.suppressCloudUplink) {
        setAudioCloudUplinkSuppressed(playback.uplinkSuppressionId, true)
      }

      // Replace the source and play
      // Using replace() reuses the existing ExoPlayer/AudioTrack instead of creating new ones
      player.replace({uri: audioUrl})
      this.loadedPlayback = playback
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
      if (suppressCloudUplink) {
        setAudioCloudUplinkSuppressed(`url:${requestId}`, false)
      }
      const failedPlayback = this.currentPlayback?.requestId === requestId ? this.currentPlayback : null
      if (failedPlayback) {
        failedPlayback.completed = true
        this.currentPlayback = null
        this.unloadPlaybackSource(failedPlayback, "playback start failure")
      }
      if (pending.cancelled) {
        onComplete(requestId, true, null, 0, "interrupted")
        return
      }
      const errorMessage = error instanceof Error ? error.message : "Unknown error loading audio"
      console.error(`AUDIO: Failed to play ${requestId}:`, errorMessage)
      void this.restoreGlassesMediaVolume()
      onComplete(requestId, false, errorMessage, null, "error")
    } finally {
      if (this.pendingPlaybacks.get(requestId) === pending) {
        this.pendingPlaybacks.delete(requestId)
      }
    }
  }

  /**
   * Cancel one URL playback without touching audio owned by another request.
   * Pending requests are prevented from reaching the native player; active
   * requests are paused synchronously before their completion callback fires.
   */
  public cancelPlayback(requestId: string): void {
    const pending = this.pendingPlaybacks.get(requestId)
    if (pending) pending.cancelled = true

    if (this.currentPlayback?.requestId === requestId && !this.currentPlayback.completed) {
      this.interruptCurrentPlayback()
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
    if (playback.suppressCloudUplink) {
      setAudioCloudUplinkSuppressed(playback.uplinkSuppressionId, false)
    }
    this.markAudioRouteWarm()

    // Pausing alone leaves the URI available to OS/Bluetooth media Play.
    // Unload it unless a newer request has already replaced this source.
    this.unloadPlaybackSource(playback, "interruption")

    // Notify native that our app stopped playing audio (debounced)
    this.notifyAudioStopDebounced()
    if (!preserveGlassesMediaVolume) {
      void this.restoreGlassesMediaVolume()
    }

    // Notify that playback was interrupted
    const elapsedMs = Date.now() - playback.startTime
    playback.onComplete(playback.requestId, true, null, elapsedMs, "interrupted")
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
      // Mentra Live; defer cleanup and guard it against a newer loaded source.
      this.clearFinishedPlayerAfterTail(playback)

      this.currentPlayback = null
      playback.onComplete(playback.requestId, true, null, durationMs, "completed")
      this.markAudioRouteWarm()

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
        this.currentPlayback = null
        if (playback.suppressCloudUplink) {
          setAudioCloudUplinkSuppressed(playback.uplinkSuppressionId, false)
        }
        this.unloadPlaybackSource(playback, "playback failure")
        playback.onComplete(playback.requestId, false, "Playback failed (player went idle)", null, "error")
        this.markAudioRouteWarm()
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
      // URL playback and live PCM streams may overlap when stopOtherAudio is false.
      // A URL that ends must not clear the native playback signal while another
      // source is still active, or the mic watchdog can interrupt that source.
      if (this.isPlaying()) return
      BluetoothSdk.setOwnAppAudioPlaying(false).catch((e) => {
        console.warn("AUDIO: Failed to notify native of audio stop:", e)
      })
    }, AudioPlaybackService.AUDIO_STOP_DEBOUNCE_MS)
  }

  // ── live PCM output streams (miniapp speaker.createStream) ────────────────

  /**
   * Open a live PCM stream session. Chunks are pushed with writeStreamChunk
   * into native streaming audio (AudioTrack on Android, AVAudioEngine on iOS),
   * following the media route such as A2DP to connected glasses.
   */
  public async openStream(request: AudioStreamOpenRequest): Promise<void> {
    const {streamId, appId, sampleRate, channels, volume = 1.0, stopOtherAudio = true} = request
    console.log(`AUDIO: Stream open ${streamId} from ${appId}: rate=${sampleRate} ch=${channels}`)

    await this.ensureAudioModeConfigured()
    await this.prewarmAudioRouteIfCold()

    if (stopOtherAudio) {
      if (this.currentPlayback && !this.currentPlayback.completed) {
        console.log("AUDIO: Interrupting current playback for new stream")
        this.interruptCurrentPlayback(true)
      }
      await this.abortAllStreams(streamId)
    }

    await BluetoothSdk.pcmStreamOpen(streamId, sampleRate, channels, Math.max(0, Math.min(1, volume)))
    this.releaseTailUplinkSuppressions()

    const stream: StreamState = {
      streamId,
      appId,
      startTime: Date.now(),
      ended: false,
      onEnded: request.onEnded,
    }
    this.streams.set(streamId, stream)
    this.markAudioRouteWarm()

    // Cancel any pending "stopped" notification and mark our app as playing
    // audio. PCM streams intentionally do not suppress cloud STT.
    if (this.audioStopDebounceTimer !== null) {
      BgTimer.clearTimeout(this.audioStopDebounceTimer)
      this.audioStopDebounceTimer = null
    }
    BluetoothSdk.setOwnAppAudioPlaying(true).catch((e) => {
      console.warn("AUDIO: Failed to notify native of stream audio start:", e)
    })

    // Guarded against the stream ending mid-read, same as the play() path.
    void this.ensureGlassesMediaVolumeForA2dpStream(stream)
  }

  /**
   * Append base64 PCM to an open stream. Resolves with the host-side backlog
   * in ms; the native write blocks while the backlog is above the
   * backpressure ceiling, so awaited writes self-throttle to realtime.
   */
  public async writeStreamChunk(streamId: string, base64: string): Promise<{bufferedMs: number}> {
    const stream = this.streams.get(streamId)
    if (!stream || stream.ended) {
      throw new Error(`stream ${streamId} is not open`)
    }
    try {
      return await BluetoothSdk.pcmStreamWrite(streamId, base64)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.endStream(stream, false, message, Date.now() - stream.startTime)
      throw error
    }
  }

  /** Drain the backlog, then finish. Resolves with the total played duration. */
  public async closeStream(streamId: string): Promise<{durationMs?: number}> {
    const stream = this.streams.get(streamId)
    if (!stream || stream.ended) {
      throw new Error(`stream ${streamId} is not open`)
    }
    try {
      const result = await BluetoothSdk.pcmStreamClose(streamId)
      this.endStream(stream, true, null, result?.durationMs ?? Date.now() - stream.startTime)
      return result ?? {}
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.endStream(stream, false, message, Date.now() - stream.startTime)
      throw error
    }
  }

  /** Stop immediately, dropping the backlog. Safe on unknown/ended ids. */
  public async abortStream(streamId: string): Promise<void> {
    const stream = this.streams.get(streamId)
    await BluetoothSdk.pcmStreamAbort(streamId).catch((e) => {
      console.warn(`AUDIO: Stream abort ${streamId} native call failed:`, e)
    })
    if (stream) {
      this.endStream(stream, true, null, Date.now() - stream.startTime)
    }
  }

  /** Abort every active stream (optionally sparing one about to replace them). */
  private async abortAllStreams(exceptStreamId?: string): Promise<void> {
    const streamIds = [...this.streams.values()]
      .filter((stream) => stream.streamId !== exceptStreamId)
      .map((stream) => stream.streamId)
    await Promise.all(streamIds.map((streamId) => this.abortStream(streamId)))
  }

  /** Terminal bookkeeping for a stream: dedup, unregister, notify. */
  private endStream(stream: StreamState, success: boolean, error: string | null, durationMs: number | null): void {
    if (stream.ended) return
    stream.ended = true
    this.streams.delete(stream.streamId)
    this.markAudioRouteWarm()
    // Only signal "audio stopped" when nothing else is making noise.
    if (this.streams.size === 0 && (!this.currentPlayback || this.currentPlayback.completed)) {
      this.notifyAudioStopDebounced()
      void this.restoreGlassesMediaVolume()
    }
    stream.onEnded(stream.streamId, success, error, durationMs)
  }

  /** Stream twin of ensureGlassesMediaVolumeForA2dp, guarded by stream.ended. */
  private async ensureGlassesMediaVolumeForA2dpStream(stream: StreamState): Promise<void> {
    if (this.glassesVolumeRestoreLevel !== null) return
    try {
      const raw = await this.getGlassesMediaVolumeWithTiming()
      const level = Number(raw.level)
      if (!Number.isFinite(level) || level > AudioPlaybackService.GLASSES_VOLUME_LOW_THRESHOLD) return
      if (stream.ended) return
      console.log(`AUDIO: Raising glasses media volume for stream (was ${level})`)
      await this.setGlassesMediaVolumeWithTiming(AudioPlaybackService.GLASSES_VOLUME_FLOOR)
      if (!stream.ended) {
        this.glassesVolumeRestoreLevel = level
      } else {
        await this.setGlassesMediaVolumeWithTiming(level)
      }
    } catch (e) {
      console.warn("AUDIO: Skipping glasses volume bump for stream:", e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * Stop playback for a specific app.
   * If appId is not provided, stops all playback.
   */
  public async stopForApp(appId?: string): Promise<void> {
    // Abort this app's live PCM streams too (miniapp stop/disconnect path).
    const streamIds = [...this.streams.values()]
      .filter((stream) => !appId || stream.appId === appId)
      .map((stream) => stream.streamId)
    await Promise.all(streamIds.map((streamId) => this.abortStream(streamId)))

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
    await this.abortAllStreams()
    if (this.currentPlayback && !this.currentPlayback.completed) {
      console.log("AUDIO: Stopping all playback")
      this.interruptCurrentPlayback()
    }
  }

  /**
   * Check if audio is currently playing
   */
  public isPlaying(): boolean {
    return (this.currentPlayback !== null && !this.currentPlayback.completed) || this.streams.size > 0
  }

  /**
   * Get current playback app IDs (all active)
   */
  public getActiveAppIds(): string[] {
    const appIds = new Set<string>()
    if (this.currentPlayback && !this.currentPlayback.completed && this.currentPlayback.appId) {
      appIds.add(this.currentPlayback.appId)
    }
    for (const stream of this.streams.values()) appIds.add(stream.appId)
    return [...appIds]
  }

  /**
   * Get number of active playbacks
   */
  public getActiveCount(): number {
    return (this.currentPlayback && !this.currentPlayback.completed ? 1 : 0) + this.streams.size
  }

  /**
   * Release the player entirely (call when app is shutting down)
   */
  public release(): void {
    void this.abortAllStreams()
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
      this.loadedPlayback = null
    }
  }
}

const audioPlaybackService = AudioPlaybackService.getInstance()
export default audioPlaybackService
