/**
 * 🔊 SpeakerManager — Audio Output Control
 *
 * v3 manager that wraps the existing AudioManager output functionality.
 * Handles audio playback, text-to-speech, and real-time audio streaming
 * to the user's glasses speaker.
 *
 * Wire message formats are identical to v2 so the cloud receives the
 * same AUDIO_PLAY_REQUEST, AUDIO_STOP_REQUEST, AUDIO_STREAM_START,
 * AUDIO_STREAM_END, and binary frame protocol.
 *
 * @example
 * ```ts
 * const speaker = new SpeakerManager(deps);
 *
 * // Play a URL
 * const result = await speaker.play({ url: "https://example.com/sound.mp3" });
 *
 * // Text-to-speech
 * await speaker.speak("Hello, world!", { volume: 0.8 });
 *
 * // Real-time streaming
 * const stream = await speaker.createStream({ format: "mp3" });
 * stream.write(mp3Chunk);
 * await stream.end();
 * ```
 */

import { AppToCloudMessageType, CloudToAppMessageType } from "../../types/message-types";

// ─── Dependencies ────────────────────────────────────────────────────────────

/**
 * Shared dependency bag injected by MentraSession.
 * Keeps managers decoupled from the session implementation.
 */
export interface ManagerDeps {
  /** DataStreamRouter — register for DATA_STREAM messages by streamType key. */
  router: {
    on(key: string, handler: (streamType: string, data: any, message: any) => void): () => void;
  };
  /** MessageHandlerRegistry — register for top-level message types. */
  messageHandlers: {
    register(type: string, handler: (msg: any) => void): () => void;
  };
  addSubscription: (stream: string) => void;
  removeSubscription: (stream: string) => void;
  sendMessage: (message: any) => void;
  sendBinary: (data: ArrayBuffer | Uint8Array) => void;
  logger: {
    debug(...args: any[]): void;
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
  };
  getPackageName: () => string;
  getSessionId: () => string;
}

// ─── Public Types ────────────────────────────────────────────────────────────

/** Audio track identifier. Multiple tracks can play simultaneously (mixing). */
export type TrackId = 0 | 1 | 2;

/**
 * Options for playing an audio file from a URL.
 */
export interface PlayOptions {
  /** URL of the audio file to play */
  url: string;
  /** Volume level 0.0–1.0. Default: 1.0 */
  volume?: number;
  /**
   * Track ID for playback.
   * - 0: speaker (default audio playback)
   * - 1: app_audio (app-specific audio)
   * - 2: tts (text-to-speech audio)
   * Default: 0
   */
  trackId?: TrackId;
  /** Whether starting playback should stop other audio. Default: false */
  stopOtherAudio?: boolean;
}

/**
 * Result returned when audio playback completes.
 */
export interface PlayResult {
  /** Duration of the audio in milliseconds (when available) */
  duration: number;
}

/**
 * Options for text-to-speech playback.
 */
export interface SpeakOptions {
  /** ElevenLabs voice ID (optional — server picks a default) */
  voiceId?: string;
  /** ElevenLabs model ID (optional — defaults to eleven_flash_v2_5) */
  modelId?: string;
  /** Fine-grained voice settings */
  voiceSettings?: {
    stability?: number;
    similarityBoost?: number;
    style?: number;
    speed?: number;
  };
  /** Volume level 0.0–1.0. Default: 1.0 */
  volume?: number;
  /**
   * Track ID for playback. Default: 2 (tts)
   */
  trackId?: TrackId;
  /** Whether starting playback should stop other audio. Default: false */
  stopOtherAudio?: boolean;
}

/**
 * Options for creating a real-time audio output stream.
 */
export interface StreamOptions {
  /**
   * Format of the audio being written.
   * - "mp3": MP3 bytes passed through directly (ElevenLabs, OpenAI TTS, etc.)
   * - "pcm16": Raw 16-bit signed PCM samples (SDK encodes to MP3 before sending)
   * Default: "mp3"
   */
  format?: "mp3" | "pcm16";
  /** PCM sample rate in Hz (required when format is "pcm16"). Default: 24000 */
  sampleRate?: number;
  /** Number of audio channels. Default: 1 (mono) */
  channels?: 1 | 2;
  /** MP3 bitrate in kbps for PCM encoding. Default: 128 */
  bitrate?: number;
  /** Volume level 0.0–1.0. Default: 1.0 */
  volume?: number;
  /**
   * Track ID for playback. Default: 1 (app_audio)
   */
  trackId?: TrackId;
  /** Whether starting the stream should stop other audio. Default: true */
  stopOtherAudio?: boolean;
}

