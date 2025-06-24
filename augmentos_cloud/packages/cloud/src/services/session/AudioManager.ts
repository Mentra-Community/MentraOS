/**
 * @fileoverview AudioManager manages audio processing within a user session.
 * It encapsulates all audio-related functionality that was previously
 * handled in the session service.
 *
 * This follows the pattern used by other managers like MicrophoneManager and DisplayManager.
 */

import WebSocket from 'ws';
import {
  StreamType
} from '@mentra/sdk';
import { Logger } from 'pino';
import subscriptionService from './subscription.service';
import transcriptionService from '../processing/transcription.service';
import { createLC3Service } from '@mentra/utils';
import { AudioWriter } from '../debug/audio-writer';
import UserSession from './UserSession';

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
 * Manages audio data processing, buffering, and relaying
 * for a user session
 */
export class AudioManager {
  private userSession: UserSession;
  private logger: Logger;

  // LC3 decoding service
  private lc3Service?: any;

  // Audio debugging writer
  private audioWriter?: AudioWriter;

  // Buffer for recent audio (last 10 seconds)
  private recentAudioBuffer: { data: ArrayBufferLike; timestamp: number }[] = [];

  // Ordered buffer for sequenced audio chunks
  private orderedBuffer: OrderedAudioBuffer;

  // Configuration
  private readonly LOG_AUDIO = false;
  private readonly DEBUG_AUDIO = false;
  private readonly IS_LC3 = false;

  constructor(userSession: UserSession) {
    this.userSession = userSession;
    this.logger = userSession.logger.child({ service: 'AudioManager' });

    // Initialize ordered buffer
    this.orderedBuffer = {
      chunks: [],
      lastProcessedSequence: -1,
      processingInProgress: false,
      expectedNextSequence: 0,
      bufferSizeLimit: 100,
      bufferTimeWindowMs: 500,
      bufferProcessingInterval: null
    };

    // Initialize LC3 service if needed
    this.initializeLc3Service();

    this.logger.info('AudioManager initialized');
  }

  /**
   * Initialize the LC3 service
   */
  private async initializeLc3Service(): Promise<void> {
    try {
      if (this.IS_LC3) {
        const lc3ServiceInstance = createLC3Service(this.userSession.sessionId);
        await lc3ServiceInstance.initialize();
        this.lc3Service = lc3ServiceInstance;
        this.logger.info(`✅ LC3 Service initialized`);
      }
    } catch (error) {
      this.logger.error(`❌ Failed to initialize LC3 service:`, error);
    }
  }

  /**
   * Process incoming audio data
   *
   * @param audioData The audio data to process
   * @param isLC3 Whether the audio is LC3 encoded
   * @returns Processed audio data
   */
  async processAudioData(audioData: ArrayBuffer | any, isLC3 = this.IS_LC3): Promise<ArrayBuffer | void> {
    try {
      // Update the last audio timestamp
      this.userSession.lastAudioTimestamp = Date.now();

      // Add to recent audio buffer
      // this.addToRecentBuffer(audioData);

      // Lazy initialize the audio writer if needed
      // this.initializeAudioWriterIfNeeded();

      // Write raw LC3 audio for debugging if applicable
      // if (this.DEBUG_AUDIO && isLC3 && audioData) {
      //   await this.audioWriter?.writeLC3(audioData);
      // }

      // Process the audio data
      // let processedAudioData = await this.processAudioInternal(audioData, isLC3);
      let processedAudioData = audioData;

      // Send to transcription service
      if (processedAudioData) {
        transcriptionService.feedAudioToTranscriptionStreams(this.userSession, processedAudioData);

        // Relay to TPAs if there are subscribers
        // Note: Using subscriptionService instead of subscriptionManager
        // if (subscriptionService.hasMediaSubscriptions(this.userSession.sessionId)) {
        this.relayAudioToTpas(processedAudioData);
        // }
      }

      return processedAudioData;
    } catch (error) {
      this.logger.error({ error }, `Error processing audio data`);
      return undefined;
    }
  }

