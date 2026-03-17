/**
 * 🔊 Audio Module
 *
 * Audio functionality for App Sessions.
 * Handles audio playback and audio output streaming on connected glasses.
 */

import {AudioPlayRequest, AudioPlayResponse, AudioStopRequest, AppToCloudMessageType} from "../../../types"
import {Logger} from "pino"
import {AudioOutputStream, AudioOutputStreamOptions} from "./audio-output-stream"

/**
 * Options for audio playback
 */
export interface AudioPlayOptions {
  /** URL to audio file for download and play */
  audioUrl: string
  /** Volume level 0.0-1.0, defaults to 1.0 */
  volume?: number
  /** Whether to stop other audio playback, defaults to true */
  stopOtherAudio?: boolean
  /**
   * Track ID for audio playback (defaults to 0)
   * - 0: speaker (default audio playback)
   * - 1: app_audio (app-specific audio)
   * - 2: tts (text-to-speech audio)
   * Use different track IDs to play multiple audio streams simultaneously (mixing)
   */
  trackId?: number
}

/**
 * Options for text-to-speech
 */
export interface SpeakOptions {
  /** Voice ID to use (optional, defaults to server's ELEVENLABS_DEFAULT_VOICE_ID) */
  voice_id?: string
  /** Model ID to use (optional, defaults to eleven_flash_v2_5) */
  model_id?: string
  /** Voice settings object (optional) */
  voice_settings?: {
    stability?: number
    similarity_boost?: number
    style?: number
    use_speaker_boost?: boolean
    speed?: number
  }
  /** Volume level 0.0-1.0, defaults to 1.0 */
  volume?: number
  /** Whether to stop other audio playback, defaults to true */
  stopOtherAudio?: boolean
  /**
   * Track ID for audio playback (defaults to 2 for TTS)
   * - 0: speaker (default audio playback)
   * - 1: app_audio (app-specific audio)
   * - 2: tts (text-to-speech audio)
   * Use different track IDs to play multiple audio streams simultaneously (mixing)
   */
  trackId?: number
}

/**
 * Result of audio playback attempt
 */
export interface AudioPlayResult {
  /** Whether the audio playback was successful */
  success: boolean
  /** Error message if playback failed */
  error?: string
  /** Duration of the audio file in seconds (if available) */
  duration?: number
}

/**
 * 🔊 Audio Module Implementation
 *
 * Audio management for App Sessions.
 * Provides methods for:
 * - 🎵 Playing audio on glasses
 * - ⏹️ Stopping audio playback
 * - 🔍 Monitoring audio request status
 * - 🧹 Cleanup and cancellation
 *
 * @example
 * ```typescript
 * // Play audio
 * const result = await session.audio.playAudio({
 *   audioUrl: 'https://example.com/sound.mp3',
 *   volume: 0.8
 * });
 *
 * // Stop all audio
 * session.audio.stopAudio();
 * ```
 */
export class AudioManager {
  private session: any // Reference to AppSession
  private packageName: string
  private sessionId: string
  private logger: Logger

  /** Map to store pending audio play request promises */
  private pendingAudioRequests = new Map<
    string,
    {
      resolve: (value: AudioPlayResult) => void
      reject: (reason?: string) => void
    }
  >()

  /** Current active output stream (one at a time) */
  private activeOutputStream: AudioOutputStream | null = null

  /**
   * Create a new AudioManager
   *
   * @param packageName - The App package name
   * @param sessionId - The current session ID
   * @param send - Function to send messages to the cloud
   * @param session - Reference to the parent AppSession (optional)
   * @param logger - Logger instance for debugging
   */
  constructor(session: any, packageName: string, sessionId: string, logger?: Logger) {
    this.session = session
    this.packageName = packageName
    this.sessionId = sessionId
    this.logger = logger || (console as any)
  }

  // =====================================
  // 🎵 Audio Playback Functionality
  // =====================================

