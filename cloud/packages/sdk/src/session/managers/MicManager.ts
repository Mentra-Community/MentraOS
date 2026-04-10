/**
 * 🎤 MicManager — Microphone Input Control
 *
 * v3 manager that handles audio input from the user's glasses microphone.
 * Provides subscriptions for raw PCM audio chunks and voice activity
 * detection (VAD) events.
 *
 * Audio chunks arrive as binary WebSocket frames — MentraSession calls
 * `handleBinaryAudio()` when it receives a binary frame that isn't
 * destined for an output stream. VAD events arrive as JSON DATA_STREAM
 * messages routed through the DataStreamRouter.
 *
 * @example
 * ```ts
 * const mic = new MicManager(deps);
 *
 * // Listen for raw audio
 * const stopChunks = mic.onChunk((chunk) => {
 *   console.log(`Got ${chunk.data.byteLength} bytes at ${chunk.sampleRate}Hz`);
 * });
 *
 * // Listen for voice activity
 * const stopVad = mic.onVoiceActivity((vad) => {
 *   console.log(vad.isSpeaking ? "Speech started" : "Speech ended");
 * });
 *
 * // Check state
 * console.log("Speaking:", mic.isSpeaking);
 * console.log("Active:", mic.isActive);
 *
 * // Cleanup
 * mic.stop();
 * ```
 */

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

/**
 * A chunk of raw PCM audio data from the glasses microphone.
 *
 * Audio is always 16 kHz mono 16-bit signed PCM — the native format
 * of the glasses microphone hardware.
 */
export interface AudioChunk {
  /** Raw PCM audio data */
  data: ArrayBuffer;
  /** Sample rate in Hz (always 16000) */
  sampleRate: number;
  /** Number of audio channels (always 1 — mono) */
  channels: number;
  /** Timestamp when this chunk was received (ms since epoch) */
  timestamp: number;
}

/**
 * Voice activity detection event.
 *
 * Indicates whether the user is currently speaking. The glasses run
 * on-device VAD and send status updates as the speech state changes.
 */
export interface VadEvent {
  /** Whether speech is currently detected */
  isSpeaking: boolean;
  /** Timestamp when this event was received (ms since epoch) */
  timestamp: number;
}

// ─── Stream Type Constants ───────────────────────────────────────────────────

/** Stream type for audio chunk subscriptions (matches StreamType.AUDIO_CHUNK) */
const AUDIO_CHUNK_STREAM = "audio_chunk";

/** Stream type for VAD subscriptions (matches StreamType.VAD) */
const VAD_STREAM = "VAD";

// ─── MicManager ─────────────────────────────────────────────────────────────

/**
 * Manages microphone input from the user's glasses.
 *
 * Handles two types of incoming data:
 *
 * 1. **Raw PCM audio chunks** — arrive as binary WebSocket frames.
 *    MentraSession calls `handleBinaryAudio()` for each binary frame
 *    that isn't part of an output stream. Subscribers receive wrapped
 *    `AudioChunk` objects with metadata.
 *
 * 2. **Voice Activity Detection (VAD)** — arrives as JSON DATA_STREAM
 *    messages with `streamType: "VAD"`. The glasses send `status: true`
 *    when speech starts and `status: false` when it stops. The raw
 *    `status` field may be a boolean or string ("true"/"false") — this
 *    manager normalizes it to a clean boolean.
 *
 * Subscription lifecycle:
 * - `onChunk()` adds an "audio_chunk" subscription when the first handler
 *   is registered, and removes it when the last handler unsubscribes.
 * - `onVoiceActivity()` does the same for the "VAD" subscription.
 * - `stop()` removes all handlers and unsubscribes from both streams.
 */
export class MicManager {
  private readonly deps: ManagerDeps;

  /** Registered handlers for audio chunk data */
  private chunkHandlers = new Set<(chunk: AudioChunk) => void>();

  /** Registered handlers for VAD events */
  private vadHandlers = new Set<(vad: VadEvent) => void>();

  /** Cleanup function for the VAD router subscription */
  private vadRouterCleanup: (() => void) | null = null;

