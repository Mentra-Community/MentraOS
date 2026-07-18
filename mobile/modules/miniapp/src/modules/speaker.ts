/**
 * @fileoverview SpeakerModule — phone-side audio output.
 *
 * Mirrors cloud SDK v3's SpeakerManager naming. Audio *input* (transcription,
 * audio chunks, VAD) lives on session.mic — the split is by I/O direction.
 *
 * Imperative surface:
 *   speaker.play({audioUrl})   — play an arbitrary URL via the phone's
 *                                AudioPlaybackService.
 *   speaker.speak(text)        — send a SPEAK request. Phone streams cloud
 *                                TTS when connected and falls back to local
 *                                offline TTS when cloud is unavailable.
 *                                Resolves when playback completes; rejects
 *                                with a TTS_* error code on cloud failure.
 *   speaker.stop()             — stop any audio this miniapp is playing.
 *
 * State observability:
 *   speaker.state              — current SpeakerState (sync getter).
 *   speaker.isPlaying          — true iff state === "playing".
 *   speaker.onStateChange(h)   — fires on every state transition.
 *
 * State machine (per miniapp):
 *   idle ─── speak()/play() ──► loading ──► playing ──► stopped
 *                                  │            │           │
 *                                  └── error ───┴── stop ───┘
 *
 * `error` is transient — fires once with errorCode set, then settles to
 * `stopped` so isPlaying reads false correctly.
 */

import {MiniappErrorCode, MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"
import type {UnsubscribeFn} from "./events"

export interface PlayAudioOptions {
  audioUrl: string
  volume?: number
  stopOtherAudio?: boolean
}

export interface SpeakOptions {
  voice_id?: string
  voice_settings?: Record<string, unknown>
  volume?: number
  stopOtherAudio?: boolean
  /**
   * Force this call to use on-device offline TTS, skipping cloud TTS
   * entirely — even when cloud is connected. Rejects with `TTS_LOCAL_UNAVAILABLE`
   * if the offline model isn't ready instead of falling back to cloud.
   */
  forceLocal?: boolean
}

export interface SpeakResult {
  /** True if playback completed; false if playback was interrupted. */
  completed: boolean
}

export type SpeakerState = "idle" | "loading" | "playing" | "stopped" | "error"

export interface SpeakerStateEvent {
  state: SpeakerState
  /** When state === "error", the underlying error code (TTS_*, INTERNAL). */
  errorCode?: string
  errorMessage?: string
  /** When state === "stopped", how many ms the playback ran (best-effort). */
  durationMs?: number
}

export class SpeakerModule {
  private _state: SpeakerState = "idle"
  private _lastEvent: SpeakerStateEvent = {state: "idle"}

  constructor(private readonly session: MiniappSession) {}

  /** Current speaker playback state. */
  get state(): SpeakerState {
    return this._state
  }

  /** True iff state === "playing". */
  get isPlaying(): boolean {
    return this._state === "playing"
  }

  /** Play a URL. Resolves when playback completes on the phone. */
  async play(options: PlayAudioOptions): Promise<void> {
    // Playback length is unbounded (a clip can run for minutes), and the host
    // only sends its REQUEST_RESULT when playback finishes or is interrupted, so
    // opt out of the default request timeout — otherwise a long clip would reject
    // with ACTION_TIMEOUT mid-playback. A `stop()` or disconnect still settles it.
    await this.session.sendRequest<void>(
      {
        type: MiniappRequestType.PLAY_AUDIO,
        audioUrl: options.audioUrl,
        volume: options.volume,
        stopOtherAudio: options.stopOtherAudio ?? false,
      },
      {timeoutMs: 0},
    )
  }

  /**
   * Speak text through the phone. The host streams cloud TTS when connected,
   * then falls back to local offline TTS.
   *
   * Rejects with a MiniappRequestError containing a `code` field on cloud-side
   * TTS failures: `TTS_TEXT_TOO_LONG`, `TTS_INVALID_VOICE`, `TTS_UPSTREAM_ERROR`.
   */
  async speak(text: string, options: SpeakOptions = {}): Promise<SpeakResult> {
    try {
      // Like play(): resolves only when TTS playback completes, so opt out of the
      // default request timeout (long text can outlast it). Settled by the host
      // result, a stop(), or disconnect.
      const result = await this.session.sendRequest<SpeakResult | null>(
        {
          type: MiniappRequestType.SPEAK,
          text,
          voice_id: options.voice_id,
          voice_settings: options.voice_settings,
          volume: options.volume,
          stopOtherAudio: options.stopOtherAudio ?? false,
          forceLocal: options.forceLocal ?? false,
        },
        {timeoutMs: 0},
      )
      return result ?? {completed: true}
    } catch (err) {
      // Normalize so callers can `catch (e) { if (e.code === "TTS_TEXT_TOO_LONG") ...`
      if (err && typeof err === "object" && "code" in err) {
        throw err
      }
      throw {code: MiniappErrorCode.INTERNAL, message: String(err)}
    }
  }

  /**
   * Speak multiple sentences as one continuous request.
   *
   * The host owns TTS routing and playback, so callers avoid issuing separate
   * bridge requests that could interrupt one another. The original `speak()`
   * API remains available for a single text value.
   */
  async speakSentences(sentences: string[], options: SpeakOptions = {}): Promise<SpeakResult> {
    const normalized = sentences.map((sentence) => sentence.trim()).filter(Boolean)
    if (normalized.length === 0) {
      throw {code: MiniappErrorCode.INTERNAL, message: "speakSentences requires at least one sentence"}
    }

    try {
      const result = await this.session.sendRequest<SpeakResult | null>(
        {
          type: MiniappRequestType.SPEAK_SENTENCES,
          sentences: normalized,
          voice_id: options.voice_id,
          voice_settings: options.voice_settings,
          volume: options.volume,
          stopOtherAudio: options.stopOtherAudio ?? false,
          forceLocal: options.forceLocal ?? false,
        },
        {timeoutMs: 0},
      )
      return result ?? {completed: true}
    } catch (err) {
      if (err && typeof err === "object" && "code" in err) throw err
      throw {code: MiniappErrorCode.INTERNAL, message: String(err)}
    }
  }

  /** Stop any audio this miniapp is currently playing. */
  stop(): void {
    this.session.sendOneShot({type: MiniappRequestType.STOP_AUDIO})
  }

  /**
   * Subscribe to speaker state transitions. Fires for every change. Does NOT
   * fire immediately with the current value — call `state` separately if you
   * want the seed.
   */
  onStateChange(handler: (event: SpeakerStateEvent) => void): UnsubscribeFn {
    return this.session.on("speakerState", handler)
  }

  /** @internal — applied by MiniappSession on inbound SPEAKER_STATE envelope. */
  _applyState(event: SpeakerStateEvent): void {
    // Idempotent: skip if state didn't change. Error events are transient
    // and are not deduped against the prior state — they're informational
    // and the phone immediately follows up with `stopped`.
    if (event.state === this._state && event.state !== "error") return
    this._state = event.state
    this._lastEvent = event
  }

  /** @internal — for tests. */
  _getLastEvent(): SpeakerStateEvent {
    return {...this._lastEvent}
  }
}
