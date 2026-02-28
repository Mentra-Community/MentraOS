/**
 * @fileoverview AudioManager manages audio processing within a user session.
 * It encapsulates all audio-related functionality that was previously
 * handled in the session service.
 *
 * This follows the pattern used by other managers like MicrophoneManager and DisplayManager.
 */

import { Logger } from "pino";

import { CloudToGlassesMessageType, ConnectionAck, StreamType } from "@mentra/sdk";

import { AudioWriter } from "../debug/audio-writer";
import { createLC3Service, LC3Service } from "../lc3/lc3.service";
import { metricsService } from "../metrics/MetricsService";
import { WebSocketReadyState } from "../websocket/types";

import UserSession from "./UserSession";

/**
 * Represents a sequenced audio chunk with metadata
 */
export interface SequencedAudioChunk {
  sequenceNumber: number;
  timestamp: number;
  data: ArrayBufferLike;
  isLC3: boolean;
  receivedAt: number;
}

/**
 * Represents an ordered buffer for processing audio chunks
 */
export interface OrderedAudioBuffer {
  chunks: SequencedAudioChunk[];
  lastProcessedSequence: number;
  processingInProgress: boolean;
  expectedNextSequence: number;
  bufferSizeLimit: number;
  bufferTimeWindowMs: number;
  bufferProcessingInterval: NodeJS.Timeout | null;
}

/**
 * Audio format configuration for client audio streams.
 * Clients can send audio as PCM or LC3.
 */
export type AudioFormat = "pcm" | "lc3";

/**
 * LC3 codec configuration - matches canonical config from mobile
 */
export interface LC3Config {
  sampleRate: number; // 16000 Hz
  frameDurationMs: number; // 10ms
  frameSizeBytes: number; // 20 bytes per frame
}

/**
 * Manages audio data processing, buffering, and relaying
 * for a user session
 */
export class AudioManager {
  private userSession: UserSession;
  private logger: Logger;

  // UDP audio tracking
  private udpPacketsReceived = 0;
  private lastUdpLogAt = 0;

  // LC3 decoding service
  private lc3Service?: LC3Service;

  // Audio format configuration
  private audioFormat: AudioFormat = "pcm"; // Default PCM for backwards compat
  private lc3Config?: LC3Config;

  // Audio debugging writer
  private audioWriter?: AudioWriter;

  // Buffer for recent audio (last 10 seconds)
  private recentAudioBuffer: { data: ArrayBufferLike; timestamp: number }[] = [];

  // Ordered buffer for sequenced audio chunks
  // private orderedBuffer: OrderedAudioBuffer;

  // Configuration
  private readonly LOG_AUDIO = false;
  private readonly DEBUG_AUDIO = false;
  private readonly IS_LC3 = false;

  // Lightweight telemetry for PCM ingestion
  private processedFrameCount = 0;
  private lastLogAt = 0;
  // Carry-over byte to keep PCM16 even-length between frames
  private pcmRemainder: Buffer | null = null;

  // Audio Gap Detection Configuration
  private readonly AUDIO_GAP_THRESHOLD_MS = 5000; // 5 seconds
  private readonly AUDIO_GAP_CHECK_INTERVAL_MS = 2000; // Check every 2 seconds
  private readonly RECONNECT_COOLDOWN_MS = 30000; // 30 seconds between reconnect attempts
  private audioGapCheckInterval?: NodeJS.Timeout;
  private lastReconnectAttemptAt?: number;
  private reconnectAttemptCount = 0;

  // Disposed flag to prevent stale callbacks (follows UserSession pattern)
  private disposed = false;

  constructor(userSession: UserSession) {
    this.userSession = userSession;
    this.logger = userSession.logger.child({ service: "AudioManager" });
    this.logger.info("AudioManager initialized");

    // Start audio gap monitoring
    // this.startAudioGapMonitoring(); // Disable audio gap detection. (we no longer use livekit, and VAD breaks / ruin this)
  }

  // ============================================================================
  // Audio Format Configuration
  // ============================================================================

