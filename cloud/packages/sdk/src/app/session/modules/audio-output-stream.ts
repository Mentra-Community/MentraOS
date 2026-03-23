/**
 * AudioOutputStream — streams audio from an SDK app to the phone via the cloud relay.
 *
 * The developer writes MP3 bytes (or PCM that the SDK encodes to MP3) into this
 * stream. Each write sends a WS binary frame to the cloud:
 *
 *   [36 bytes: streamId UUID as ASCII] [N bytes: audio data]
 *
 * The cloud pipes those bytes into an HTTP chunked response that the phone's
 * ExoPlayer/AVPlayer plays like internet radio. Zero transcoding on the cloud.
 *
 * Lifecycle:
 *   const output = await session.audio.createOutputStream({ format: "mp3" })
 *   output.write(mp3Chunk)   // as many times as needed
 *   output.end()             // graceful close — phone finishes buffered audio
 *   output.flush()           // interrupt — discard everything, silence immediately
 *
 * See: cloud/issues/041-sdk-audio-output-streaming/
 */

import {EventEmitter} from "events"
import type {Logger} from "pino"
import {AppToCloudMessageType} from "../../../types/message-types"

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AudioOutputStreamOptions {
  /**
   * Format of the audio being written.
   *
   * - "mp3": You're writing MP3 bytes directly (ElevenLabs, OpenAI TTS, Cartesia, etc.)
   *          The SDK passes them straight through — zero encoding overhead.
   *
   * - "pcm16": You're writing raw 16-bit signed PCM samples (Gemini Live, OpenAI Realtime).
   *            The SDK will encode to MP3 before sending. Requires sampleRate and channels.
   */
  format?: "mp3" | "pcm16"

  /** PCM sample rate in Hz (required when format is "pcm16"). Default: 24000 */
  sampleRate?: number

  /** Number of audio channels (required when format is "pcm16"). Default: 1 (mono) */
  channels?: number

  /** MP3 bitrate in kbps for PCM encoding. Default: 128 */
  bitrate?: number

  /**
   * Volume level 0.0–1.0 for playback on the phone. Default: 1.0
   */
  volume?: number

  /**
   * Track ID for playback (0=speaker, 1=app_audio, 2=tts). Default: 1
   */
  trackId?: number

  /**
   * Whether starting this stream should stop other audio. Default: true
   */
  stopOtherAudio?: boolean
}

export type AudioOutputStreamState = "created" | "streaming" | "ending" | "ended" | "error"

// ─── Constants ───────────────────────────────────────────────────────────────

/** How long (ms) to wait for the cloud to respond with AUDIO_STREAM_READY */
const READY_TIMEOUT_MS = 10_000

/** UUID length in ASCII bytes */
const STREAM_ID_LENGTH = 36

// ─── Main Class ──────────────────────────────────────────────────────────────

export class AudioOutputStream extends EventEmitter {
  public readonly streamId: string
  public streamUrl: string | null = null

  private _state: AudioOutputStreamState = "created"
  private session: any // AppSession — typed as any to avoid circular imports
  private logger: Logger
  private options: Required<
    Pick<
      AudioOutputStreamOptions,
      "format" | "sampleRate" | "channels" | "bitrate" | "volume" | "trackId" | "stopOtherAudio"
    >
  >
  private encoder: Mp3Encoder | null = null
  private streamIdBytes: Uint8Array

  constructor(streamId: string, session: any, logger: Logger, opts: AudioOutputStreamOptions = {}) {
    super()
    this.streamId = streamId
    this.session = session
    this.logger = logger.child({module: "AudioOutputStream", streamId})

    this.options = {
      format: opts.format ?? "mp3",
      sampleRate: opts.sampleRate ?? 24000,
      channels: opts.channels ?? 1,
      bitrate: opts.bitrate ?? 128,
      volume: opts.volume ?? 1.0,
      trackId: opts.trackId ?? 1,
      stopOtherAudio: opts.stopOtherAudio ?? true,
    }

    // Pre-encode the streamId as ASCII bytes (reused on every write)
    this.streamIdBytes = new TextEncoder().encode(this.streamId)
  }

  /** Current state of the stream */
  get state(): AudioOutputStreamState {
    return this._state
  }

