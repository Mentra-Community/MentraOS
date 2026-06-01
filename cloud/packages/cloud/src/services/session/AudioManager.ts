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
import { operationTimers } from "../metrics/SystemVitalsLogger";
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

// Issue 102: warn when a single relayAudioToApps invocation takes longer than
// this. At the steady-state rate of ~115μs per audio call, 20ms indicates either
// connection.send() backpressure (stuck app WS) or an unusually wide fan-out.
const SLOW_RELAY_MS = 20;
// Issue 102: warn when a session has more than this many audio_chunk subscribers.
// Typical session has 1-5 apps subscribed. >10 suggests either subscriber-list
// growth (hypothesis C) or an unusual app-install pattern worth investigating.
const FANOUT_WARN = 10;
// Issue 102: warn when one substage of processAudioData takes longer than this.
// Each substage (LC3 decode, fan-out, transcription/translation feed, mic update)
// is sub-millisecond in steady state; 10ms is ~10x normal — caught early without
// flooding logs. The cumulative `op_audio_<stage>_ms` totals always emit per
// vitals window regardless of this threshold.
const SLOW_AUDIO_STAGE_MS = 10;
type AudioStage = "lc3Decode" | "appFanout" | "transcriptionFeed" | "translationFeed" | "microphoneUpdate";

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

  // Disposed flag to prevent stale callbacks (follows UserSession pattern)
  private disposed = false;

  constructor(userSession: UserSession) {
    this.userSession = userSession;
    this.logger = userSession.logger.child({ service: "AudioManager" });
    this.logger.info("AudioManager initialized");
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
   * Process incoming audio data
   *
   * @param audioData The audio data to process (LC3 or PCM depending on configured format)
   * @param source The source of the audio data ("udp" or "legacy")
   * @returns Processed audio data (as PCM)
   */
  async processAudioData(audioData: ArrayBuffer | any, source: "udp" | "legacy" = "udp") {
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
          // Issue 102: time the LC3 decode substage. The await means this
          // captures wall-clock time including any loop yields; if the
          // underlying decoder is sync (native binding), this is also the
          // event-loop blocking time.
          const tLc3 = performance.now();
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
              this.recordAudioStage("lc3Decode", performance.now() - tLc3, incomingBuf.byteLength);
              return undefined;
            }
            buf = Buffer.from(pcmArrayBuffer);
          } catch (decodeError) {
            this.logger.error(decodeError, "LC3 decode error");
            this.recordAudioStage("lc3Decode", performance.now() - tLc3, incomingBuf.byteLength);
            return undefined;
          }
          this.recordAudioStage("lc3Decode", performance.now() - tLc3, incomingBuf.byteLength);
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
              feature: "audio",
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

        // Issue 102: per-substage timings. Each substage gets its own
        // op_audio_<stage>_ms cumulative bucket in vitals plus a
        // slow-audio-stage outlier warning. Together they answer the
        // "which substage burns the loop time" question that v1 of this
        // PR could not — and that drives Phase 2's actual fix scope.

        // Relay to Apps if there are subscribers
        const tFanout = performance.now();
        this.relayAudioToApps(buf);
        this.recordAudioStage("appFanout", performance.now() - tFanout, buf.length);

        // Feed to TranscriptionManager
        const tTranscription = performance.now();
        this.userSession.transcriptionManager.feedAudio(buf);
        this.recordAudioStage("transcriptionFeed", performance.now() - tTranscription, buf.length);

        // Feed to TranslationManager (separate from transcription)
        const tTranslation = performance.now();
        this.userSession.translationManager.feedAudio(buf);
        this.recordAudioStage("translationFeed", performance.now() - tTranslation, buf.length);

        // Notify MicrophoneManager that we received audio
        const tMic = performance.now();
        this.userSession.microphoneManager.onAudioReceived();
        this.recordAudioStage("microphoneUpdate", performance.now() - tMic, buf.length);
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
  /**
   * Issue 102: privacy-preserving correlation key shared across slow-audio-call,
   * slow-audio-stage, and slow-audio-fanout warnings. Reads from
   * UdpAudioManager which already maintains the FNV-1a 32-bit hash. Returns
   * undefined for sessions whose UDP path hasn't registered yet (legacy WS
   * audio path), in which case the userId is still in the logger context.
   */
  private getCorrelationUserIdHash(): number | undefined {
    return this.userSession.udpAudioManager?.userIdHash;
  }

  /**
   * Issue 102: record one substage's wall-time inside processAudioData. Adds
   * to operationTimers (op_audio_<stage>_ms appears in vitals) and emits a
   * slow-audio-stage warning on outliers. The async/sync semantics depend on
   * the substage — LC3 decode is awaited (wall-clock time including loop
   * yields), the rest are sync. Either reading is informative because the
   * cumulative bucket per vitals window gives us the aggregate breakdown.
   */
  private recordAudioStage(stage: AudioStage, durationMs: number, bytes: number): void {
    operationTimers.addTiming(`audio_${stage}`, durationMs);
    if (durationMs > SLOW_AUDIO_STAGE_MS) {
      this.logger.warn(
        {
          feature: "slow-audio-stage",
          stage,
          durationMs: Math.round(durationMs * 10) / 10,
          userIdHash: this.getCorrelationUserIdHash(),
          bytes,
        },
        `Slow audio substage ${stage}: ${Math.round(durationMs)}ms`,
      );
    }
  }

  private relayAudioToApps(audioData: ArrayBuffer | Buffer): void {
    // Issue 102: timer + fan-out instrumentation. Disambiguates cascade
    // hypotheses A (cascade), B (pathological call), C (fan-out blowup).
    const t0 = performance.now();
    let subCount = 0;
    let bytes = 0;
    try {
      // Get subscribers using subscriptionService instead of subscriptionManager
      const subscribedPackageNames = this.userSession.subscriptionManager.getSubscribedApps(StreamType.AUDIO_CHUNK);
      subCount = subscribedPackageNames.length;
      // Skip if no subscribers
      if (subCount === 0) {
        if (this.logAudioChunkCount % 500 === 0) {
          this.logger.debug({ feature: "audio" }, "AUDIO_CHUNK: no subscribed apps");
        }
        this.logAudioChunkCount++;
        return;
      }
      bytes =
        typeof Buffer !== "undefined" && Buffer.isBuffer(audioData)
          ? (audioData as Buffer).length
          : (audioData as ArrayBuffer).byteLength;

      if (this.logAudioChunkCount % 500 === 0) {
        this.logger.debug(
          { feature: "audio", bytes, subscribers: subscribedPackageNames },
          "AUDIO_CHUNK: relaying to apps",
        );
      }

      // Send to each subscriber
      for (const packageName of subscribedPackageNames) {
        const connection = this.userSession.appWebsockets.get(packageName);

        if (connection && connection.readyState === WebSocketReadyState.OPEN) {
          try {
            if (this.logAudioChunkCount % 500 === 0) {
              this.logger.debug({ feature: "audio", packageName, bytes }, "AUDIO_CHUNK: sending to app");
            }

            // Node ws supports Buffer; ensure we send Buffer for efficiency
            if (typeof Buffer !== "undefined" && Buffer.isBuffer(audioData)) {
              connection.send(audioData);
            } else {
              connection.send(Buffer.from(audioData as ArrayBuffer));
            }

            if (this.logAudioChunkCount % 500 === 0) {
              this.logger.debug({ feature: "audio", packageName, bytes }, "AUDIO_CHUNK: sent to app");
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
    } finally {
      const durationMs = performance.now() - t0;
      if (durationMs > SLOW_RELAY_MS || subCount > FANOUT_WARN) {
        this.logger.warn(
          {
            feature: "slow-audio-fanout",
            durationMs: Math.round(durationMs * 10) / 10,
            subscribers: subCount,
            bytes,
            // Issue 102: correlation key matching slow-audio-call and
            // slow-audio-stage so investigators can tie a fan-out warning
            // back to the same UDP handler invocation / session.
            userIdHash: this.getCorrelationUserIdHash(),
          },
          `Slow audio fan-out: ${Math.round(durationMs)}ms across ${subCount} subscribers`,
        );
      }
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