  /**
   * Set the audio format for this session.
   * Called when client configures audio via REST endpoint.
   */
  setAudioFormat(format: AudioFormat, lc3Config?: LC3Config): void {
    this.audioFormat = format;
    this.lc3Config = lc3Config;

    this.logger.info(
      {
        audioFormat: format,
        lc3Config,
      },
      "Audio format configured",
    );

    // Initialize LC3 decoder if needed
    if (format === "lc3" && lc3Config) {
      this.initializeLc3Decoder();
    }
  }

  /**
   * Get the current audio format.
   */
  getAudioFormat(): AudioFormat {
    return this.audioFormat;
  }

  /**
   * Get the current LC3 config.
   */
  getLc3Config(): LC3Config | undefined {
    return this.lc3Config;
  }

  /**
   * Check if audio format is LC3.
   */
  isLC3(): boolean {
    return this.audioFormat === "lc3";
  }

  /**
   * Initialize LC3 decoder for incoming audio.
   */
  private async initializeLc3Decoder(): Promise<void> {
    try {
      // Clean up existing service if any
      if (this.lc3Service) {
        this.lc3Service.cleanup();
        this.lc3Service = undefined;
      }

      // Get frame size from config, default to 20 bytes (16kbps)
      const frameSizeBytes = this.lc3Config?.frameSizeBytes ?? 20;

      // Create new LC3 service for this session with the configured frame size
      this.lc3Service = createLC3Service(this.userSession.sessionId, frameSizeBytes);
      await this.lc3Service.initialize();

      this.logger.info(
        {
          sessionId: this.userSession.sessionId,
          lc3Config: this.lc3Config,
          frameSizeBytes,
        },
        "LC3 decoder initialized successfully",
      );
    } catch (error) {
      this.logger.error(error, "Failed to initialize LC3 decoder");
      // Reset to PCM format if LC3 initialization fails
      this.audioFormat = "pcm";
      this.lc3Service = undefined;
    }
  }

  /**
   * Start monitoring for audio gaps.
   * When audio stops arriving for longer than AUDIO_GAP_THRESHOLD_MS
   * and there are active transcription subscriptions, trigger a reconnect.
   */
  private startAudioGapMonitoring(): void {
    this.audioGapCheckInterval = setInterval(() => {
      // Guard against stale callback after disposal
      if (this.disposed) {
        return;
      }
      this.checkForAudioGap();
    }, this.AUDIO_GAP_CHECK_INTERVAL_MS);

    this.logger.info(
      {
        gapThresholdMs: this.AUDIO_GAP_THRESHOLD_MS,
        checkIntervalMs: this.AUDIO_GAP_CHECK_INTERVAL_MS,
        cooldownMs: this.RECONNECT_COOLDOWN_MS,
      },
      "Audio gap monitoring started",
    );
  }

  /**
   * Check if there's an audio gap that requires intervention.
   */
  private checkForAudioGap(): void {
    // Guard: Don't run if disposed
    if (this.disposed) {
      return;
    }

    const now = Date.now();
    const lastAudioTimestamp = this.userSession.lastAudioTimestamp;

    // No audio received yet - skip check
    if (!lastAudioTimestamp) {
      return;
    }

    const timeSinceLastAudio = now - lastAudioTimestamp;

    // Audio is flowing normally
    if (timeSinceLastAudio < this.AUDIO_GAP_THRESHOLD_MS) {
      return;
    }

    // Guard: Don't trigger reconnect if session is disconnected (in grace period)
    // The WebSocket is already closed, so sending CONNECTION_ACK would fail anyway.
    // When the user reconnects, they'll get a fresh CONNECTION_ACK naturally.
    if (this.userSession.disconnectedAt !== null) {
      this.logger.debug(
        { timeSinceLastAudio, feature: "audio-gap" },
        "Audio gap detected but session is disconnected (grace period) - skipping reconnect",
      );
      return;
    }

    // Guard: Check WebSocket is actually open before proceeding
    const websocket = this.userSession.websocket;
    if (!websocket || websocket.readyState !== WebSocketReadyState.OPEN) {
      this.logger.debug(
        { timeSinceLastAudio, readyState: websocket?.readyState, feature: "audio-gap" },
        "Audio gap detected but WebSocket not open - skipping reconnect",
      );
      return;
    }

    // Check if there are active transcription subscriptions
    // (we only care about gaps if something is expecting audio)
    if (!this.hasActiveAudioSubscriptions()) {
      return;
    }

    // Check if microphone is enabled (no point reconnecting if mic is off)
    if (!this.userSession.microphoneManager?.isEnabled()) {
      this.logger.debug(
        { timeSinceLastAudio, feature: "audio-gap" },
        "Audio gap detected but microphone is disabled - skipping reconnect",
      );
      return;
    }

    // Check cooldown to prevent reconnect storms
    if (this.lastReconnectAttemptAt && now - this.lastReconnectAttemptAt < this.RECONNECT_COOLDOWN_MS) {
      this.logger.debug(
        {
          timeSinceLastAudio,
          timeSinceLastReconnect: now - this.lastReconnectAttemptAt,
          cooldownMs: this.RECONNECT_COOLDOWN_MS,
          feature: "audio-gap",
        },
        "Audio gap detected but in cooldown period - skipping reconnect",
      );
      return;
    }

    // Audio gap detected with active subscriptions - trigger reconnect
    this.logger.warn(
      {
        timeSinceLastAudio,
        lastAudioTimestamp,
        userId: this.userSession.userId,
        reconnectAttemptCount: this.reconnectAttemptCount,
        feature: "audio-gap",
      },
      "Audio gap detected with active subscriptions - triggering LiveKit reconnect",
    );

    this.triggerLiveKitReconnect();
  }