/** Lifecycle state of an AudioOutputStream */
export type AudioOutputStreamState = "created" | "streaming" | "ending" | "ended" | "error";

/**
 * A real-time audio output stream.
 *
 * Audio data is sent as binary WebSocket frames with the protocol:
 *   [36 bytes: streamId UUID as ASCII] [N bytes: audio data]
 *
 * The cloud pipes those bytes into an HTTP chunked response that the
 * phone's media player consumes like internet radio.
 */
export interface AudioOutputStream {
  /** Unique stream identifier (UUID) */
  readonly id: string;
  /** Current lifecycle state */
  readonly state: AudioOutputStreamState;
  /** Write audio data to the stream */
  write(chunk: Uint8Array): void;
  /** Gracefully end the stream — phone finishes buffered audio */
  end(): Promise<void>;
  /** Flush/interrupt — discard buffered audio, silence immediately */
  flush(): void;
  /** Register a callback for state changes */
  onStateChange(handler: (state: AudioOutputStreamState) => void): void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** UUID length in ASCII bytes — used as the binary frame header */
const STREAM_ID_LENGTH = 36;

/** How long to wait for AUDIO_STREAM_READY from the cloud (ms) */
const STREAM_READY_TIMEOUT_MS = 10_000;

/** How long to wait for AUDIO_PLAY_RESPONSE from the cloud (ms) */
const PLAY_RESPONSE_TIMEOUT_MS = 60_000;

// ─── AudioOutputStreamImpl ──────────────────────────────────────────────────

/**
 * Internal implementation of the AudioOutputStream interface.
 * Manages the binary frame protocol and lifecycle messages.
 */
/**
 * Minimal interface for an MP3 encoder (compatible with lamejs).
 */
interface Mp3Encoder {
  encodeBuffer(samples: Int16Array): Int32Array | Uint8Array;
  flush(): Int32Array | Uint8Array;
}

/**
 * Create an MP3 encoder for PCM to MP3 conversion.
 * Used by Gemini Live / OpenAI Realtime which output raw PCM.
 * lamejs is a regular SDK dependency.
 *
 * lamejs has broken CJS modules that reference globals (MPEGMode, Lame,
 * BitStream) only defined when loaded via the concatenated bundle. Bun
 * resolves to src/js/index.js which skips them. We inject manually.
 */
function createMp3Encoder(channels: number, sampleRate: number, bitrate: number): Mp3Encoder {
  (globalThis as any).MPEGMode ??= require("lamejs/src/js/MPEGMode.js");
  (globalThis as any).Lame ??= require("lamejs/src/js/Lame.js");
  (globalThis as any).BitStream ??= require("lamejs/src/js/BitStream.js");

  const lamejs = require("lamejs");
  const Encoder = lamejs.Mp3Encoder ?? lamejs.default?.Mp3Encoder;
  return new Encoder(channels, sampleRate, bitrate) as Mp3Encoder;
}

/** Convert any typed array or ArrayBuffer to Int16Array for PCM encoding. */
function toInt16Array(data: Uint8Array | ArrayBuffer): Int16Array {
  if (data instanceof Int16Array) return data;
  const buffer = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return new Int16Array(buffer);
}

class AudioOutputStreamImpl implements AudioOutputStream {
  public readonly id: string;

  private _state: AudioOutputStreamState = "created";
  private readonly deps: ManagerDeps;
  private readonly streamIdBytes: Uint8Array;
  private readonly options: Required<
    Pick<StreamOptions, "format" | "sampleRate" | "channels" | "bitrate" | "volume" | "trackId" | "stopOtherAudio">
  >;
  private stateChangeHandlers: Array<(state: AudioOutputStreamState) => void> = [];
  private streamUrl: string | null = null;

  /** MP3 encoder for PCM16 format. Null when format is "mp3" (pass-through). */
  private encoder: Mp3Encoder | null = null;