  /** Cached latest VAD state — true when speech is detected */
  private _isSpeaking = false;

  /** Cached permission state */
  private _hasPermission = true;

  constructor(deps: ManagerDeps) {
    this.deps = deps;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Whether speech is currently detected.
   *
   * This value is cached from the most recent VAD event. It is only
   * updated while there is at least one `onVoiceActivity` subscriber.
   *
   * @example
   * ```ts
   * if (mic.isSpeaking) {
   *   // User is talking — maybe pause TTS
   * }
   * ```
   */
  get isSpeaking(): boolean {
    return this._isSpeaking;
  }

  /**
   * Whether this app has an active `onChunk` subscription.
   *
   * Returns true when at least one audio chunk handler is registered,
   * meaning the microphone stream is subscribed and binary audio data
   * is being delivered.
   */
  get isActive(): boolean {
    return this.chunkHandlers.size > 0;
  }

  /**
   * Whether the app has microphone permission.
   *
   * Updated when the cloud sends permission state changes. Apps that
   * require microphone access should declare `MICROPHONE` in their
   * hardware requirements.
   */
  get hasPermission(): boolean {
    return this._hasPermission;
  }

  /**
   * 🎤 Subscribe to raw PCM audio chunks from the microphone.
   *
   * Audio is always 16 kHz mono 16-bit signed PCM. The first subscriber
   * triggers an "audio_chunk" subscription to the cloud; the subscription
   * is removed when the last handler unsubscribes.
   *
   * @param handler - Called with each audio chunk as it arrives
   * @returns Cleanup function that removes this handler
   *
   * @example
   * ```ts
   * const stop = mic.onChunk((chunk) => {
   *   // chunk.data is an ArrayBuffer of PCM16 samples
   *   const samples = new Int16Array(chunk.data);
   *   processAudio(samples);
   * });
   *
   * // Later: unsubscribe
   * stop();
   * ```
   */
  onChunk(handler: (chunk: AudioChunk) => void): () => void {
    const isFirst = this.chunkHandlers.size === 0;

    this.chunkHandlers.add(handler);

    // Subscribe to the audio_chunk stream when the first handler registers
    if (isFirst) {
      this.deps.addSubscription(AUDIO_CHUNK_STREAM);
      this.deps.logger.debug("Subscribed to audio_chunk stream");
    }

    // Return cleanup function
    return () => {
      this.chunkHandlers.delete(handler);

      // Unsubscribe when the last handler is removed
      if (this.chunkHandlers.size === 0) {
        this.deps.removeSubscription(AUDIO_CHUNK_STREAM);
        this.deps.logger.debug("Unsubscribed from audio_chunk stream");
      }
    };
  }

  /**
   * 🗣️ Subscribe to voice activity detection events.
   *
   * VAD events indicate when the user starts or stops speaking. The
   * `status` field from the glasses may be a boolean or a string
   * ("true"/"false") — this manager normalizes it to a clean boolean.
   *
   * The first subscriber triggers a "VAD" subscription to the cloud and
   * registers a handler on the DataStreamRouter. The subscription is
   * removed when the last handler unsubscribes.
   *
   * @param handler - Called with each VAD event
   * @returns Cleanup function that removes this handler
   *
   * @example
   * ```ts
   * const stop = mic.onVoiceActivity((vad) => {
   *   if (vad.isSpeaking) {
   *     console.log("User started speaking");
   *   } else {
   *     console.log("User stopped speaking");
   *   }
   * });
   *
   * // Later: unsubscribe
   * stop();
   * ```
   */
  onVoiceActivity(handler: (vad: VadEvent) => void): () => void {
    const isFirst = this.vadHandlers.size === 0;

    this.vadHandlers.add(handler);

    // Subscribe and register router handler when the first handler registers
    if (isFirst) {
      this.deps.addSubscription(VAD_STREAM);

      // Listen for VAD DATA_STREAM messages on the router
      this.vadRouterCleanup = this.deps.router.on(VAD_STREAM, (_streamType: string, data: any, _message: any) => {
        this.handleVadMessage(data);
      });

      this.deps.logger.debug("Subscribed to VAD stream");
    }

    // Return cleanup function
    return () => {
      this.vadHandlers.delete(handler);

      // Unsubscribe and remove router handler when the last handler is removed
      if (this.vadHandlers.size === 0) {
        this.deps.removeSubscription(VAD_STREAM);

        if (this.vadRouterCleanup) {
          this.vadRouterCleanup();
          this.vadRouterCleanup = null;
        }

        this.deps.logger.debug("Unsubscribed from VAD stream");
      }
    };
  }

  /**
   * 🛑 Stop all microphone subscriptions.
   *
   * Removes all registered chunk and VAD handlers, unsubscribes from
   * both streams, and resets internal state. After calling `stop()`,
   * `isActive` will be false and no more callbacks will fire.
   *
   * @example
   * ```ts
   * mic.onChunk(handleChunk);
   * mic.onVoiceActivity(handleVad);
   *
   * // Later: clean up everything
   * mic.stop();
   * ```
   */
  stop(): void {
    // Clean up chunk handlers
    if (this.chunkHandlers.size > 0) {
      this.chunkHandlers.clear();
      this.deps.removeSubscription(AUDIO_CHUNK_STREAM);
      this.deps.logger.debug("Stopped audio_chunk subscriptions");
    }

    // Clean up VAD handlers
    if (this.vadHandlers.size > 0) {
      this.vadHandlers.clear();
      this.deps.removeSubscription(VAD_STREAM);

      if (this.vadRouterCleanup) {
        this.vadRouterCleanup();
        this.vadRouterCleanup = null;
      }

      this.deps.logger.debug("Stopped VAD subscriptions");
    }

    // Reset cached state
    this._isSpeaking = false;
  }

  // ─── Binary Audio Ingestion ──────────────────────────────────────────────

  /**
   * Handle an incoming binary audio frame from the WebSocket transport.
   *
   * MentraSession calls this method when it receives a binary WebSocket
   * frame that is identified as microphone audio (not part of an output
   * stream). The raw bytes are wrapped with metadata and dispatched to
   * all registered `onChunk` handlers.
   *
   * @param data - Raw binary audio data (PCM16, 16 kHz, mono)
   *
   * @remarks
   * This is a public method so MentraSession can call it, but it is not
   * intended to be called by app developers.
   *
   * @internal
   */
  handleBinaryAudio(data: ArrayBuffer): void {
    if (this.chunkHandlers.size === 0) {
      // No subscribers — skip processing
      return;
    }

    const chunk: AudioChunk = {
      data,
      sampleRate: 16000,
      channels: 1,
      timestamp: Date.now(),
    };

    for (const handler of this.chunkHandlers) {
      try {
        handler(chunk);
      } catch (err) {
        this.deps.logger.error("Audio chunk handler error:", err);
      }
    }
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  /**
   * Process an incoming VAD DATA_STREAM message.
   *
   * The glasses send VAD with `status` that can be:
   * - `true` / `false` (boolean)
   * - `"true"` / `"false"` (string)
   *
   * This method normalizes the value to a clean boolean and caches it
   * for the `isSpeaking` getter.
   */
  private handleVadMessage(data: any): void {
    if (!data) return;

    // Normalize status: boolean | "true" | "false" → boolean
    const rawStatus = data.status;
    let isSpeaking: boolean;

    if (typeof rawStatus === "boolean") {
      isSpeaking = rawStatus;
    } else if (typeof rawStatus === "string") {
      isSpeaking = rawStatus.toLowerCase() === "true";
    } else {
      this.deps.logger.warn("Unexpected VAD status type:", typeof rawStatus, rawStatus);
      return;
    }

    // Update cached state
    this._isSpeaking = isSpeaking;

    // Build the normalized event
    const event: VadEvent = {
      isSpeaking,
      timestamp: Date.now(),
    };

    // Dispatch to all registered handlers
    for (const handler of this.vadHandlers) {
      try {
        handler(event);
      } catch (err) {
        this.deps.logger.error("VAD handler error:", err);
      }
    }
  }
}