  /**
   * Check if there are any active subscriptions that require audio.
   * This includes transcription, translation, and audio chunk subscriptions.
   */
  private hasActiveAudioSubscriptions(): boolean {
    // Check transcription subscriptions
    const transcriptionManager = this.userSession.transcriptionManager;
    if (transcriptionManager && !transcriptionManager.hasHealthyStreams()) {
      // TranscriptionManager has unhealthy streams - might need reconnect
      return true;
    }

    // Check if any apps are subscribed to audio chunks
    const audioChunkSubscribers = this.userSession.subscriptionManager.getSubscribedApps(StreamType.AUDIO_CHUNK);
    if (audioChunkSubscribers.length > 0) {
      return true;
    }

    // Check translation subscriptions (they also need audio)
    const translationManager = this.userSession.translationManager;
    if (translationManager && (translationManager as any).activeSubscriptions?.size > 0) {
      return true;
    }

    // Also check if transcription manager has active subscriptions even if streams are healthy
    // (streams might have closed unexpectedly)
    if (transcriptionManager && (transcriptionManager as any).activeSubscriptions?.size > 0) {
      return true;
    }

    return false;
  }

  /**
   * Trigger a LiveKit reconnect by sending a new CONNECTION_ACK to the glasses client.
   * This causes the mobile client to disconnect and reconnect to LiveKit with a fresh token.
   */
  private async triggerLiveKitReconnect(): Promise<void> {
    // Guard: Don't proceed if disposed
    if (this.disposed) {
      this.logger.debug({ feature: "audio-gap" }, "Skipping reconnect - AudioManager disposed");
      return;
    }

    this.lastReconnectAttemptAt = Date.now();
    this.reconnectAttemptCount++;

    try {
      // First, try to rejoin the server-side bridge
      this.logger.info({ feature: "audio-gap" }, "Attempting to rejoin LiveKit bridge");
      await this.userSession.liveKitManager?.rejoinBridge?.();

      // Guard: Check again after async operation
      if (this.disposed) {
        this.logger.debug({ feature: "audio-gap" }, "Aborted reconnect - AudioManager disposed during bridge rejoin");
        return;
      }

      // Guard: Re-check WebSocket state after async operation (it may have changed)
      const websocket = this.userSession.websocket;
      if (!websocket || websocket.readyState !== WebSocketReadyState.OPEN) {
        this.logger.warn(
          { feature: "audio-gap", readyState: websocket?.readyState },
          "Cannot send CONNECTION_ACK - WebSocket not open after bridge rejoin",
        );
        return;
      }

      // Guard: Re-check disconnectedAt after async operation
      if (this.userSession.disconnectedAt !== null) {
        this.logger.warn(
          { feature: "audio-gap" },
          "Cannot send CONNECTION_ACK - session disconnected during bridge rejoin",
        );
        return;
      }

      // Get fresh LiveKit info for the ACK
      let livekitInfo: { url: string; roomName: string; token: string } | null = null;
      try {
        livekitInfo = await this.userSession.liveKitManager?.handleLiveKitInit();
      } catch (error) {
        this.logger.warn({ error, feature: "audio-gap" }, "Failed to get LiveKit info for reconnect ACK");
      }

      // Guard: Final check before sending
      if (this.disposed || this.userSession.disconnectedAt !== null) {
        this.logger.debug({ feature: "audio-gap" }, "Aborted reconnect - state changed during LiveKit init");
        return;
      }

      // Build the CONNECTION_ACK message
      const ackMessage: ConnectionAck & { livekit?: { url: string; roomName: string; token: string } } = {
        type: CloudToGlassesMessageType.CONNECTION_ACK,
        sessionId: this.userSession.sessionId,
        timestamp: new Date(),
      };

      // Include UDP endpoint if configured
      const udpHost = process.env.UDP_HOST;
      const udpPort = process.env.UDP_PORT ? parseInt(process.env.UDP_PORT, 10) : 8000;
      if (udpHost) {
        (ackMessage as any).udpHost = udpHost;
        (ackMessage as any).udpPort = udpPort;
        this.logger.info(
          { udpHost, udpPort, feature: "udp-audio" },
          "[livekit reconnect] Included UDP endpoint in CONNECTION_ACK",
        );
      }

      // Include LiveKit info if available (this triggers client to reconnect LiveKit)
      if (livekitInfo) {
        ackMessage.livekit = {
          url: livekitInfo.url,
          roomName: livekitInfo.roomName,
          token: livekitInfo.token,
        };
      }

      websocket.send(JSON.stringify(ackMessage));
      metricsService.incrementClientMessagesOut();

      this.logger.info(
        {
          userId: this.userSession.userId,
          hasLivekitInfo: !!livekitInfo,
          reconnectAttemptCount: this.reconnectAttemptCount,
          feature: "audio-gap",
        },
        "Sent CONNECTION_ACK to trigger client LiveKit reconnect",
      );
    } catch (error) {
      this.logger.error({ error, feature: "audio-gap" }, "Failed to trigger LiveKit reconnect");
    }
  }