  constructor(streamId: string, deps: ManagerDeps, opts: StreamOptions = {}) {
    this.id = streamId;
    this.deps = deps;

    this.options = {
      format: opts.format ?? "mp3",
      sampleRate: opts.sampleRate ?? 24000,
      channels: opts.channels ?? 1,
      bitrate: opts.bitrate ?? 128,
      volume: opts.volume ?? 1.0,
      trackId: opts.trackId ?? 1,
      stopOtherAudio: opts.stopOtherAudio ?? true,
    };

    // Pre-encode the streamId as ASCII bytes (reused on every write)
    this.streamIdBytes = new TextEncoder().encode(this.id);
  }

  get state(): AudioOutputStreamState {
    return this._state;
  }

  /**
   * Initialize the stream — sends AUDIO_STREAM_START and waits for the
   * relay URL from the cloud, then tells the phone to play it.
   * @internal Called by SpeakerManager.createStream()
   */
  async open(): Promise<void> {
    if (this._state !== "created") {
      throw new Error(`Cannot open stream in state "${this._state}"`);
    }

    // Initialize MP3 encoder for PCM16 format. The phone expects MP3 bytes,
    // so raw PCM must be encoded before sending over the wire.
    if (this.options.format === "pcm16") {
      this.encoder = createMp3Encoder(this.options.channels, this.options.sampleRate, this.options.bitrate);
    }

    // Send AUDIO_STREAM_START to the cloud
    const startMessage = {
      type: AppToCloudMessageType.AUDIO_STREAM_START,
      packageName: this.deps.getPackageName(),
      sessionId: this.deps.getSessionId(),
      streamId: this.id,
      contentType: "audio/mpeg",
      timestamp: new Date(),
    };
    this.deps.sendMessage(startMessage);

    // Wait for AUDIO_STREAM_READY response with the relay URL
    this.streamUrl = await this.waitForReady();

    this.setState("streaming");

    // Tell the phone to play the relay URL using existing audio play path
    const playMessage = {
      type: AppToCloudMessageType.AUDIO_PLAY_REQUEST,
      packageName: this.deps.getPackageName(),
      sessionId: this.deps.getSessionId(),
      requestId: `stream_${this.id}`,
      audioUrl: this.streamUrl,
      volume: this.options.volume,
      stopOtherAudio: this.options.stopOtherAudio,
      trackId: this.options.trackId,
      timestamp: new Date(),
    };
    this.deps.sendMessage(playMessage);

    this.deps.logger.debug("Audio output stream opened", this.id);
  }

  write(chunk: Uint8Array): void {
    if (this._state !== "streaming") {
      this.deps.logger.debug(`Write called on non-streaming output (state=${this._state}), ignoring`);
      return;
    }

    if (chunk.length === 0) return;

    if (this.options.format === "pcm16" && this.encoder) {
      // Encode PCM to MP3 before sending. The phone expects MP3 bytes.
      const pcm = toInt16Array(chunk);
      const encoded = this.encoder.encodeBuffer(pcm);
      if (encoded.length === 0) return; // Encoder is buffering, no complete frame yet
      this.sendBinaryFrame(new Uint8Array(encoded));
    } else {
      // MP3 pass-through
      this.sendBinaryFrame(chunk);
    }
  }

  async end(): Promise<void> {
    if (this._state !== "streaming") return;
    this.setState("ending");

    // Tell the cloud to close the relay
    const endMessage = {
      type: AppToCloudMessageType.AUDIO_STREAM_END,
      packageName: this.deps.getPackageName(),
      sessionId: this.deps.getSessionId(),
      streamId: this.id,
      timestamp: new Date(),
    };
    this.deps.sendMessage(endMessage);

    this.setState("ended");
    this.deps.logger.debug("Audio output stream ended");
  }

  flush(): void {
    if (this._state !== "streaming") return;
    this.setState("ending");

    // End the stream on the cloud side
    const endMessage = {
      type: AppToCloudMessageType.AUDIO_STREAM_END,
      packageName: this.deps.getPackageName(),
      sessionId: this.deps.getSessionId(),
      streamId: this.id,
      timestamp: new Date(),
    };
    this.deps.sendMessage(endMessage);

    // Also explicitly stop audio playback on the phone
    const stopMessage = {
      type: AppToCloudMessageType.AUDIO_STOP_REQUEST,
      packageName: this.deps.getPackageName(),
      sessionId: this.deps.getSessionId(),
      trackId: this.options.trackId,
      timestamp: new Date(),
    };
    this.deps.sendMessage(stopMessage);

    this.setState("ended");
    this.deps.logger.debug("Audio output stream flushed (interrupted)");
  }