  /**
   * 🔊 Play audio on the connected glasses
   * @param options - Audio playback configuration
   * @returns Promise that resolves with playback result
   *
   * @example
   * ```typescript
   * // Play audio from URL
   * const result = await session.audio.playAudio({
   *   audioUrl: 'https://example.com/sound.mp3',
   *   volume: 0.8
   * });
   * ```
   */
  async playAudio(options: AudioPlayOptions): Promise<AudioPlayResult> {
    return new Promise((resolve, reject) => {
      try {
        // Validate input
        if (!options.audioUrl) {
          reject("audioUrl must be provided")
          return
        }

        // Generate unique request ID
        const requestId = `audio_req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`

        const stopOtherAudio = options.stopOtherAudio ?? true

        // CRITICAL: When stopOtherAudio=false (concurrent/mixing mode),
        // resolve immediately after sending the request (fire-and-forget)
        // This allows multiple audio streams to play simultaneously
        if (!stopOtherAudio) {
          // Create audio play request message
          const message: AudioPlayRequest = {
            type: AppToCloudMessageType.AUDIO_PLAY_REQUEST,
            packageName: this.packageName,
            sessionId: this.sessionId,
            requestId,
            timestamp: new Date(),
            audioUrl: options.audioUrl,
            volume: options.volume ?? 1.0,
            stopOtherAudio: false,
            trackId: options.trackId ?? 0, // Default to track 0 (speaker)
          }

          // Send request to cloud
          this.session.sendMessage(message)

          // Resolve immediately for concurrent playback (fire-and-forget)
          // The audio will play in the background without blocking
          this.logger.debug({requestId}, `🔊 Audio playback started in non-blocking mode (concurrent)`)
          resolve({
            success: true,
            duration: undefined, // Duration unknown in fire-and-forget mode
          })
          return
        }

        // For stopOtherAudio=true (blocking/interrupt mode),
        // wait for the COMPLETED/FAILED event before resolving
        this.pendingAudioRequests.set(requestId, {resolve, reject})

        // Create audio play request message
        const message: AudioPlayRequest = {
          type: AppToCloudMessageType.AUDIO_PLAY_REQUEST,
          packageName: this.packageName,
          sessionId: this.sessionId,
          requestId,
          timestamp: new Date(),
          audioUrl: options.audioUrl,
          volume: options.volume ?? 1.0,
          stopOtherAudio: true,
          trackId: options.trackId ?? 0, // Default to track 0 (speaker)
        }

        // Send request to cloud
        this.session.sendMessage(message)

        // Set timeout to avoid hanging promises (only for blocking mode)
        const timeoutMs = 60000 // 60 seconds
        if (this.session && this.session.resources) {
          // Use session's resource tracker for automatic cleeanup
          this.session.resources.setTimeout(() => {
            if (this.pendingAudioRequests.has(requestId)) {
              this.pendingAudioRequests.get(requestId)!.reject("Audio play request timed out")
              this.pendingAudioRequests.delete(requestId)
              this.logger.warn({requestId}, `🔊 Audio play request timed out`)
            }
          }, timeoutMs)
        } else {
          // Fallback to regular setTimeout if session not available
          setTimeout(() => {
            if (this.pendingAudioRequests.has(requestId)) {
              this.pendingAudioRequests.get(requestId)!.reject("Audio play request timed out")
              this.pendingAudioRequests.delete(requestId)
              this.logger.warn({requestId}, `🔊 Audio play request timed out`)
            }
          }, timeoutMs)
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        reject(`Failed to play audio: ${errorMessage}`)
      }
    })
  }

  /**
   * 🔇 Stop audio playback on the connected glasses
   * @param trackId - Optional track ID to stop (0=speaker, 1=app_audio, 2=tts). If omitted, stops all tracks.
   *
   * @example
   * ```typescript
   * // Stop all currently playing audio
   * session.audio.stopAudio();
   *
   * // Stop only the speaker track (track_id 0)
   * session.audio.stopAudio(0);
   *
   * // Stop only TTS track (track_id 2)
   * session.audio.stopAudio(2);
   * ```
   */
  stopAudio(trackId?: number): void {
    try {
      // Create audio stop request message
      const message: AudioStopRequest = {
        type: AppToCloudMessageType.AUDIO_STOP_REQUEST,
        packageName: this.packageName,
        sessionId: this.sessionId,
        trackId,
        timestamp: new Date(),
      }

      // Send request to cloud (one-way, no response expected)
      this.session.sendMessage(message)

      const trackInfo = trackId !== undefined ? ` (track ${trackId})` : " (all tracks)"
      this.logger.info(`🔇 Audio stop request sent${trackInfo}`)
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger.error(`Failed to stop audio: ${errorMessage}`)
    }
  }

  /**
   * 🗣️ Convert text to speech and play it on the connected glasses
   * @param text - Text to convert to speech (required)
   * @param options - Text-to-speech configuration (optional)
   * @returns Promise that resolves with playback result
   *
   * @example
   * ```typescript
   * // Basic text-to-speech
   * const result = await session.audio.speak('Hello, world!');
   *
   * // With custom voice settings
   * const result = await session.audio.speak('Hello, world!', {
   *   voice_id: 'your_voice_id',
   *   voice_settings: {
   *     stability: 0.5,
   *     speed: 1.2
   *   },
   *   volume: 0.8
   * });
   *
   * // Play TTS without stopping other audio
   * const result = await session.audio.speak('Hello, world!', {
   *   stopOtherAudio: false
   * });
   * ```
   */
  async speak(text: string, options: SpeakOptions = {}): Promise<AudioPlayResult> {
    // Validate input
    if (!text) {
      throw new Error("text must be provided")
    }

    // Get the HTTPS server URL from the session
    const baseUrl = this.session?.getHttpsServerUrl?.()
    if (!baseUrl) {
      throw new Error("Cannot determine server URL for TTS endpoint")
    }

    // Build query parameters for the TTS endpoint
    const queryParams = new URLSearchParams()
    queryParams.append("text", text)

    if (options.voice_id) {
      queryParams.append("voice_id", options.voice_id)
    }

    if (options.model_id) {
      queryParams.append("model_id", options.model_id)
    }

    if (options.voice_settings) {
      queryParams.append("voice_settings", JSON.stringify(options.voice_settings))
    }

    // Construct the TTS URL
    const ttsUrl = `${baseUrl}/api/tts?${queryParams.toString()}`

    this.logger.debug({text, ttsUrl}, "Generating speech from text")

    // IMPORTANT: Don't call stopAudio() here - it closes tracks completely!
    // The backend will handle stopping any ongoing playback when it receives
    // the new audio play request (via stopOtherAudio flag)

    // Use the existing playAudio method to play the TTS audio
    // The stopOtherAudio flag will cancel ongoing playback without closing tracks
    return this.playAudio({
      audioUrl: ttsUrl,
      volume: options.volume,
      stopOtherAudio: options.stopOtherAudio ?? true, // This flag tells backend to stop current playback
      trackId: options.trackId ?? 2, // Default to track 2 (tts)
    })
  }

  // =====================================
  // 📥 Response Handling
  // =====================================

  /**
   * 📥 Handle audio play response from cloud
   *
   * This method is called internally when an audio play response is received.
   * It resolves the corresponding pending promise with the response data.
   *
   * @param response - The audio play response received
   * @internal This method is used internally by AppSession
   */
  handleAudioPlayResponse(response: AudioPlayResponse): void {
    const pendingRequest = this.pendingAudioRequests.get(response.requestId)

    if (pendingRequest) {
      // Resolve the promise with the response data
      pendingRequest.resolve({
        success: response.success,
        error: response.error,
        duration: response.duration,
      })

      // Clean up
      this.pendingAudioRequests.delete(response.requestId)

      this.logger.info(
        {
          requestId: response.requestId,
          success: response.success,
          duration: response.duration,
        },
        `🔊 Audio play response received`,
      )
    } else {
      this.logger.warn({requestId: response.requestId}, `🔊 Received audio play response for unknown request ID`)
    }
  }

  // =====================================
  // 🔍 Status and Management
  // =====================================

  /**
   * 🔍 Check if there are pending audio requests
   * @param requestId - Optional specific request ID to check
   * @returns True if there are pending requests (or specific request exists)
   */
  hasPendingRequest(requestId?: string): boolean {
    if (requestId) {
      return this.pendingAudioRequests.has(requestId)
    }
    return this.pendingAudioRequests.size > 0
  }

  /**
   * 📊 Get the number of pending audio requests
   * @returns Number of pending requests
   */
  getPendingRequestCount(): number {
    return this.pendingAudioRequests.size
  }

  /**
   * 📋 Get all pending request IDs
   * @returns Array of pending request IDs
   */
  getPendingRequestIds(): string[] {
    return Array.from(this.pendingAudioRequests.keys())
  }

  /**
   * ❌ Cancel a specific audio request
   * @param requestId - The request ID to cancel
   * @returns True if the request was found and cancelled
   */
  cancelAudioRequest(requestId: string): boolean {
    const pendingRequest = this.pendingAudioRequests.get(requestId)
    if (pendingRequest) {
      pendingRequest.reject("Audio request cancelled")
      this.pendingAudioRequests.delete(requestId)
      this.logger.info({requestId}, `🔊 Audio request cancelled`)
      return true
    }
    return false
  }

  /**
   * 🧹 Cancel all pending audio requests
   * @returns Number of requests that were cancelled
   */
  cancelAllAudioRequests(): number {
    const count = this.pendingAudioRequests.size
    this.pendingAudioRequests.forEach((request, requestId) => {
      request.reject("Audio request cancelled due to cleanup")
      this.logger.debug({requestId}, `🔊 Audio request cancelled during cleanup`)
    })
    this.pendingAudioRequests.clear()

    if (count > 0) {
      this.logger.info({cancelledCount: count}, `🧹 Cancelled all pending audio requests`)
    }

    return count
  }

  // =====================================
  // 🎙️ Audio Output Streaming
  // =====================================

  /**
   * Create a real-time audio output stream.
   *
   * This opens a streaming relay on the cloud and tells the phone to play it.
   * You write audio chunks to the returned stream, and they play on the glasses
   * speaker in real-time — like internet radio.
   *
   * **MP3 pass-through** (most common — ElevenLabs, Cartesia, OpenAI TTS, Azure):
   * ```typescript
   * const output = await session.audio.createOutputStream({ format: "mp3" })
   * elevenlabs.on("chunk", (mp3) => output.write(mp3))
   * elevenlabs.on("end", () => output.end())
   * ```
   *
   * **PCM encoding** (Gemini Live, OpenAI Realtime — requires `lamejs`):
   * ```typescript
   * const output = await session.audio.createOutputStream({
   *   format: "pcm16",
   *   sampleRate: 24000,
   *   channels: 1,
   * })
   * realtimeApi.on("audio", (pcm) => output.write(pcm))
   * ```
   *
   * @param options - Stream configuration
   * @returns The AudioOutputStream (already connected and playing)
   */
  async createOutputStream(options: AudioOutputStreamOptions = {}): Promise<AudioOutputStream> {
    // Enforce explicit stream lifecycle: callers must end/flush before creating another stream.
    if (this.activeOutputStream && this.activeOutputStream.state === "streaming") {
      const activeStreamId = this.activeOutputStream.streamId
      const error = new Error(
        `AUDIO_STREAM_ALREADY_ACTIVE: Stream ${activeStreamId} is still active. Call end() or flush() before creating a new output stream.`,
      ) as Error & {code?: string}
      error.code = "AUDIO_STREAM_ALREADY_ACTIVE"
      this.logger.warn({activeStreamId}, "Refusing to create a second output stream while one is active")
      throw error
    }

    // Generate a unique stream ID
    const streamId = crypto.randomUUID()

    const stream = new AudioOutputStream(streamId, this.session, this.logger, options)

    // Open the stream (sends AUDIO_STREAM_START, waits for relay URL, tells phone to play)
    await stream.open()

    this.activeOutputStream = stream

    // Clean up reference when the stream ends
    stream.on("close", () => {
      if (this.activeOutputStream === stream) {
        this.activeOutputStream = null
      }
    })

    return stream
  }

  /**
   * Get the currently active output stream (if any).
   */
  getActiveOutputStream(): AudioOutputStream | null {
    return this.activeOutputStream
  }

  // =====================================
  // 🔧 Internal Management
  // =====================================

  /**
   * 🔄 Update the session ID when reconnecting
   * @param newSessionId - The new session ID
   * @internal Used by AppSession during reconnection
   */
  updateSessionId(newSessionId: string): void {
    this.sessionId = newSessionId
    this.logger.debug({newSessionId}, "Audio module session ID updated")
  }

  /**
   * 🧹 Cancel all pending requests (cleanup)
   * @returns Object with count of cancelled requests
   * @internal Used by AppSession during cleanup
   */
  cancelAllRequests(): {audioRequests: number} {
    const audioRequests = this.cancelAllAudioRequests()

    // Also end any active output stream
    if (this.activeOutputStream && this.activeOutputStream.state === "streaming") {
      this.activeOutputStream.end().catch(() => {})
      this.activeOutputStream = null
    }

    return {audioRequests}
  }
}