  /**
   * Process incoming audio data
   *
   * @param audioData The audio data to process (LC3 or PCM depending on configured format)
   * @param source The source of the audio data ("livekit" or "udp")
   * @returns Processed audio data (as PCM)
   */
  async processAudioData(audioData: ArrayBuffer | any, source: "livekit" | "udp" = "livekit") {
    // Guard: Don't process if disposed
    if (this.disposed) {
      return undefined;
    }

    // Track UDP packets
    if (source === "udp") {
      this.udpPacketsReceived++;

      // Log first UDP packet and then every 100
      if (this.udpPacketsReceived === 1) {
        this.logger.info(
          {
            feature: "udp-audio",
            userId: this.userSession.userId,
            audioDataLength: audioData?.length || audioData?.byteLength || 0,
          },
          "First UDP audio packet received in AudioManager",
        );
      } else if (this.udpPacketsReceived % 100 === 0) {
        const now = Date.now();
        const dt = this.lastUdpLogAt ? now - this.lastUdpLogAt : 0;
        this.lastUdpLogAt = now;
        this.logger.info(
          {
            feature: "udp-audio",
            udpPacketsReceived: this.udpPacketsReceived,
            msSinceLast100: dt,
            audioDataLength: audioData?.length || audioData?.byteLength || 0,
          },
          "UDP audio stats in AudioManager",
        );
      }
    }

    try {
      // Update the last audio timestamp
      this.userSession.lastAudioTimestamp = Date.now();

      // Send to transcription and translation services
      if (audioData) {
        // Normalize incoming data to Buffer
        let incomingBuf: Buffer | null = null;
        if (typeof Buffer !== "undefined" && Buffer.isBuffer(audioData)) {
          incomingBuf = audioData as Buffer;
        } else if (audioData instanceof ArrayBuffer) {
          incomingBuf = Buffer.from(audioData as ArrayBuffer);
        } else if (ArrayBuffer.isView(audioData)) {
          const view = audioData as ArrayBufferView;
          incomingBuf = Buffer.from(
            view.buffer,
            (view as any).byteOffset || 0,
            (view as any).byteLength || view.byteLength,
          );
        }

        if (!incomingBuf) {
          return undefined;
        }

        // Decode LC3 to PCM if audio format is LC3
        let buf: Buffer;
        if (this.audioFormat === "lc3" && this.lc3Service) {
          try {
            // IMPORTANT: Buffer.buffer returns the ENTIRE underlying ArrayBuffer, not just the slice.
            // For UDP audio, the buffer is sliced (buf.slice(6) to skip header), so byteOffset > 0.
            // We must extract only the relevant portion using slice() to avoid reading header bytes.
            const lc3ArrayBuffer = incomingBuf.buffer.slice(
              incomingBuf.byteOffset,
              incomingBuf.byteOffset + incomingBuf.byteLength,
            );
            const pcmArrayBuffer = await this.lc3Service.decodeAudioChunk(lc3ArrayBuffer);
            if (!pcmArrayBuffer || pcmArrayBuffer.byteLength === 0) {
              // LC3 decode failed or returned empty - skip this chunk
              if (this.processedFrameCount % 100 === 0) {
                this.logger.warn({ feature: "lc3-decode" }, "LC3 decode returned empty data");
              }
              return undefined;
            }
            buf = Buffer.from(pcmArrayBuffer);
          } catch (decodeError) {
            this.logger.error(decodeError, "LC3 decode error");
            return undefined;
          }
        } else {
          // PCM format - use incoming buffer directly
          buf = incomingBuf;
        }

        // Apply PCM remainder logic (for PCM16 alignment)
        if (this.pcmRemainder && this.pcmRemainder.length > 0) {
          buf = Buffer.concat([this.pcmRemainder, buf]);
          this.pcmRemainder = null;
        }
        if ((buf.length & 1) !== 0) {
          // Keep last byte for next frame to maintain PCM16 alignment
          this.pcmRemainder = buf.subarray(buf.length - 1);
          buf = buf.subarray(0, buf.length - 1);
        }
        if (buf.length === 0) {
          return undefined;
        }
        // Telemetry: log every 100 frames to avoid noise
        this.processedFrameCount++;
        if (this.processedFrameCount % 100 === 0) {
          const now = Date.now();
          const dt = this.lastLogAt ? now - this.lastLogAt : 0;
          this.lastLogAt = now;
          this.logger.debug(
            {
              feature: "livekit",
              frames: this.processedFrameCount,
              bytes: buf.length,
              msSinceLast: dt,
              audioFormat: this.audioFormat,
              head10: Array.from(buf.subarray(0, Math.min(10, buf.length))),
            },
            "AudioManager received audio chunk (decoded to PCM)",
          );
        }

        // Capture audio if enabled

        // Relay to Apps if there are subscribers
        this.relayAudioToApps(buf);

        // Feed to TranscriptionManager
        this.userSession.transcriptionManager.feedAudio(buf);

        // Feed to TranslationManager (separate from transcription)
        this.userSession.translationManager.feedAudio(buf);

        // Notify MicrophoneManager that we received audio
        this.userSession.microphoneManager.onAudioReceived();
      }
      return audioData;
    } catch (error) {
      this.logger.error(error, `Error processing audio data`);
      return undefined;
    }
  }