  onStateChange(handler: (state: AudioOutputStreamState) => void): void {
    this.stateChangeHandlers.push(handler);
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private setState(state: AudioOutputStreamState): void {
    this._state = state;
    for (const handler of this.stateChangeHandlers) {
      try {
        handler(state);
      } catch (err) {
        this.deps.logger.error("AudioOutputStream state change handler error:", err);
      }
    }
  }

  /**
   * Send a binary frame over the WebSocket.
   * Frame format: [36 bytes streamId ASCII] [N bytes audio data]
   */
  private sendBinaryFrame(audioData: Uint8Array): void {
    const frame = new Uint8Array(STREAM_ID_LENGTH + audioData.length);
    frame.set(this.streamIdBytes, 0);
    frame.set(audioData, STREAM_ID_LENGTH);

    try {
      this.deps.sendBinary(frame);
    } catch (err) {
      this.deps.logger.error("Failed to send binary audio frame:", err);
      this.setState("error");
    }
  }

  /**
   * Wait for the cloud to respond with AUDIO_STREAM_READY.
   * Listens on the MessageHandlerRegistry for the top-level response message type.
   */
  private waitForReady(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        unregister();
        reject(new Error(`Audio stream relay not ready after ${STREAM_READY_TIMEOUT_MS}ms`));
      }, STREAM_READY_TIMEOUT_MS);

      // Register on the MessageHandlerRegistry for AUDIO_STREAM_READY.
      // This is a top-level message type, not a DATA_STREAM streamType,
      // so it must go through messageHandlers (not the DataStreamRouter).
      const unregister = this.deps.messageHandlers.register(
        CloudToAppMessageType.AUDIO_STREAM_READY,
        (message: any) => {
          if (message?.streamId === this.id) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            unregister();
            resolve(message.streamUrl);
          }
        },
      );
    });
  }
}

// ─── SpeakerManager ─────────────────────────────────────────────────────────

/**
 * Controls audio output on the user's glasses speaker.
 *
 * Provides methods for:
 * - 🎵 Playing audio files from URLs
 * - ⏹️ Stopping audio playback
 * - 🗣️ Text-to-speech via ElevenLabs
 * - 🎙️ Real-time audio streaming
 *
 * All messages use the same wire format as v2 AudioManager — the cloud
 * and phone receive identical AUDIO_PLAY_REQUEST / AUDIO_STOP_REQUEST /
 * AUDIO_STREAM_* messages.
 */
export class SpeakerManager {
  private readonly deps: ManagerDeps;