  /**
   * Initialize the stream — sends AUDIO_STREAM_START to the cloud and waits
   * for AUDIO_STREAM_READY with the relay URL. Then tells the phone to play it.
   *
   * Called internally by `session.audio.createOutputStream()`.
   * Do NOT call this directly — use `createOutputStream()` instead.
   *
   * @internal
   */
  async open(): Promise<void> {
    if (this._state !== "created") {
      throw new Error(`Cannot open stream in state "${this._state}"`)
    }

    // If PCM format, initialize the MP3 encoder
    if (this.options.format === "pcm16") {
      this.encoder = createMp3Encoder(this.options.channels, this.options.sampleRate, this.options.bitrate)
    }

    // Send AUDIO_STREAM_START to the cloud
    const startMessage = {
      type: AppToCloudMessageType.AUDIO_STREAM_START,
      packageName: this.session.getPackageName(),
      sessionId: this.session.getSessionId(),
      streamId: this.streamId,
      contentType: "audio/mpeg",
      timestamp: new Date(),
    }
    this.session.sendMessage(startMessage)

    // Wait for AUDIO_STREAM_READY response
    this.streamUrl = await this.waitForReady()

    this._state = "streaming"

    // Tell the phone to play the relay URL
    // This uses the existing playAudio path — the phone doesn't know it's a stream
    const playMessage = {
      type: AppToCloudMessageType.AUDIO_PLAY_REQUEST,
      packageName: this.session.getPackageName(),
      sessionId: this.session.getSessionId(),
      requestId: `stream_${this.streamId}`,
      audioUrl: this.streamUrl,
      volume: this.options.volume,
      stopOtherAudio: this.options.stopOtherAudio,
      trackId: this.options.trackId,
      timestamp: new Date(),
    }
    this.session.sendMessage(playMessage)

    this.logger.debug({streamUrl: this.streamUrl}, "Audio output stream opened")
  }

  /**
   * Write audio data to the stream.
   *
   * - If format is "mp3", the bytes are sent directly to the cloud.
   * - If format is "pcm16", the bytes are encoded to MP3 first.
   *
   * @param data - Audio data as Buffer, Uint8Array, or ArrayBuffer
   */
  write(data: Buffer | Uint8Array | ArrayBuffer): void {
    if (this._state !== "streaming") {
      this.logger.debug({state: this._state}, "Write called on non-streaming output, ignoring")
      return
    }

    let mp3Data: Uint8Array

    if (this.options.format === "pcm16" && this.encoder) {
      // Encode PCM → MP3
      const pcm = toInt16Array(data)
      const encoded = this.encoder.encodeBuffer(pcm)
      if (encoded.length === 0) return // Encoder is buffering, no complete frame yet
      mp3Data = new Uint8Array(encoded)
    } else {
      // MP3 pass-through
      mp3Data = toUint8Array(data)
    }

    if (mp3Data.length === 0) return

    // Build the binary frame: [36 bytes streamId] [N bytes audio]
    this.sendBinaryFrame(mp3Data)
  }

  /**
   * End the stream gracefully.
   *
   * If using PCM encoding, flushes any remaining encoder buffer first.
   * The phone will finish playing any buffered audio, then stop.
   */
  async end(): Promise<void> {
    if (this._state !== "streaming") return
    this._state = "ending"

    // Flush the MP3 encoder if we have one
    if (this.encoder) {
      const flushed = this.encoder.flush()
      if (flushed.length > 0) {
        this.sendBinaryFrame(new Uint8Array(flushed))
      }
      this.encoder = null
    }

    // Tell the cloud to close the relay
    const endMessage = {
      type: AppToCloudMessageType.AUDIO_STREAM_END,
      packageName: this.session.getPackageName(),
      sessionId: this.session.getSessionId(),
      streamId: this.streamId,
      timestamp: new Date(),
    }
    this.session.sendMessage(endMessage)

    this._state = "ended"
    this.emit("close")
    this.logger.debug("Audio output stream ended")
  }