  /**
   * Process audio data internally
   *
   * @param audioData The audio data to process
   * @param isLC3 Whether the audio is LC3 encoded
   * @returns Processed audio data
   */
  private async processAudioInternal(audioData: ArrayBuffer | any, isLC3: boolean): Promise<ArrayBuffer | void> {
    // Return early if no data
    if (!audioData) return undefined;

    // Process LC3 if needed
    if (isLC3 && this.lc3Service) {
      try {
        // Decode the LC3 audio
        const decodedData = await this.lc3Service.decodeAudioChunk(audioData);

        if (!decodedData) {
          if (this.LOG_AUDIO) this.logger.warn(`⚠️ LC3 decode returned null`);
          return undefined;
        }

        // Write decoded PCM for debugging
        if (this.DEBUG_AUDIO) {
          await this.audioWriter?.writePCM(decodedData);
        }

        return decodedData;
      } catch (error) {
        this.logger.error(`❌ Error decoding LC3 audio:`, error);
        await this.reinitializeLc3Service();
        return undefined;
      }
    } else {
      // Non-LC3 audio
      if (this.DEBUG_AUDIO) {
        await this.audioWriter?.writePCM(audioData);
      }
      return audioData;
    }
  }

  /**
   * Add audio data to recent buffer
   *
   * @param audioData Audio data to add
   */
  private addToRecentBuffer(audioData: ArrayBufferLike): void {
    if (!audioData) return;

    const now = Date.now();

    // Add to buffer
    this.recentAudioBuffer.push({
      data: audioData,
      timestamp: now
    });

    // Prune old data (keep only last 10 seconds)
    const tenSecondsAgo = now - 10_000;
    this.recentAudioBuffer = this.recentAudioBuffer.filter(
      chunk => chunk.timestamp >= tenSecondsAgo
    );
  }

  /**
   * Initialize audio writer if needed
   */
  private initializeAudioWriterIfNeeded(): void {
    if (this.DEBUG_AUDIO && !this.audioWriter) {
      this.audioWriter = new AudioWriter(this.userSession.userId);
    }
  }

  /**
   * Reinitialize the LC3 service after an error
   */
  private async reinitializeLc3Service(): Promise<void> {
    try {
      if (this.lc3Service) {
        this.logger.warn(`⚠️ Attempting to reinitialize LC3 service`);

        // Clean up existing service
        this.lc3Service.cleanup();
        this.lc3Service = undefined;

        // Create and initialize new service
        const newLc3Service = createLC3Service(this.userSession.sessionId);
        await newLc3Service.initialize();
        this.lc3Service = newLc3Service;

        this.logger.info(`✅ Successfully reinitialized LC3 service`);
      }
    } catch (reinitError) {
      this.logger.error(`❌ Failed to reinitialize LC3 service:`, reinitError);
    }
  }

  /**
   * Add a sequenced audio chunk to the ordered buffer
   *
   * @param chunk Sequenced audio chunk
   */
  addToOrderedBuffer(chunk: SequencedAudioChunk): void {
    try {
      if (!this.orderedBuffer) return;

      // Add to buffer
      this.orderedBuffer.chunks.push(chunk);

      // Sort by sequence number (in case chunks arrive out of order)
      this.orderedBuffer.chunks.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

      // Enforce buffer size limit
      if (this.orderedBuffer.chunks.length > this.orderedBuffer.bufferSizeLimit) {
        // Remove oldest chunks
        this.orderedBuffer.chunks = this.orderedBuffer.chunks.slice(
          this.orderedBuffer.chunks.length - this.orderedBuffer.bufferSizeLimit
        );
      }
    } catch (error) {
      this.logger.error(`Error adding to ordered buffer:`, error);
    }
  }