  /**
   * Map of pending play requests awaiting AUDIO_PLAY_RESPONSE.
   * Key: requestId, Value: promise resolve/reject pair.
   */
  private pendingRequests = new Map<
    string,
    {
      resolve: (result: PlayResult) => void;
      reject: (reason: any) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /** Currently active output stream (at most one at a time) */
  private activeStream: AudioOutputStreamImpl | null = null;

  /** Cached permission state */
  private _hasPermission = true;

  /** Cleanup function for the AUDIO_PLAY_RESPONSE message handler registration */
  private responseHandlerCleanup: (() => void) | null = null;

  constructor(deps: ManagerDeps) {
    this.deps = deps;

    // Register handler for AUDIO_PLAY_RESPONSE messages from the cloud.
    // This is a top-level message type, so it goes through the
    // MessageHandlerRegistry (not the DataStreamRouter).
    this.responseHandlerCleanup = this.deps.messageHandlers.register(
      CloudToAppMessageType.AUDIO_PLAY_RESPONSE,
      (message: any) => {
        this.handleAudioPlayResponse(message);
      },
    );
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Whether the app has speaker permission.
   * Updated when the cloud sends permission state changes.
   */
  get hasPermission(): boolean {
    return this._hasPermission;
  }

  /**
   * 🎵 Play an audio file from a URL on the glasses speaker.
   *
   * If `stopOtherAudio` is false (default), resolves immediately in
   * fire-and-forget mode so multiple tracks can play concurrently.
   * If `stopOtherAudio` is true, waits for the cloud's AUDIO_PLAY_RESPONSE.
   *
   * @param opts - Playback options (url is required)
   * @returns Promise resolving with playback result
   *
   * @example
   * ```ts
   * const result = await speaker.play({
   *   url: "https://example.com/sound.mp3",
   *   volume: 0.8,
   *   trackId: 0,
   * });
   * ```
   */
  async play(opts: PlayOptions): Promise<PlayResult> {
    if (!opts.url) {
      throw new Error("PlayOptions.url must be provided");
    }

    const requestId = `audio_req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const volume = opts.volume ?? 1.0;
    const trackId = opts.trackId ?? 0;
    const stopOtherAudio = opts.stopOtherAudio ?? false;

    // Build wire message — identical to v2 AudioPlayRequest
    const message = {
      type: AppToCloudMessageType.AUDIO_PLAY_REQUEST,
      packageName: this.deps.getPackageName(),
      sessionId: this.deps.getSessionId(),
      requestId,
      timestamp: new Date(),
      audioUrl: opts.url,
      volume,
      stopOtherAudio,
      trackId,
    };

    // Fire-and-forget for concurrent playback (stopOtherAudio=false)
    if (!stopOtherAudio) {
      this.deps.sendMessage(message);
      this.deps.logger.debug("Audio playback started in non-blocking mode", requestId);
      return { duration: 0 };
    }

    // Blocking mode — wait for AUDIO_PLAY_RESPONSE
    return new Promise<PlayResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error("Audio play request timed out"));
        this.deps.logger.warn("Audio play request timed out", requestId);
      }, PLAY_RESPONSE_TIMEOUT_MS);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      this.deps.sendMessage(message);
    });
  }

  /**
   * ⏹️ Stop audio playback on the glasses.
   *
   * @param trackId - Specific track to stop. If omitted, stops all tracks.
   *
   * @example
   * ```ts
   * // Stop all audio
   * await speaker.stop();
   *
   * // Stop only the TTS track
   * await speaker.stop(2);
   * ```
   */
  async stop(trackId?: TrackId): Promise<void> {
    const message = {
      type: AppToCloudMessageType.AUDIO_STOP_REQUEST,
      packageName: this.deps.getPackageName(),
      sessionId: this.deps.getSessionId(),
      trackId,
      timestamp: new Date(),
    };

    this.deps.sendMessage(message);

    const trackInfo = trackId !== undefined ? ` (track ${trackId})` : " (all tracks)";
    this.deps.logger.info(`Audio stop request sent${trackInfo}`);
  }

  /**
   * 🗣️ Convert text to speech and play it on the glasses speaker.
   *
   * Uses the server-side TTS endpoint which proxies to ElevenLabs.
   * The generated audio URL is then played via the standard play() path.
   *
   * @param text - Text to speak (required)
   * @param opts - TTS configuration (optional)
   * @returns Promise resolving with playback result
   *
   * @example
   * ```ts
   * await speaker.speak("Hello, world!");
   *
   * await speaker.speak("Good morning!", {
   *   voiceId: "custom_voice_id",
   *   voiceSettings: { stability: 0.5, speed: 1.2 },
   *   volume: 0.8,
   * });
   * ```
   */
  async speak(text: string, opts: SpeakOptions = {}): Promise<PlayResult> {
    if (!text) {
      throw new Error("text must be provided");
    }

    // Build TTS query parameters — identical to v2 speak() format
    const queryParams = new URLSearchParams();
    queryParams.append("text", text);

    if (opts.voiceId) {
      queryParams.append("voice_id", opts.voiceId);
    }

    if (opts.modelId) {
      queryParams.append("model_id", opts.modelId);
    }

    if (opts.voiceSettings) {
      // Map camelCase API to the snake_case the TTS endpoint expects
      const settings: Record<string, any> = {};
      if (opts.voiceSettings.stability !== undefined) settings.stability = opts.voiceSettings.stability;
      if (opts.voiceSettings.similarityBoost !== undefined)
        settings.similarity_boost = opts.voiceSettings.similarityBoost;
      if (opts.voiceSettings.style !== undefined) settings.style = opts.voiceSettings.style;
      if (opts.voiceSettings.speed !== undefined) settings.speed = opts.voiceSettings.speed;
      queryParams.append("voice_settings", JSON.stringify(settings));
    }

    // The TTS URL is constructed the same way as v2 — the cloud resolves it.
    // v2 used session.getHttpsServerUrl() but in v3 we send the query params
    // as part of the play request and let the cloud construct the final URL.
    const ttsUrl = `/api/tts?${queryParams.toString()}`;

    this.deps.logger.debug("Generating speech from text", text);

    return this.play({
      url: ttsUrl,
      volume: opts.volume,
      stopOtherAudio: opts.stopOtherAudio ?? false,
      trackId: opts.trackId ?? 2, // Default to track 2 (tts)
    });
  }

  /**
   * 🎙️ Create a real-time audio output stream.
   *
   * Opens a streaming relay on the cloud and tells the phone to play it.
   * Write audio chunks to the returned stream and they play on the glasses
   * speaker in real-time — like internet radio.
   *
   * Only one stream can be active at a time. Call `end()` or `flush()` on
   * the current stream before creating a new one.
   *
   * @param opts - Stream configuration
   * @returns The AudioOutputStream (already connected and playing)
   *
   * @example
   * ```ts
   * // MP3 pass-through (most common)
   * const stream = await speaker.createStream({ format: "mp3" });
   * elevenLabs.on("chunk", (mp3) => stream.write(mp3));
   * elevenLabs.on("end", () => stream.end());
   *
   * // Interrupt on user speech
   * mic.onVoiceActivity((vad) => {
   *   if (vad.isSpeaking) stream.flush();
   * });
   * ```
   */
  async createStream(opts: StreamOptions = {}): Promise<AudioOutputStream> {
    // Enforce one-at-a-time — callers must end/flush the current stream first
    if (this.activeStream && this.activeStream.state === "streaming") {
      const err = new Error(
        `AUDIO_STREAM_ALREADY_ACTIVE: Stream ${this.activeStream.id} is still active. ` +
          `Call end() or flush() before creating a new output stream.`,
      ) as Error & { code?: string };
      err.code = "AUDIO_STREAM_ALREADY_ACTIVE";
      this.deps.logger.warn("Refusing to create a second output stream while one is active");
      throw err;
    }

    // Generate a unique stream ID
    const streamId = crypto.randomUUID();

    const stream = new AudioOutputStreamImpl(streamId, this.deps, opts);

    // Open the stream (sends AUDIO_STREAM_START, waits for relay URL, tells phone to play)
    await stream.open();

    this.activeStream = stream;

    // Clean up reference when the stream ends
    stream.onStateChange((state) => {
      if ((state === "ended" || state === "error") && this.activeStream === stream) {
        this.activeStream = null;
      }
    });

    return stream;
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────

  /**
   * Cancel all pending requests and end any active stream.
   * Called by MentraSession during disconnect/cleanup.
   * @internal
   */
  destroy(): void {
    // Unregister the AUDIO_PLAY_RESPONSE message handler
    if (this.responseHandlerCleanup) {
      this.responseHandlerCleanup();
      this.responseHandlerCleanup = null;
    }

    // Cancel all pending play requests
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("SpeakerManager destroyed"));
      this.deps.logger.debug("Audio request cancelled during cleanup", requestId);
    }
    this.pendingRequests.clear();

    // End any active output stream
    if (this.activeStream && this.activeStream.state === "streaming") {
      this.activeStream.end().catch(() => {});
      this.activeStream = null;
    }
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  /**
   * Handle AUDIO_PLAY_RESPONSE from the cloud.
   * Resolves or rejects the corresponding pending play() promise.
   */
  private handleAudioPlayResponse(response: any): void {
    const requestId: string | undefined = response?.requestId;
    if (!requestId) return;

    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      this.deps.logger.debug("Received audio play response for unknown request", requestId);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);

    if (response.success) {
      pending.resolve({
        duration: response.duration ?? 0,
      });
      this.deps.logger.info("Audio play response received", requestId, "duration:", response.duration);
    } else {
      pending.reject(new Error(response.error || "Audio playback failed"));
      this.deps.logger.warn("Audio play failed", requestId, response.error);
    }
  }
}