  /**
   * Flush/interrupt — discard all buffered audio and stop playback immediately.
   *
   * Use this when the user starts talking and you want to silence the AI response.
   */
  async flush(): Promise<void> {
    if (this._state !== "streaming") return
    this._state = "ending"

    // Discard encoder state
    this.encoder = null

    // End the stream on the cloud side (relay closes → HTTP response ends → ExoPlayer stops)
    const endMessage = {
      type: AppToCloudMessageType.AUDIO_STREAM_END,
      packageName: this.session.getPackageName(),
      sessionId: this.session.getSessionId(),
      streamId: this.streamId,
      timestamp: new Date(),
    }
    this.session.sendMessage(endMessage)

    // Also explicitly stop audio playback on the phone
    const stopMessage = {
      type: AppToCloudMessageType.AUDIO_STOP_REQUEST,
      packageName: this.session.getPackageName(),
      sessionId: this.session.getSessionId(),
      trackId: this.options.trackId,
      timestamp: new Date(),
    }
    this.session.sendMessage(stopMessage)

    this._state = "ended"
    this.emit("close")
    this.logger.debug("Audio output stream flushed (interrupted)")
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /**
   * Send a binary frame over the WebSocket.
   * Frame format: [36 bytes streamId] [N bytes audio data]
   */
  private sendBinaryFrame(audioData: Uint8Array): void {
    const frame = new Uint8Array(STREAM_ID_LENGTH + audioData.length)
    frame.set(this.streamIdBytes, 0)
    frame.set(audioData, STREAM_ID_LENGTH)

    try {
      this.session.sendBinary(frame)
    } catch (err) {
      this.logger.debug({err}, "Failed to send binary frame")
      this._state = "error"
      this.emit("error", err)
    }
  }

  /**
   * Wait for the cloud to respond with AUDIO_STREAM_READY.
   * Returns the relay URL.
   */
  private waitForReady(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`Audio stream relay not ready after ${READY_TIMEOUT_MS}ms`))
      }, READY_TIMEOUT_MS)

      const handler = (msg: any) => {
        if (msg.type === "audio_stream_ready" && msg.streamId === this.streamId) {
          cleanup()
          resolve(msg.streamUrl)
        }
      }

      const cleanup = () => {
        clearTimeout(timeout)
        this.session.events?.off?.("__raw_message", handler)
        // Also try removing from the internal listener if events.off doesn't exist
        this.session.removeInternalListener?.("audio_stream_ready", handler)
      }

      // Listen for the AUDIO_STREAM_READY response.
      // The AppSession handleMessage method will need to emit this.
      // We register on a special internal channel that gets raw cloud messages.
      if (this.session._audioStreamReadyHandlers) {
        this.session._audioStreamReadyHandlers.set(this.streamId, handler)
      }
    })
  }
}

// ─── MP3 Encoder Wrapper ─────────────────────────────────────────────────────

/**
 * Minimal interface for an MP3 encoder (compatible with lamejs).
 */
interface Mp3Encoder {
  encodeBuffer(samples: Int16Array): Int32Array | Uint8Array
  flush(): Int32Array | Uint8Array
}

/**
 * Create an MP3 encoder for PCM→MP3 conversion.
 * Used by Gemini Live / OpenAI Realtime which output raw PCM.
 * lamejs is a regular SDK dependency — always available.
 *
 * lamejs has broken CJS modules — individual source files reference globals
 * (MPEGMode, Lame, BitStream, etc.) that are only defined when loaded via
 * the concatenated lame.all.js bundle. Bun resolves to src/js/index.js
 * which doesn't set these globals. We inject them manually before constructing.
 */
function createMp3Encoder(channels: number, sampleRate: number, bitrate: number): Mp3Encoder {
  // Inject the globals that lamejs's broken CJS modules expect
  ;(globalThis as any).MPEGMode ??= require("lamejs/src/js/MPEGMode.js")
  ;(globalThis as any).Lame ??= require("lamejs/src/js/Lame.js")
  ;(globalThis as any).BitStream ??= require("lamejs/src/js/BitStream.js")

  const lamejs = require("lamejs")
  const Encoder = lamejs.Mp3Encoder ?? lamejs.default?.Mp3Encoder
  return new Encoder(channels, sampleRate, bitrate) as Mp3Encoder
}

// ─── Buffer Helpers ──────────────────────────────────────────────────────────

function toUint8Array(data: Buffer | Uint8Array | ArrayBuffer): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (data instanceof Uint8Array) return data
  // Buffer fallback — Buffer extends Uint8Array so this branch is rarely hit,
  // but keeps the compiler happy when the type is narrowed to `never`.
  const buf = data as unknown as {buffer: ArrayBuffer; byteOffset: number; byteLength: number}
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

function toInt16Array(data: Buffer | Uint8Array | ArrayBuffer): Int16Array {
  if (data instanceof Int16Array) return data
  const bytes = toUint8Array(data)
  // PCM16 is little-endian 16-bit signed integers
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
}