  /**
   * Process chunks in the ordered buffer
   */
  async processOrderedBuffer(): Promise<void> {
    if (this.orderedBuffer.processingInProgress) {
      return; // Already processing
    }

    try {
      this.orderedBuffer.processingInProgress = true;

      // Skip if buffer is empty
      if (this.orderedBuffer.chunks.length === 0) {
        return;
      }

      // Process chunks in order
      for (const chunk of this.orderedBuffer.chunks) {
        // Skip already processed chunks
        if (chunk.sequenceNumber <= this.orderedBuffer.lastProcessedSequence) {
          continue;
        }

        // Process the chunk
        await this.processAudioData(chunk.data, chunk.isLC3);

        // Update last processed sequence
        this.orderedBuffer.lastProcessedSequence = chunk.sequenceNumber;

        // Update expected next sequence
        this.orderedBuffer.expectedNextSequence = chunk.sequenceNumber + 1;
      }

      // Remove processed chunks
      this.orderedBuffer.chunks = this.orderedBuffer.chunks.filter(
        chunk => chunk.sequenceNumber > this.orderedBuffer.lastProcessedSequence
      );
    } catch (error) {
      this.logger.error(`Error processing ordered buffer:`, error);
    } finally {
      this.orderedBuffer.processingInProgress = false;
    }
  }

  /**
   * Start the ordered buffer processing interval
   *
   * @param intervalMs Interval in milliseconds
   */
  startOrderedBufferProcessing(intervalMs: number = 100): void {
    // Clear any existing interval
    this.stopOrderedBufferProcessing();

    // Start new interval
    this.orderedBuffer.bufferProcessingInterval = setInterval(
      () => this.processOrderedBuffer(),
      intervalMs
    );

    this.logger.info(`Started ordered buffer processing with interval ${intervalMs}ms`);
  }

  /**
   * Stop the ordered buffer processing interval
   */
  stopOrderedBufferProcessing(): void {
    if (this.orderedBuffer.bufferProcessingInterval) {
      clearInterval(this.orderedBuffer.bufferProcessingInterval);
      this.orderedBuffer.bufferProcessingInterval = null;
      this.logger.info(`Stopped ordered buffer processing`);
    }
  }

  /**
   * Relay audio data to TPAs
   *
   * @param audioData Audio data to relay
   */
  private relayAudioToTpas(audioData: ArrayBuffer): void {
    try {
      // Get subscribers using subscriptionService instead of subscriptionManager
      const subscribedPackageNames = subscriptionService.getSubscribedApps(
        this.userSession,
        StreamType.AUDIO_CHUNK
      );

      // Skip if no subscribers
      if (subscribedPackageNames.length === 0) {
        return;
      }

      // Send to each subscriber
      for (const packageName of subscribedPackageNames) {
        const connection = this.userSession.appWebsockets.get(packageName);

        if (connection && connection.readyState === WebSocket.OPEN) {
          try {
            connection.send(audioData);
          } catch (sendError) {
            this.logger.error(`Error sending audio to ${packageName}:`, sendError);
          }
        }
      }
    } catch (error) {
      this.logger.error(`Error relaying audio:`, error);
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
   * Get audio service info for debugging
   *
   * @returns Audio service info
   */
  getAudioServiceInfo(): object | null {
    if (this.lc3Service) {
      return this.lc3Service.getInfo();
    }
    return null;
  }

  /**
   * Clean up all resources
   */
  dispose(): void {
    try {
      this.logger.info('Disposing AudioManager');

      // Stop buffer processing
      this.stopOrderedBufferProcessing();

      // Clean up LC3 service
      if (this.lc3Service) {
        this.logger.info(`🧹 Cleaning up LC3 service`);
        this.lc3Service.cleanup();
        this.lc3Service = undefined;
      }

      // Clear buffers
      this.recentAudioBuffer = [];
      if (this.orderedBuffer) {
        this.orderedBuffer.chunks = [];
      }

      // Clean up audio writer
      if (this.audioWriter) {
        // Audio writer doesn't have explicit cleanup
        this.audioWriter = undefined;
      }
    } catch (error) {
      this.logger.error(`Error disposing AudioManager:`, error);
    }
  }
}

export default AudioManager;