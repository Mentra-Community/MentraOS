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
 *   speaker.createStream(opts) — open a live PCM output stream (16-bit LE).
 *                                Returns a SpeakerStreamWriter: write() PCM
 *                                chunks as they arrive (e.g. from a WebSocket
 *                                in the background), close() to drain, abort()
 *                                to drop. write() resolves with {bufferedMs}
 *                                so producers can throttle.
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
import {bytesToBase64, toUint8Array} from "./base64"
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
   * Normalize display-oriented markup and symbols into natural spoken words.
   * Defaults to true. Set false when exact characters must reach the TTS engine.
   */
  enableSanitization?: boolean
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

// ── live PCM output stream ───────────────────────────────────────────────────

/** Sample rates the native chunk player accepts. */
export type SpeakerStreamSampleRate = 16000 | 24000 | 48000

export interface SpeakerStreamOptions {
  /** PCM sample rate in Hz. Default 16000. */
  sampleRate?: SpeakerStreamSampleRate
  /** Channel count. v1 is mono only. Default 1. */
  channels?: 1
  /** Playback volume 0..1. Default 1. */
  volume?: number
  /** Stop any other audio this miniapp is playing first. Default true. */
  stopOtherAudio?: boolean
}

export interface SpeakerStreamWriteResult {
  /** Milliseconds of audio queued host-side but not yet played. */
  bufferedMs: number
}

/** Raw bytes per bridge write. PCM chunks are small; keep messages snappy. */
export const SPEAKER_WRITE_CHUNK_BYTES = 256 * 1024
// Every non-final base64 slice must decode to complete 16-bit samples. Six
// raw bytes map to eight base64 chars, preserving both base64 and PCM framing.
const SPEAKER_WRITE_CHUNK_B64 = Math.floor(SPEAKER_WRITE_CHUNK_BYTES / 6) * 8

/**
 * Soft backpressure ceiling. When the host reports more than this buffered,
 * it holds the WRITE reply until the buffer drains below it, so a producer
 * that awaits each write self-throttles to realtime.
 */
export const SPEAKER_STREAM_MAX_BUFFERED_MS = 2000

/**
 * Live PCM writer returned by `speaker.createStream()`. 16-bit little-endian
 * PCM only — decode compressed formats (MP3/Opus) server-side before sending.
 *
 * Call `write()` as chunks arrive (each is auto-split into bridge-safe
 * messages), then `close()` to drain and finish, or `abort()` to drop
 * immediately. Shaped like BlobWriter so the two stream APIs feel the same.
 */