  /**
   * Initialize audio writer if needed
   */
  // private initializeAudioWriterIfNeeded(): void {
  //   if (this.DEBUG_AUDIO && !this.audioWriter) {
  //     this.audioWriter = new AudioWriter(this.userSession.userId);
  //   }
  // }

  private logAudioChunkCount = 0;
  /**
   * Relay audio data to Apps
   *
   * @param audioData Audio data to relay
   */
  private relayAudioToApps(audioData: ArrayBuffer | Buffer): void {
    try {
      // Get subscribers using subscriptionService instead of subscriptionManager
      const subscribedPackageNames = this.userSession.subscriptionManager.getSubscribedApps(StreamType.AUDIO_CHUNK);
      // Skip if no subscribers
      if (subscribedPackageNames.length === 0) {
        if (this.logAudioChunkCount % 500 === 0) {
          this.logger.debug({ feature: "livekit" }, "AUDIO_CHUNK: no subscribed apps");
        }
        this.logAudioChunkCount++;
        return;
      }
      const bytes =
        typeof Buffer !== "undefined" && Buffer.isBuffer(audioData)
          ? (audioData as Buffer).length
          : (audioData as ArrayBuffer).byteLength;

      if (this.logAudioChunkCount % 500 === 0) {
        this.logger.debug(
          { feature: "livekit", bytes, subscribers: subscribedPackageNames },
          "AUDIO_CHUNK: relaying to apps",
        );
      }

      // Send to each subscriber
      for (const packageName of subscribedPackageNames) {
        const connection = this.userSession.appWebsockets.get(packageName);

        if (connection && connection.readyState === WebSocketReadyState.OPEN) {
          try {
            if (this.logAudioChunkCount % 500 === 0) {
              this.logger.debug({ feature: "livekit", packageName, bytes }, "AUDIO_CHUNK: sending to app");
            }

            // Node ws supports Buffer; ensure we send Buffer for efficiency
            if (typeof Buffer !== "undefined" && Buffer.isBuffer(audioData)) {
              connection.send(audioData);
            } else {
              connection.send(Buffer.from(audioData as ArrayBuffer));
            }

            if (this.logAudioChunkCount % 500 === 0) {
              this.logger.debug({ feature: "livekit", packageName, bytes }, "AUDIO_CHUNK: sent to app");
            }
          } catch (sendError) {
            if (this.logAudioChunkCount % 500 === 0) {
              this.logger.error(sendError, `Error sending audio to ${packageName}:`);
            }
          }
        }
      }
      this.logAudioChunkCount++;
    } catch (error) {
      this.logger.error(error, `Error relaying audio:`);
    }
  }

  /**
   * Get recent audio buffer
   *
   * @returns Recent audio buffer
   */
  getRecentAudioBuffer(): { data: ArrayBufferLike; timestamp: number }[] {
    return [...this.recentAudioBuffer]; // Return a copy
  }

  /**
   * Get audio gap detection statistics for debugging/telemetry
   */
  getAudioGapStats(): {
    lastAudioTimestamp?: number;
    timeSinceLastAudio?: number;
    reconnectAttemptCount: number;
    lastReconnectAttemptAt?: number;
    hasActiveSubscriptions: boolean;
  } {
    const now = Date.now();
    const lastAudioTimestamp = this.userSession.lastAudioTimestamp;

    return {
      lastAudioTimestamp,
      timeSinceLastAudio: lastAudioTimestamp ? now - lastAudioTimestamp : undefined,
      reconnectAttemptCount: this.reconnectAttemptCount,
      lastReconnectAttemptAt: this.lastReconnectAttemptAt,
      hasActiveSubscriptions: this.hasActiveAudioSubscriptions(),
    };
  }

  /**
   * Check if this manager has been disposed
   */
  isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Clean up all resources
   */
  dispose(): void {
    // Idempotent - can be called multiple times safely
    if (this.disposed) {
      this.logger.debug("AudioManager already disposed, skipping");
      return;
    }

    // Set disposed flag FIRST to prevent any new operations or stale callbacks
    this.disposed = true;

    try {
      this.logger.info("Disposing AudioManager");

      // Stop audio gap monitoring
      if (this.audioGapCheckInterval) {
        clearInterval(this.audioGapCheckInterval);
        this.audioGapCheckInterval = undefined;
        this.logger.info("Audio gap monitoring stopped");
      }

      // Clean up LC3 service
      if (this.lc3Service) {
        this.logger.info(`🧹 Cleaning up LC3 service`);
        this.lc3Service.cleanup();
        this.lc3Service = undefined;
      }

      // Clear buffers
      this.recentAudioBuffer = [];
      this.pcmRemainder = null;

      // Clean up audio writer
      if (this.audioWriter) {
        // Audio writer doesn't have explicit cleanup
        this.audioWriter = undefined;
      }
    } catch (error) {
      this.logger.error(error, `Error disposing AudioManager:`);
    }
  }
}

export default AudioManager;