export class SpeakerStreamWriter {
  private settled = false
  private writeChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly session: MiniappSession,
    readonly streamId: string,
  ) {}

  /**
   * Append raw PCM bytes (16-bit LE). Auto-chunked. Resolves with the host's
   * buffered-ms after the last chunk. The host holds the reply while its
   * buffer is above the backpressure ceiling, so a producer that awaits each
   * write self-throttles to realtime.
   */
  async write(chunk: Uint8Array | ArrayBuffer): Promise<SpeakerStreamWriteResult> {
    this.assertOpen()
    const bytes = toUint8Array(chunk)
    if (bytes.byteLength === 0) throw new Error("PCM chunk cannot be empty")
    if (bytes.byteLength % 2 !== 0) throw new Error("PCM chunk must contain complete 16-bit samples")
    return this.enqueueWrite(async () => {
      let last: SpeakerStreamWriteResult = {bufferedMs: 0}
      for (let off = 0; off < bytes.length; off += SPEAKER_WRITE_CHUNK_BYTES) {
        last = await this.send(bytesToBase64(bytes.subarray(off, off + SPEAKER_WRITE_CHUNK_BYTES)))
      }
      return last
    })
  }

  /** Append already-base64-encoded PCM bytes (e.g. relayed straight off a WS frame). */
  async writeBase64(b64: string): Promise<SpeakerStreamWriteResult> {
    this.assertOpen()
    if (b64.length === 0 || b64.length % 4 !== 0) throw new Error("PCM base64 must be non-empty and padded")
    const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0
    const decodedBytes = (b64.length / 4) * 3 - padding
    if (decodedBytes % 2 !== 0) throw new Error("PCM base64 must contain complete 16-bit samples")
    return this.enqueueWrite(async () => {
      let last: SpeakerStreamWriteResult = {bufferedMs: 0}
      // Slice on 4-char boundaries so each chunk is whole base64 groups.
      for (let off = 0; off < b64.length; off += SPEAKER_WRITE_CHUNK_B64) {
        last = await this.send(b64.slice(off, off + SPEAKER_WRITE_CHUNK_B64))
      }
      return last
    })
  }

  /** Drain the remaining buffer and finish. Resolves when playback has ended. */
  async close(): Promise<{durationMs?: number}> {
    this.assertOpen()
    this.settled = true
    await this.writeChain
    // Draining takes as long as the buffered audio — opt out of the default
    // request timeout like play()/speak() do.
    const res = await this.session.sendRequest<{durationMs?: number} | null>(
      {type: MiniappRequestType.SPEAKER_STREAM_CLOSE, streamId: this.streamId},
      {timeoutMs: 0},
    )
    return res ?? {}
  }

  /** Stop immediately and drop any buffered audio. Idempotent. */
  async abort(): Promise<void> {
    if (this.settled) return
    this.settled = true
    await this.session.sendRequest<void>({
      type: MiniappRequestType.SPEAKER_STREAM_ABORT,
      streamId: this.streamId,
    })
  }

  private assertOpen(): void {
    if (this.settled) throw new Error("SpeakerStreamWriter is already closed/aborted")
  }

  private async send(base64: string): Promise<SpeakerStreamWriteResult> {
    const res = await this.session.sendRequest<SpeakerStreamWriteResult | null>({
      type: MiniappRequestType.SPEAKER_STREAM_WRITE,
      streamId: this.streamId,
      base64,
    })
    return res ?? {bufferedMs: 0}
  }

  /** Preserve PCM ordering even when a producer issues overlapping writes. */
  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(operation)
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

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
  async speak(text: string, options?: SpeakOptions): Promise<SpeakResult>
  async speak(sentences: string[], options?: SpeakOptions): Promise<SpeakResult>
  async speak(text: string | string[], options: SpeakOptions = {}): Promise<SpeakResult> {
    const normalized = Array.isArray(text) ? text.map((sentence) => sentence.trim()).filter(Boolean) : text.trim()
    if ((Array.isArray(normalized) && normalized.length === 0) || normalized === "") {
      throw {code: MiniappErrorCode.INTERNAL, message: "speak requires at least one non-empty sentence"}
    }
    try {
      // Like play(): resolves only when TTS playback completes, so opt out of the
      // default request timeout (long text can outlast it). Settled by the host
      // result, a stop(), or disconnect.
      const result = await this.session.sendRequest<SpeakResult | null>(
        {
          type: MiniappRequestType.SPEAK,
          text: normalized,
          voice_id: options.voice_id,
          voice_settings: options.voice_settings,
          volume: options.volume,
          stopOtherAudio: options.stopOtherAudio ?? false,
          enableSanitization: options.enableSanitization ?? true,
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
   * Open a live PCM output stream (16-bit LE) to the phone's audio playback
   * service. Use from the background to play audio that arrives in chunks
   * (e.g. live meeting audio over a WebSocket) with low latency — unlike
   * `play()`, nothing has to be a file or URL first.
   *
   * One stream per miniapp: opening a second closes the first. Rejects with
   * `NOT_IMPLEMENTED` on hosts that predate streaming. Miniapps that depend on
   * this API must declare `minHostVersion: "2.13.0"` or newer.
   */
  async createStream(options: SpeakerStreamOptions = {}): Promise<SpeakerStreamWriter> {
    if (
      options.volume !== undefined &&
      (!Number.isFinite(options.volume) || options.volume < 0 || options.volume > 1)
    ) {
      throw new RangeError("speaker stream volume must be between 0 and 1")
    }
    const res = await this.session.sendRequest<{streamId: string}>({
      type: MiniappRequestType.SPEAKER_STREAM_OPEN,
      sampleRate: options.sampleRate ?? 16000,
      channels: options.channels ?? 1,
      volume: options.volume,
      stopOtherAudio: options.stopOtherAudio ?? true,
    })
    return new SpeakerStreamWriter(this.session, res.streamId)
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
