/**
 * @fileoverview TranscriptionManager - Per-session transcription management with provider abstraction
 */

import { Logger } from "pino";
import {
  ExtendedStreamType,
  getLanguageInfo,
  StreamType,
  CloudToAppMessageType,
  DataStream,
  TranscriptSegment,
  LocalTranscription,
} from "@mentra/sdk";
import UserSession from "../UserSession";
import { PosthogService } from "../../logging/posthog.service";
import {
  TranscriptionConfig,
  TranscriptionProvider,
  StreamInstance,
  ProviderType,
  StreamState,
  InvalidSubscriptionError,
  NoProviderAvailableError,
  ResourceLimitError,
  StreamCreationTimeoutError,
  StreamInitializationError,
  DEFAULT_TRANSCRIPTION_CONFIG,
} from "./types";
import { ProviderSelector } from "./ProviderSelector";
import { AzureTranscriptionProvider } from "./providers/AzureTranscriptionProvider";
import { SonioxTranscriptionProvider } from "./providers/SonioxTranscriptionProvider";
import { AlibabaTranscriptionProvider } from "./providers/AlibabaTranscriptionProvider";
// import subscriptionService from "../subscription.service";

export class TranscriptionManager {
  public readonly logger: Logger;

  // Provider Management
  private providers = new Map<ProviderType, TranscriptionProvider>();
  private providerSelector?: ProviderSelector;

  // Initialization State
  private isInitialized = false;
  private initializationPromise: Promise<void>;
  private pendingOperations: Array<() => Promise<void>> = [];

  // Stream Management
  private streams = new Map<string, StreamInstance>();
  private activeSubscriptions = new Set<ExtendedStreamType>();

  // Retry Logic
  private streamRetryAttempts = new Map<string, number>();
  private streamCreationPromises = new Map<string, Promise<void>>();

  // VAD Audio Buffering (to prevent missing speech during stream startup)
  private vadAudioBuffer: ArrayBuffer[] = [];
  private vadBufferMaxSize = 50; // ~2.5 seconds at 50ms chunks
  private isBufferingForVAD = false;
  private vadBufferTimeout?: NodeJS.Timeout;
  private vadBufferTimeoutMs = 10000; // 10 second timeout if VAD never turns off

  private DEPLOYMENT_REGION: string = process.env.DEPLOYMENT_REGION || "global";
  private IS_CHINA: boolean = this.DEPLOYMENT_REGION === "china";

  // Health Monitoring
  private healthCheckInterval?: NodeJS.Timeout;

  // Transcript History Management
  private transcriptHistory: {
    segments: TranscriptSegment[]; // Legacy compatibility (en-US)
    languageSegments: Map<string, TranscriptSegment[]>; // Multi-language support
  } = {
    segments: [],
    languageSegments: new Map(),
  };

  // History Management Configuration
  private readonly HISTORY_RETENTION_MS = 30 * 60 * 1000; // 30 minutes
  private readonly HISTORY_PRUNE_INTERVAL_MS = 5 * 60 * 1000; // Prune every 5 minutes
  private historyPruneInterval?: NodeJS.Timeout;

  constructor(
    private userSession: UserSession,
    private config: TranscriptionConfig = DEFAULT_TRANSCRIPTION_CONFIG,
  ) {
    this.logger = userSession.logger.child({ service: "TranscriptionManager" });

    // Start initialization but don't block constructor
    this.initializationPromise = this.initializeProviders();
    this.startHealthMonitoring();
    this.startHistoryPruning();

    this.logger.info(
      {
        defaultProvider: this.config.providers.defaultProvider,
        fallbackProvider: this.config.providers.fallbackProvider,
      },
      "TranscriptionManager created - initializing providers...",
    );
  }

  // Local helper to normalize Node Buffer to ArrayBuffer
  private toArrayBuffer(input: ArrayBuffer | Buffer): ArrayBuffer {
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) {
      const buf = input as unknown as Buffer;
      const ab = new ArrayBuffer(buf.length);
      new Uint8Array(ab).set(buf);
      return ab;
    }
    return input as ArrayBuffer;
  }

  async handleLocalTranscription(message: LocalTranscription): Promise<void> {
    this.logger.debug({ message }, "Local transcription received");

    this.relayDataToApps(StreamType.TRANSCRIPTION, message);
  }
  /**
   * Update active subscriptions (main entry point)
   */
  async updateSubscriptions(
    subscriptions: ExtendedStreamType[],
  ): Promise<void> {
    // Ensure we're initialized before processing subscriptions
    await this.ensureInitialized();

    // Filter out translation subscriptions - they're handled by TranslationManager now
    const validSubscriptions = subscriptions.filter((sub) => {
      if (typeof sub === "string" && sub.startsWith("translation:")) {
        this.logger.debug(
          {
            subscription: sub,
          },
          "Filtering out translation subscription - handled by TranslationManager",
        );
        return false;
      }
      return true;
    });

    const desired = new Set(validSubscriptions);
    const current = new Set(this.streams.keys());

    this.logger.debug(
      {
        desired: Array.from(desired),
        current: Array.from(current),
        filtered: subscriptions.filter((s) => !validSubscriptions.includes(s)),
      },
      "Updating transcription subscriptions",
    );

    // Stop removed streams
    for (const subscription of current) {
      if (!desired.has(subscription)) {
        await this.stopStream(subscription);
      }
    }

    // Start new streams
    for (const subscription of desired) {
      if (!current.has(subscription)) {
        await this.startStream(subscription);
      }
    }

    this.activeSubscriptions = desired;
  }

  /**
   * Finalize pending tokens in all active streams (called when VAD stops)
   * This forces all providers to send final transcriptions for any buffered content
   */
  finalizePendingTokens(): void {
    this.logger.debug(
      {
        activeStreams: this.streams.size,
      },
      "Finalizing pending tokens in all streams due to VAD stop",
    );

    for (const [subscription, stream] of this.streams) {
      try {
        // Check if this is a Soniox stream with buffered tokens
        if (stream.provider.name === "soniox") {
          // Force finalize transcription tokens
          if ("forceFinalizePendingTokens" in stream) {
            (stream as any).forceFinalizePendingTokens();
          }
          this.logger.debug(
            {
              subscription,
              streamId: stream.id,
              provider: "soniox",
            },
            "Forced finalization of Soniox transcription tokens",
          );
        }
        // Azure doesn't need forced finalization as it sends final results immediately
        // Other providers can be added here as needed
      } catch (error) {
        this.logger.warn(
          {
            subscription,
            error,
            streamId: stream.id,
            provider: stream.provider.name,
          },
          "Error finalizing pending tokens",
        );
      }
    }
  }

  /**
   * Cleanup all idle streams (called when VAD detects silence)
   * This immediately closes all streams to free resources
   */
  async cleanupIdleStreams(): Promise<void> {
    this.logger.debug(
      {
        activeStreams: this.streams.size,
      },
      "Cleaning up idle streams due to VAD silence",
    );

    const closePromises: Promise<void>[] = [];

    for (const [subscription, stream] of this.streams) {
      try {
        closePromises.push(this.cleanupStream(subscription, "vad_silence"));
      } catch (error) {
        this.logger.warn(
          {
            subscription,
            error,
            streamId: stream.id,
            provider: stream.provider.name,
          },
          "Error initiating stream cleanup",
        );
      }
    }

    // Wait for all streams to close
    await Promise.allSettled(closePromises);

    // Clear the streams map
    this.streams.clear();

    this.logger.info("All idle streams cleaned up");
  }

  /**
   * Stop all transcription streams and finalize any pending tokens
   * This is the proper way to stop transcription when VAD detects silence
   */
  async stopAndFinalizeAll(): Promise<void> {
    try {
      this.logger.info(
        "Stopping all transcription streams and finalizing pending tokens",
      );

      // First finalize any pending tokens
      this.finalizePendingTokens();

      // Clear any VAD audio buffer (don't flush since VAD stopped)
      this.clearVADBuffer();

      // Then stop all streams
      await this.updateSubscriptions([]);
    } catch (error) {
      this.logger.error(
        error,
        "Error stopping and finalizing all transcription streams",
      );
    }
  }

  /**
   * Ensure streams match active subscriptions exactly
   * Removes unused streams and creates missing ones
   */
  async ensureStreamsExist(): Promise<void> {
    const currentSubscriptions = Array.from(this.activeSubscriptions);

    this.logger.info(
      {
        subscriptions: currentSubscriptions,
        existingStreams: this.streams.size,
        bufferSize: this.vadAudioBuffer.length,
      },
      "Ensuring streams match active subscriptions",
    );

    // Step 1: Clean up streams that no longer have subscriptions
    const streamsToCleanup: string[] = [];
    for (const [subscription, _stream] of this.streams.entries()) {
      if (!this.activeSubscriptions.has(subscription)) {
        streamsToCleanup.push(subscription);
      }
    }

    if (streamsToCleanup.length > 0) {
      this.logger.info(
        {
          streamsToCleanup,
          count: streamsToCleanup.length,
        },
        "Cleaning up streams with no active subscriptions",
      );

      for (const subscription of streamsToCleanup) {
        await this.cleanupStream(subscription, "subscription_removed");
      }
    }

    // Step 2: If no subscriptions, we're done
    if (currentSubscriptions.length === 0) {
      this.logger.info("No active subscriptions - all streams cleaned up");
      return;
    }

    // Step 3: Start buffering audio for any new streams we might create
    this.startVADBuffering();

    // Step 4: Create missing streams or replace unhealthy ones
    const createPromises: Promise<void>[] = [];

    for (const subscription of currentSubscriptions) {
      const existingStream = this.streams.get(subscription);

      if (existingStream && this.isStreamHealthy(existingStream)) {
        this.logger.debug(
          { subscription },
          "Stream already exists and is healthy - no action needed",
        );
        continue;
      }

      if (existingStream) {
        this.logger.info(
          { subscription },
          "Stream exists but is unhealthy - will create new stream",
        );
        await this.cleanupStream(subscription, "unhealthy_stream_replacement");
      }

      // Create new stream
      this.logger.info(
        { subscription },
        "Creating new stream for subscription",
      );
      createPromises.push(this.startStreamFast(subscription));
    }

    if (createPromises.length === 0) {
      this.logger.info("All required streams already exist and are healthy");
      this.flushVADBuffer();
      return;
    }

    // Wait for all new streams to be created
    const results = await Promise.allSettled(createPromises);

    // Count successful vs failed stream creations
    let successCount = 0;
    let failureCount = 0;

    results.forEach((result, _index) => {
      if (result.status === "rejected") {
        failureCount++;
        this.logger.error(
          {
            error: result.reason,
          },
          "Failed to create new stream",
        );
      } else {
        successCount++;
      }
    });

    this.logger.info(
      {
        totalSubscriptions: currentSubscriptions.length,
        streamsRemoved: streamsToCleanup.length,
        streamsCreated: createPromises.length,
        successCount,
        failureCount,
        activeStreams: this.streams.size,
      },
      "Stream synchronization completed",
    );

    // If all new streams failed, this is a critical issue
    if (failureCount === createPromises.length && createPromises.length > 0) {
      this.logger.error(
        {
          subscriptions: currentSubscriptions,
          failureCount,
        },
        "All new streams failed to create - transcription may be unavailable",
      );
    }

    // Flush buffered audio to streams and stop buffering
    this.flushVADBuffer();
  }

  /**
   * Check if we have healthy streams for all active subscriptions
   * and no extra streams for inactive subscriptions
   */
  hasHealthyStreams(): boolean {
    const currentSubscriptions = Array.from(this.activeSubscriptions);

    if (currentSubscriptions.length === 0) {
      return this.streams.size === 0; // No subscriptions = no streams should exist
    }

    // Check if all subscriptions have healthy streams
    for (const subscription of currentSubscriptions) {
      const stream = this.streams.get(subscription);
      if (!stream || !this.isStreamHealthy(stream)) {
        return false;
      }
    }

    // Check if we have any extra streams that shouldn't exist
    for (const subscription of this.streams.keys()) {
      if (!this.activeSubscriptions.has(subscription)) {
        return false; // We have a stream for an inactive subscription
      }
    }

    return true;
  }

  isCloudSTTDown(): boolean {
    const stats = this.providerSelector?.getProviderStats();
    if (!stats) {
      // Defaulting to true as we don't have any stats
      return true;
    }
    return Object.values(stats).every(
      (provider) => provider.isHealthy === false,
    );
  }

  /**
   * @deprecated Use ensureStreamsExist() instead
   */
  async restartFromActiveSubscriptions(): Promise<void> {
    this.logger.warn(
      "restartFromActiveSubscriptions is deprecated - use ensureStreamsExist",
    );
    await this.ensureStreamsExist();
  }

  /**
   * Start buffering audio for VAD scenarios
   */
  private startVADBuffering(): void {
    this.isBufferingForVAD = true;
    this.vadAudioBuffer = []; // Clear any old buffer

    // Set timeout to automatically flush buffer if VAD never completes
    this.vadBufferTimeout = setTimeout(() => {
      this.logger.warn(
        {
          bufferSize: this.vadAudioBuffer.length,
          timeoutMs: this.vadBufferTimeoutMs,
        },
        "VAD buffer timeout reached - force flushing buffer",
      );

      this.flushVADBuffer();
    }, this.vadBufferTimeoutMs);

    this.logger.debug(
      {
        timeoutMs: this.vadBufferTimeoutMs,
      },
      "Started VAD audio buffering to prevent speech loss during stream startup",
    );
  }

  /**
   * Flush buffered audio to all active streams
   */
  private flushVADBuffer(): void {
    // Clear timeout if it exists
    if (this.vadBufferTimeout) {
      clearTimeout(this.vadBufferTimeout);
      this.vadBufferTimeout = undefined;
    }

    if (!this.isBufferingForVAD || this.vadAudioBuffer.length === 0) {
      this.isBufferingForVAD = false;
      return;
    }

    this.logger.debug(
      {
        bufferSize: this.vadAudioBuffer.length,
        activeStreams: this.streams.size,
      },
      "Flushing VAD audio buffer to active streams",
    );

    // Send all buffered audio chunks to active streams
    for (const audioData of this.vadAudioBuffer) {
      this.feedAudioToStreams(audioData);
    }

    // Clear buffer and stop buffering
    this.vadAudioBuffer = [];
    this.isBufferingForVAD = false;
  }

  /**
   * Clear VAD buffer without flushing (called when VAD stops)
   */
  private clearVADBuffer(): void {
    // Clear timeout if it exists
    if (this.vadBufferTimeout) {
      clearTimeout(this.vadBufferTimeout);
      this.vadBufferTimeout = undefined;
    }

    this.vadAudioBuffer = [];
    this.isBufferingForVAD = false;
    this.logger.debug("Cleared VAD audio buffer");
  }

  /**
   * Fast stream startup optimized for VAD scenarios
   * Uses shorter timeout and skips some non-critical checks
   */
  private async startStreamFast(
    subscription: ExtendedStreamType,
  ): Promise<void> {
    // Use a longer timeout for VAD scenarios (5 seconds vs 2 seconds)
    // 2 seconds was too short and causing stream creation failures
    const VAD_TIMEOUT_MS = 5000;

    try {
      // Check if stream already exists and is healthy
      const existingStream = this.streams.get(subscription);
      if (existingStream && this.isStreamHealthy(existingStream)) {
        this.logger.debug(
          { subscription },
          "Stream already exists and healthy - no restart needed",
        );
        return;
      }

      // Use the regular startStream but with moderate timeout for VAD
      await this.startStreamWithTimeout(subscription, VAD_TIMEOUT_MS);
    } catch (error) {
      this.logger.error(
        {
          subscription,
          error,
          timeout: VAD_TIMEOUT_MS,
        },
        "Fast stream start failed - falling back to regular startup",
      );

      // Fallback to regular startup with full timeout
      try {
        await this.startStream(subscription);
      } catch (fallbackError) {
        this.logger.error(
          {
            subscription,
            error: fallbackError,
          },
          "Regular stream start also failed",
        );
      }
    }
  }

  /**
   * Start stream with custom timeout
   */
  private async startStreamWithTimeout(
    subscription: ExtendedStreamType,
    timeoutMs: number,
  ): Promise<void> {
    this.logger.debug(
      {
        subscription,
        timeoutMs,
      },
      `Starting stream with custom timeout for user: ${this.userSession.userId}, subscription: ${subscription} (${timeoutMs}ms)`,
    );
    // Ensure we're initialized before starting streams
    await this.ensureInitialized();
    this.logger.debug(
      "TranscriptionManager is initialized, proceeding with stream start",
    );

    // Check if there's already a creation in progress - if so, wait for it
    const existingCreation = this.streamCreationPromises.get(subscription);
    if (existingCreation) {
      this.logger.debug(
        { subscription },
        "Stream creation already in progress, waiting for existing creation",
      );
      await existingCreation;
      return;
    }

    // Check existing stream
    const existingStream = this.streams.get(subscription);
    if (existingStream && this.isStreamHealthy(existingStream)) {
      this.logger.debug({ subscription }, "Stream already exists and healthy");
      return;
    }

    // Clean up any existing stream
    if (existingStream) {
      await this.cleanupStream(subscription, "replacing_stream");
    }

    // Create the actual creation promise and store it
    const creationPromise = this._performStreamCreation(
      subscription,
      timeoutMs,
    );
    this.streamCreationPromises.set(subscription, creationPromise);

    try {
      await creationPromise;
    } finally {
      this.streamCreationPromises.delete(subscription);
    }
  }

  /**
   * Internal method to perform actual stream creation
   */
  private async _performStreamCreation(
    subscription: ExtendedStreamType,
    timeoutMs: number,
  ): Promise<void> {
    try {
      // Provider selector should be initialized now
      if (!this.providerSelector) {
        throw new Error(
          "TranscriptionManager initialization failed - no provider selector",
        );
      }

      // Validate subscription (cached after first validation)
      const validation = await this.providerSelector.validateSubscription(
        subscription,
      );
      if (!validation.valid) {
        throw new InvalidSubscriptionError(
          validation.error!,
          subscription,
          validation.suggestions,
        );
      }

      // Skip resource limits check for VAD scenarios - we need speed
      // await this.checkResourceLimits();

      // Select provider (prioritize Soniox for VAD scenarios)
      const provider = await this.providerSelector.selectProvider(subscription);

      // Create stream
      const stream = await this.createStreamInstance(subscription, provider);

      // Wait for ready with custom timeout
      await this.waitForStreamReady(stream, timeoutMs);

      // Success!
      this.streams.set(subscription, stream);

      this.logger.info(
        {
          subscription,
          provider: provider.name,
          streamId: stream.id,
          timeoutUsed: timeoutMs,
        },
        "Stream started successfully with fast startup",
      );
    } catch (error) {
      this.logger.error(
        {
          subscription,
          error,
          timeoutUsed: timeoutMs,
        },
        "Failed to start stream with custom timeout",
      );
      throw error;
    }
  }

  /**
   * Feed audio to all active streams
   */
  feedAudio(audioData: ArrayBuffer | Buffer): void {
    // If we're buffering for VAD, add to buffer
    if (this.isBufferingForVAD) {
      this.vadAudioBuffer.push(this.toArrayBuffer(audioData));

      // Prevent buffer from growing too large
      if (this.vadAudioBuffer.length > this.vadBufferMaxSize) {
        this.vadAudioBuffer.shift(); // Remove oldest chunk
      }

      this.logger.debug(
        {
          bufferSize: this.vadAudioBuffer.length,
          maxSize: this.vadBufferMaxSize,
        },
        "Buffering audio for VAD startup",
      );
      return;
    }

    // Normal audio feeding
    this.feedAudioToStreams(audioData);
  }

  /**
   * Internal method to feed audio directly to streams
   */
  private feedAudioToStreams(audioData: ArrayBuffer | Buffer): void {
    // Don't feed audio if not initialized - just silently drop it
    if (!this.isInitialized || this.streams.size === 0) {
      return;
    }

    const normalized = this.toArrayBuffer(audioData);
    for (const [subscription, stream] of this.streams) {
      try {
        stream.writeAudio(normalized);
      } catch (error) {
        this.logger.warn(
          {
            subscription,
            error,
            streamId: stream.id,
          },
          "Error feeding audio to stream",
        );
      }
    }
  }

  /**
   * Get current stream metrics
   */
  getMetrics(): Record<string, any> {
    const metrics: Record<string, any> = {
      totalStreams: this.streams.size,
      activeStreams: 0,
      byProvider: {} as Record<string, any>,
      byState: {} as Record<string, number>,
      latency: {
        maxTranscriptLagMs: 0,
        avgTranscriptLagMs: 0,
        totalLagWarnings: 0,
      },
      backlog: {
        totalAudioBytesSent: 0,
        totalTranscriptEndMs: 0,
        processingDeficitMs: 0,
      },
    };

    let totalLag = 0;
    let lagCount = 0;

    // Count by provider and state
    for (const stream of this.streams.values()) {
      // By provider
      const providerName = stream.provider.name;
      if (!metrics.byProvider[providerName]) {
        metrics.byProvider[providerName] = 0;
      }
      metrics.byProvider[providerName]++;

      // By state
      if (!metrics.byState[stream.state]) {
        metrics.byState[stream.state] = 0;
      }
      metrics.byState[stream.state]++;

      // Active count
      if (
        stream.state === StreamState.READY ||
        stream.state === StreamState.ACTIVE
      ) {
        metrics.activeStreams++;
      }

      // Aggregate latency metrics
      if (stream.metrics.lastTranscriptLagMs) {
        totalLag += stream.metrics.lastTranscriptLagMs;
        lagCount++;
      }
      if (
        stream.metrics.maxTranscriptLagMs &&
        stream.metrics.maxTranscriptLagMs > metrics.latency.maxTranscriptLagMs
      ) {
        metrics.latency.maxTranscriptLagMs = stream.metrics.maxTranscriptLagMs;
      }
      if (stream.metrics.transcriptLagWarnings) {
        metrics.latency.totalLagWarnings +=
          stream.metrics.transcriptLagWarnings;
      }

      // Aggregate backlog metrics
      if (stream.metrics.totalAudioBytesSent) {
        metrics.backlog.totalAudioBytesSent +=
          stream.metrics.totalAudioBytesSent;
      }
      if (stream.metrics.lastTranscriptEndMs) {
        metrics.backlog.totalTranscriptEndMs = Math.max(
          metrics.backlog.totalTranscriptEndMs,
          stream.metrics.lastTranscriptEndMs,
        );
      }
    }

    // Calculate average lag
    if (lagCount > 0) {
      metrics.latency.avgTranscriptLagMs = Math.round(totalLag / lagCount);
    }

    // Calculate processing deficit
    if (metrics.backlog.totalAudioBytesSent > 0) {
      const audioSentDurationMs = metrics.backlog.totalAudioBytesSent / 32; // 16kHz * 2 bytes
      metrics.backlog.processingDeficitMs = Math.round(
        audioSentDurationMs - metrics.backlog.totalTranscriptEndMs,
      );
    }

    return metrics;
  }

  /**
   * Dispose of the manager and cleanup resources
   */
  async dispose(): Promise<void> {
    this.logger.info("Disposing TranscriptionManager");

    // Stop health monitoring
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Close all streams
    const closePromises = Array.from(this.streams.values()).map((stream) =>
      stream
        .close()
        .catch((error) =>
          this.logger.warn(
            { error, streamId: stream.id },
            "Error closing stream during disposal",
          ),
        ),
    );

    await Promise.allSettled(closePromises);
    this.streams.clear();

    // Dispose providers
    const providerDisposePromises = Array.from(this.providers.values()).map(
      (provider) =>
        provider
          .dispose()
          .catch((error) =>
            this.logger.warn(
              { error, provider: provider.name },
              "Error disposing provider",
            ),
          ),
    );

    await Promise.allSettled(providerDisposePromises);
    this.providers.clear();

    // Call cleanup method asynchronously but don't wait for it
    // to match the synchronous dispose pattern of other managers
    await this.cleanup();

    this.logger.info("TranscriptionManager disposed");
  }

  /**
   * Memory stats used by MemoryTelemetryService
   */
  public getMemoryStats(): {
    vadBufferChunks: number;
    vadBufferBytes: number;
    transcriptLanguages: number;
    transcriptSegments: number;
  } {
    const vadBufferChunks = this.vadAudioBuffer.length;
    let vadBufferBytes = 0;
    for (const chunk of this.vadAudioBuffer) {
      if (typeof Buffer !== "undefined" && Buffer.isBuffer(chunk)) {
        vadBufferBytes += (chunk as unknown as Buffer).length;
      } else if (chunk instanceof ArrayBuffer) {
        vadBufferBytes += chunk.byteLength;
      } else if (ArrayBuffer.isView(chunk)) {
        vadBufferBytes += (chunk as ArrayBufferView).byteLength;
      }
    }

    // Count transcript segments across languages
    const transcriptLanguages =
      this.transcriptHistory.languageSegments.size +
      (this.transcriptHistory.segments.length > 0 &&
      !this.transcriptHistory.languageSegments.has("en-US")
        ? 1
        : 0);
    const transcriptSegments =
      this.transcriptHistory.segments.length +
      Array.from(this.transcriptHistory.languageSegments.values()).reduce(
        (sum, arr) => sum + arr.length,
        0,
      );

    return {
      vadBufferChunks,
      vadBufferBytes,
      transcriptLanguages,
      transcriptSegments,
    };
  }

  // ===== PRIVATE METHODS =====

  /**
   * Ensure manager is fully initialized before proceeding
   */
  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    this.logger.debug("Waiting for TranscriptionManager initialization...");
    await this.initializationPromise;

    if (!this.isInitialized) {
      throw new Error("TranscriptionManager initialization failed");
    }
  }

  /**
   * Process any operations that were queued while initializing
   */
  private async processPendingOperations(): Promise<void> {
    if (this.pendingOperations.length === 0) {
      return;
    }

    this.logger.info(
      {
        pendingOperations: this.pendingOperations.length,
      },
      "Processing pending operations after initialization",
    );

    const operations = this.pendingOperations.slice();
    this.pendingOperations = [];

    for (const operation of operations) {
      try {
        await operation();
      } catch (error) {
        this.logger.error(error, "Error processing pending operation");
      }
    }
  }

  private async initializeProviders(): Promise<void> {
    try {
      this.logger.info("Starting provider initialization...");

      const availableProviders: ProviderType[] = [];
      const providerErrors: Array<{ provider: string; error: Error }> = [];

      // try to initialize Alibaba provider
      try {
        if (this.IS_CHINA) {
          const alibabaProvider = new AlibabaTranscriptionProvider(
            this.config.alibaba,
            this.logger,
          );
          await alibabaProvider.initialize();
          this.providers.set(ProviderType.ALIBABA, alibabaProvider);
          availableProviders.push(ProviderType.ALIBABA);
          this.logger.info("Alibaba provider initialized successfully");
        } else {
          this.logger.info("Alibaba provider not initialized for non-China");
        }
      } catch (error) {
        this.logger.error(error, "Failed to initialize Alibaba provider");
        providerErrors.push({ provider: "Alibaba", error: error as Error });
      }

      // Try to initialize Azure provider
      try {
        if (this.IS_CHINA) {
          this.logger.info("Azure provider not initialized for China");
        } else {
          const azureProvider = new AzureTranscriptionProvider(
            this.config.azure,
            this.logger,
          );
          await azureProvider.initialize();
          this.providers.set(ProviderType.AZURE, azureProvider);
          availableProviders.push(ProviderType.AZURE);
          this.logger.info("Azure provider initialized successfully");
        }
      } catch (error) {
        this.logger.error(error, "Failed to initialize Azure provider");
        providerErrors.push({ provider: "Azure", error: error as Error });
      }

      // Try to initialize Soniox provider
      try {
        if (this.IS_CHINA) {
          this.logger.info("Soniox provider not initialized for China");
        } else {
          const sonioxProvider = new SonioxTranscriptionProvider(
            this.config.soniox,
            this.logger,
          );
          await sonioxProvider.initialize();
          this.providers.set(ProviderType.SONIOX, sonioxProvider);
          availableProviders.push(ProviderType.SONIOX);
          this.logger.info("Soniox provider initialized successfully");
        }
      } catch (error) {
        this.logger.error(error, "Failed to initialize Soniox provider");
        providerErrors.push({ provider: "Soniox", error: error as Error });
      }

      // Check if we have at least one provider
      if (this.providers.size === 0) {
        const errorMsg = `No transcription providers available. Errors: ${providerErrors
          .map((e) => `${e.provider}: ${e.error.message}`)
          .join(", ")}`;
        this.logger.error(
          {
            providerErrors,
            config: {
              azureHasKey: !!this.config.azure.key,
              azureRegion: this.config.azure.region,
              sonioxHasKey: !!this.config.soniox.apiKey,
              sonioxEndpoint: this.config.soniox.endpoint,
            },
          },
          errorMsg,
        );
        throw new Error(errorMsg);
      }

      // Initialize provider selector with available providers
      this.providerSelector = new ProviderSelector(
        this.providers,
        this.config,
        this.logger,
      );

      // Mark as initialized
      this.isInitialized = true;

      this.logger.info(
        {
          availableProviders,
          totalProviders: this.providers.size,
          skippedProviders: providerErrors.length,
        },
        "Provider initialization completed",
      );

      if (providerErrors.length > 0) {
        this.logger.warn(
          {
            providerErrors: providerErrors.map((e) => ({
              provider: e.provider,
              error: e.error.message,
            })),
          },
          "Some providers failed to initialize but system will continue with available providers",
        );
      }

      // Process any pending operations
      await this.processPendingOperations();
    } catch (error) {
      this.logger.error(
        { error },
        "Critical failure in provider initialization",
      );
      throw error;
    }
  }

  private async startStream(subscription: ExtendedStreamType): Promise<void> {
    // Ensure we're initialized before starting streams
    await this.ensureInitialized();

    // Check if there's already a creation in progress - if so, wait for it
    const existingCreation = this.streamCreationPromises.get(subscription);
    if (existingCreation) {
      this.logger.debug(
        { subscription },
        "Stream creation already in progress, waiting for existing creation",
      );
      await existingCreation;
      return;
    }

    // Check existing stream
    const existingStream = this.streams.get(subscription);
    if (existingStream && this.isStreamHealthy(existingStream)) {
      this.logger.debug({ subscription }, "Stream already exists and healthy");
      return;
    }

    // Clean up any existing stream
    if (existingStream) {
      await this.cleanupStream(subscription, "replacing_stream");
    }

    // Create the actual creation promise and store it
    const creationPromise =
      this._performStreamCreationForStartStream(subscription);
    this.streamCreationPromises.set(subscription, creationPromise);

    try {
      await creationPromise;
    } finally {
      this.streamCreationPromises.delete(subscription);
    }
  }

  /**
   * Internal method to perform actual stream creation for startStream
   */
  private async _performStreamCreationForStartStream(
    subscription: ExtendedStreamType,
  ): Promise<void> {
    try {
      // Provider selector should be initialized now
      if (!this.providerSelector) {
        throw new Error(
          "TranscriptionManager initialization failed - no provider selector",
        );
      }

      // Validate subscription
      const validation = await this.providerSelector.validateSubscription(
        subscription,
      );
      if (!validation.valid) {
        throw new InvalidSubscriptionError(
          validation.error!,
          subscription,
          validation.suggestions,
        );
      }

      // Check resource limits
      await this.checkResourceLimits();

      // Select provider
      const provider = await this.providerSelector.selectProvider(subscription);

      // Create stream
      const stream = await this.createStreamInstance(subscription, provider);

      // Wait for ready (with timeout)
      await this.waitForStreamReady(
        stream,
        this.config.performance.streamTimeoutMs,
      );

      // Success!
      this.streams.set(subscription, stream);

      this.logger.info(
        {
          subscription,
          provider: provider.name,
          streamId: stream.id,
          initTime: stream.metrics.initializationTime,
        },
        `🚀 STREAM CREATED: [${provider.name.toUpperCase()}] for "${subscription}" (${
          stream.metrics.initializationTime
        }ms)`,
      );

      // Track success
      PosthogService.trackEvent(
        "transcription_stream_created",
        this.userSession.userId,
        {
          subscription,
          provider: provider.name,
          sessionId: this.userSession.sessionId,
        },
      );
    } catch (error) {
      const logger = this.logger.child({ subscription });
      logger.error(error, "Stream creation failed");
      await this.handleStreamError(subscription, null, error as Error);
      throw error;
    }
  }

  private async stopStream(subscription: ExtendedStreamType): Promise<void> {
    const stream = this.streams.get(subscription);
    if (stream) {
      this.logger.info(
        { subscription, streamId: stream.id },
        "Stopping stream",
      );

      try {
        await stream.close();
      } catch (error) {
        this.logger.warn({ error, subscription }, "Error stopping stream");
      }

      this.streams.delete(subscription);
      this.streamRetryAttempts.delete(subscription);
    }
  }

  private async createStreamInstance(
    subscription: ExtendedStreamType,
    provider: TranscriptionProvider,
  ): Promise<StreamInstance> {
    const languageInfo = getLanguageInfo(subscription)!;
    const streamId = this.generateStreamId(subscription);

    const callbacks = this.createStreamCallbacks(subscription);

    const options = {
      streamId,
      userSession: this.userSession,
      subscription,
      callbacks,
    };

    // Only create transcription streams
    return await provider.createTranscriptionStream(
      languageInfo.transcribeLanguage,
      options,
    );
  }

  private createStreamCallbacks(subscription: ExtendedStreamType) {
    return {
      onReady: () => {
        this.logger.debug({ subscription }, "Stream ready");
      },

      onError: (error: Error) => {
        const stream = this.streams.get(subscription);
        if (stream) {
          this.handleStreamError(subscription, stream, error);
        }
      },

      onClosed: () => {
        this.logger.info({ subscription }, "Stream closed by provider");
        this.streams.delete(subscription);
      },

      onData: (data: any) => {
        // Relay to apps that are subscribed (async but don't await to avoid blocking)
        this.relayDataToApps(subscription, data).catch((error) => {
          this.logger.error(
            { error, subscription, data },
            "Error in async relayDataToApps",
          );
        });
      },
    };
  }

  private async handleStreamError(
    subscription: ExtendedStreamType,
    stream: StreamInstance | null,
    error: Error,
  ): Promise<void> {
    const currentProvider = stream?.provider.name;

    this.logger.warn(
      {
        subscription,
        error: error.message,
        provider: currentProvider,
      },
      "Stream error occurred",
    );

    // Record provider failure
    if (stream) {
      stream.provider.recordFailure(error);
    }

    // Clean up failed stream
    await this.cleanupStream(subscription, "provider_error");

    // Implement smarter provider cycling logic
    const attempts = this.streamRetryAttempts.get(subscription) || 0;

    if (attempts >= this.config.retries.maxStreamRetries) {
      this.logger.error(
        { subscription, attempts },
        "Maximum retry attempts reached",
      );
      this.streamRetryAttempts.delete(subscription);

      // Track final failure
      PosthogService.trackEvent(
        "transcription_stream_permanent_failure",
        this.userSession.userId,
        {
          subscription,
          totalAttempts: attempts,
          finalError: error.message,
          sessionId: this.userSession.sessionId,
        },
      );
      return;
    }

    // Smart provider cycling based on error type and current provider
    if (currentProvider === ProviderType.SONIOX) {
      // Soniox failed - check if we should retry Soniox or immediately switch to Azure
      if (this.isSonioxRateLimit(error)) {
        // Rate limit - immediately try Azure
        this.logger.info(
          { subscription, error: error.message },
          "Soniox rate limit detected - falling back to Azure immediately",
        );
        if (await this.trySpecificProvider(subscription, ProviderType.AZURE)) {
          return; // Success with Azure
        }
      } else if (this.isRetryableError(error)) {
        // Other retryable Soniox errors - retry Soniox first
        this.logger.info(
          { subscription, error: error.message },
          "Retrying Soniox for retryable error",
        );
        this.scheduleStreamRetry(subscription, attempts + 1, error);
        return;
      }

      // If we reach here, either:
      // 1. Rate limit and Azure failed, OR
      // 2. Non-retryable Soniox error
      // Try Azure as fallback
      this.logger.info(
        { subscription },
        "Trying Azure as fallback after Soniox failure",
      );
      if (await this.trySpecificProvider(subscription, ProviderType.AZURE)) {
        return; // Success with Azure
      }
    } else if (currentProvider === ProviderType.AZURE) {
      // Azure failed - cycle back to Soniox since it's preferred
      this.logger.info(
        { subscription },
        "Azure failed - cycling back to preferred Soniox provider",
      );
      if (await this.trySpecificProvider(subscription, ProviderType.SONIOX)) {
        return; // Success with Soniox
      }
    }

    // If we reach here, both providers have been tried and failed
    // Try one more retry with the same provider if it's retryable
    if (this.isRetryableError(error)) {
      this.logger.info(
        { subscription, currentProvider },
        "Final retry attempt with current provider",
      );
      this.scheduleStreamRetry(subscription, attempts + 1, error);
    } else {
      this.logger.error(
        { subscription, currentProvider },
        "Non-retryable error - giving up",
      );
      this.streamRetryAttempts.delete(subscription);

      // Track final failure
      PosthogService.trackEvent(
        "transcription_stream_permanent_failure",
        this.userSession.userId,
        {
          subscription,
          totalAttempts: attempts,
          finalError: error.message,
          sessionId: this.userSession.sessionId,
        },
      );
    }
  }

  private async tryDifferentProvider(
    subscription: ExtendedStreamType,
    failedProvider: ProviderType,
  ): Promise<boolean> {
    try {
      // Ensure we're initialized before trying different provider
      await this.ensureInitialized();

      // Provider selector should be initialized now
      if (!this.providerSelector) {
        this.logger.warn(
          "Provider selector not initialized after ensureInitialized, cannot failover",
        );
        return false;
      }

      // Select alternative provider (excluding the failed one)
      const newProvider = await this.providerSelector.selectProvider(
        subscription,
        {
          excludeProviders: [failedProvider],
        },
      );

      this.logger.info(
        {
          subscription,
          fromProvider: failedProvider,
          toProvider: newProvider.name,
        },
        "Attempting provider failover",
      );

      // Create stream with new provider
      const stream = await this.createStreamInstance(subscription, newProvider);
      await this.waitForStreamReady(
        stream,
        this.config.performance.streamTimeoutMs,
      );

      // Success!
      this.streams.set(subscription, stream);

      this.logger.info(
        {
          subscription,
          fromProvider: failedProvider,
          toProvider: newProvider.name,
        },
        "Provider failover successful",
      );

      // Track successful failover
      PosthogService.trackEvent(
        "transcription_provider_failover",
        this.userSession.userId,
        {
          fromProvider: failedProvider,
          toProvider: newProvider.name,
          subscription,
          sessionId: this.userSession.sessionId,
        },
      );

      return true;
    } catch (error) {
      this.logger.warn(
        {
          subscription,
          failedProvider,
          error,
        },
        "Provider failover failed",
      );

      return false;
    }
  }

  /**
   * Try to create a stream with a specific provider
   * Used for smart provider cycling
   */
  private async trySpecificProvider(
    subscription: ExtendedStreamType,
    targetProvider: ProviderType,
  ): Promise<boolean> {
    try {
      // Ensure we're initialized
      await this.ensureInitialized();

      // Check if the target provider is available
      const provider = this.providers.get(targetProvider);
      if (!provider) {
        this.logger.warn(
          {
            subscription,
            targetProvider,
          },
          "Target provider not available",
        );
        return false;
      }

      this.logger.info(
        {
          subscription,
          targetProvider,
        },
        "Attempting to create stream with specific provider",
      );

      // Create stream with the specific provider
      const stream = await this.createStreamInstance(subscription, provider);
      await this.waitForStreamReady(
        stream,
        this.config.performance.streamTimeoutMs,
      );

      // Success!
      this.streams.set(subscription, stream);

      this.logger.info(
        {
          subscription,
          provider: targetProvider,
        },
        "Successfully created stream with specific provider",
      );

      // Track successful provider selection
      PosthogService.trackEvent(
        "transcription_provider_specific_success",
        this.userSession.userId,
        {
          provider: targetProvider,
          subscription,
          sessionId: this.userSession.sessionId,
        },
      );

      return true;
    } catch (error) {
      this.logger.warn(
        {
          subscription,
          targetProvider,
          error,
        },
        "Failed to create stream with specific provider",
      );

      return false;
    }
  }

  /**
   * Check if a Soniox error is specifically a rate limit error (429)
   */
  private isSonioxRateLimit(error: Error): boolean {
    if (!error.message.includes("Soniox error")) {
      return false;
    }

    const errorCodeMatch = error.message.match(/Soniox error (\d+):/);
    if (errorCodeMatch) {
      const errorCode = parseInt(errorCodeMatch[1]);
      return errorCode === 429;
    }

    return false;
  }

  private scheduleStreamRetry(
    subscription: ExtendedStreamType,
    attempt: number,
    lastError?: Error,
  ): void {
    this.streamRetryAttempts.set(subscription, attempt);

    // Calculate delay with exponential backoff for Soniox rate limiting
    let delay = this.config.retries.retryDelayMs * attempt; // Base linear backoff

    if (lastError && lastError.message.includes("Soniox error")) {
      const errorCodeMatch = lastError.message.match(/Soniox error (\d+):/);
      if (errorCodeMatch) {
        const errorCode = parseInt(errorCodeMatch[1]);

        // Use exponential backoff for rate limits (429)
        if (errorCode === 429) {
          delay = Math.min(
            this.config.retries.retryDelayMs * Math.pow(2, attempt - 1),
            60000,
          ); // Cap at 1 minute
          this.logger.warn(
            {
              subscription,
              attempt,
              delay,
              errorCode,
            },
            "Using exponential backoff for Soniox rate limit",
          );
        }

        // Use longer delay for server errors (5xx)
        else if (errorCode >= 500) {
          delay = this.config.retries.retryDelayMs * attempt * 2; // Double the linear delay
          this.logger.warn(
            {
              subscription,
              attempt,
              delay,
              errorCode,
            },
            "Using extended delay for Soniox server error",
          );
        }
      }
    }

    this.logger.info(
      {
        subscription,
        attempt,
        delay,
        errorType: lastError?.message.includes("Soniox") ? "soniox" : "general",
      },
      "Scheduling stream retry",
    );

    setTimeout(async () => {
      try {
        await this.startStream(subscription);
        this.streamRetryAttempts.delete(subscription); // Success

        this.logger.info({ subscription, attempt }, "Stream retry successful");
      } catch (error) {
        // Will trigger another retry cycle if attempts remaining
        this.logger.warn(
          { subscription, attempt, error },
          "Stream retry failed",
        );
      }
    }, delay);
  }

  private isRetryableError(error: Error): boolean {
    // Don't retry certain errors
    if (
      error instanceof InvalidSubscriptionError ||
      error instanceof NoProviderAvailableError ||
      error instanceof ResourceLimitError
    ) {
      return false;
    }

    // Soniox-specific error handling
    if (error.message.includes("Soniox error")) {
      // Extract error code if available
      const errorCodeMatch = error.message.match(/Soniox error (\d+):/);
      if (errorCodeMatch) {
        const errorCode = parseInt(errorCodeMatch[1]);

        // Don't retry authentication/authorization errors (typically 401, 403)
        if (errorCode === 401 || errorCode === 403) {
          this.logger.warn(
            { errorCode, message: error.message },
            "Soniox authentication error - not retrying",
          );
          return false;
        }

        // Retry 400 error (usually just timed out if the stream reaches 65 minutes. on soniox)
        if (errorCode === 400) {
          this.logger.warn(
            { errorCode, message: error.message },
            "Soniox error - retrying",
          );
          return true;
        }

        // Don't retry client errors (4xx range except rate limits and timeouts)
        if (
          errorCode >= 400 &&
          errorCode < 500 &&
          errorCode !== 429 &&
          errorCode !== 408
        ) {
          this.logger.warn(
            { errorCode, message: error.message },
            "Soniox client error - not retrying",
          );
          return false;
        }

        // Retry rate limits (429), timeouts (408), and server errors (5xx range)
        if (errorCode === 429 || errorCode === 408 || errorCode >= 500) {
          this.logger.info(
            { errorCode, message: error.message },
            "Soniox retryable error detected",
          );
          return true;
        }
      }

      // For Soniox errors without clear error codes, be more conservative and retry
      // This handles connection issues, network problems, etc.
      return true;
    }

    // Network/connection errors are generally retryable
    if (
      error.message.includes("ECONNRESET") ||
      error.message.includes("ENOTFOUND") ||
      error.message.includes("ETIMEDOUT") ||
      error.message.includes("WebSocket") ||
      error.message.includes("connection")
    ) {
      return true;
    }

    // Default to retryable for provider errors
    return true;
  }

  private async waitForStreamReady(
    stream: StreamInstance,
    timeoutMs: number,
  ): Promise<void> {
    const startTime = Date.now();

    while (
      stream.state === StreamState.INITIALIZING &&
      Date.now() - startTime < timeoutMs
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (stream.state === StreamState.INITIALIZING) {
      throw new StreamCreationTimeoutError("Stream initialization timeout");
    }

    if (stream.state === StreamState.ERROR) {
      throw new StreamInitializationError("Stream initialization failed", {
        error: stream.lastError,
        streamId: stream.id,
      });
    }

    if (stream.state !== StreamState.READY) {
      throw new StreamInitializationError(
        `Stream in unexpected state: ${stream.state}`,
      );
    }
  }

  private async cleanupStream(
    subscription: ExtendedStreamType,
    reason: string,
  ): Promise<void> {
    const stream = this.streams.get(subscription);
    if (stream) {
      this.logger.debug({ subscription, reason }, "Cleaning up stream");

      try {
        await stream.close();
      } catch (error) {
        this.logger.warn(
          { error, subscription },
          "Error closing stream during cleanup",
        );
      }

      this.streams.delete(subscription);
    }
  }

  private async checkResourceLimits(): Promise<void> {
    // Check total stream limit
    if (this.streams.size >= this.config.performance.maxTotalStreams) {
      throw new ResourceLimitError(
        `Maximum stream limit reached: ${this.streams.size}/${this.config.performance.maxTotalStreams}`,
        "total_streams",
      );
    }

    // Check memory usage
    const memoryUsage = process.memoryUsage();
    const memoryThreshold =
      this.config.performance.maxMemoryUsageMB * 1024 * 1024;

    if (memoryUsage.heapUsed > memoryThreshold) {
      this.logger.warn({ memoryUsage }, "High memory usage detected");
      await this.cleanupIdleStreams();
    }
  }

  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(() => {
      this.cleanupDeadStreams();
      this.logLatencyMetrics();
    }, this.config.performance.healthCheckIntervalMs);
  }

  /**
   * Log latency and backlog metrics for monitoring
   */
  private logLatencyMetrics(): void {
    const metrics = this.getMetrics();

    // Only log if we have active streams
    if (metrics.activeStreams === 0) {
      return;
    }

    // Log summary of latency metrics
    if (metrics.latency.avgTranscriptLagMs > 0) {
      const logLevel =
        metrics.latency.maxTranscriptLagMs > 5000 ? "warn" : "info";
      const logData = {
        activeStreams: metrics.activeStreams,
        avgLagMs: metrics.latency.avgTranscriptLagMs,
        maxLagMs: metrics.latency.maxTranscriptLagMs,
        lagWarnings: metrics.latency.totalLagWarnings,
        processingDeficitMs: metrics.backlog.processingDeficitMs,
        audioSentBytes: metrics.backlog.totalAudioBytesSent,
        transcriptEndMs: metrics.backlog.totalTranscriptEndMs,
      };

      if (logLevel === "warn") {
        this.logger.warn(
          logData,
          "⚠️ HIGH LATENCY: Transcription is significantly lagging",
        );
      } else {
        this.logger.debug(logData, "Transcription latency metrics");
      }
    }

    // Alert if processing deficit is high (audio sent but not transcribed)
    if (metrics.backlog.processingDeficitMs > 10000) {
      this.logger.warn(
        {
          deficitMs: metrics.backlog.processingDeficitMs,
          audioSentBytes: metrics.backlog.totalAudioBytesSent,
          transcriptEndMs: metrics.backlog.totalTranscriptEndMs,
        },
        "⚠️ PROCESSING BACKLOG: Provider is falling behind on transcription",
      );
    }
  }

  private async cleanupDeadStreams(): Promise<void> {
    const now = Date.now();
    const deadStreams: [string, StreamInstance][] = [];

    for (const [subscription, stream] of this.streams) {
      const timeSinceActivity = now - stream.lastActivity;

      // Stream is dead if:
      // - No activity for 5 minutes
      // - State is ERROR or CLOSED
      // - Too many consecutive failures
      const isDead =
        timeSinceActivity > 300000 || // 5 minutes
        stream.state === StreamState.ERROR ||
        stream.state === StreamState.CLOSED ||
        stream.metrics.consecutiveFailures >= 10;

      if (isDead) {
        deadStreams.push([subscription, stream]);
      }
    }

    // Clean up dead streams
    for (const [subscription, stream] of deadStreams) {
      this.logger.info(
        {
          subscription,
          streamId: stream.id,
          reason: "dead_stream_cleanup",
        },
        "Cleaning up dead stream",
      );

      await this.cleanupStream(subscription, "dead_stream_cleanup");
    }
  }

  private isStreamHealthy(stream: StreamInstance): boolean {
    return (
      stream.state === StreamState.READY ||
      stream.state === StreamState.ACTIVE ||
      stream.state === StreamState.INITIALIZING
    );
  }

  private generateStreamId(subscription: ExtendedStreamType): string {
    return `${
      this.userSession.sessionId
    }-${subscription}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get the target subscriptions for routing data
   * Now simplified since there's no optimization mapping
   */
  private getTargetSubscriptions(
    streamSubscription: ExtendedStreamType,
    effectiveSubscription: ExtendedStreamType,
  ): ExtendedStreamType[] {
    // Simply return the effective subscription
    return [effectiveSubscription];
  }

  private async relayDataToApps(
    subscription: ExtendedStreamType,
    data: any,
  ): Promise<void> {
    try {
      // CONSTRUCT EFFECTIVE SUBSCRIPTION like the old system
      let streamType = data.type;

      if (data.type === "local_transcription") {
        streamType = StreamType.TRANSCRIPTION;
      }

      let effectiveSubscription: ExtendedStreamType = streamType;

      // Handle transcription subscription construction
      if (streamType === StreamType.TRANSCRIPTION && data.transcribeLanguage) {
        effectiveSubscription = `${streamType}:${data.transcribeLanguage}`;
      } else if (streamType === StreamType.TRANSCRIPTION) {
        effectiveSubscription = `${streamType}:en-US`; // Default fallback
      }

      // Add to transcript history before relaying to apps
      this.addToTranscriptHistory(data, streamType);

      // Handle optimized subscription routing
      const targetSubscriptions = this.getTargetSubscriptions(
        subscription,
        effectiveSubscription,
      );
      const allSubscribedApps = new Set<string>();

      // Get subscribed apps for all target subscriptions
      for (const targetSub of targetSubscriptions) {
        const subscribedApps =
          this.userSession.subscriptionManager.getSubscribedApps(targetSub);
        subscribedApps.forEach((app) => allSubscribedApps.add(app));
      }

      const subscribedApps = Array.from(allSubscribedApps);

      this.logger.debug(
        {
          subscription,
          effectiveSubscription,
          targetSubscriptions,
          subscribedApps,
          streamType,
          dataType: data.type,
          transcribeLanguage: data.transcribeLanguage,
        },
        "Broadcasting transcription data",
      );

      // Send to each app using APP MANAGER (with resurrection) instead of direct WebSocket
      for (const packageName of subscribedApps) {
        const appSessionId = `${this.userSession.sessionId}-${packageName}`;

        const dataStream: DataStream = {
          type: CloudToAppMessageType.DATA_STREAM,
          sessionId: appSessionId,
          streamType: subscription as ExtendedStreamType, // Base type remains the same in the message
          data, // The data now may contain language info
          timestamp: new Date(),
        };

        try {
          // USE APP MANAGER instead of direct WebSocket (restores resurrection)
          const result = await this.userSession.appManager.sendMessageToApp(
            packageName,
            dataStream,
          );

          if (!result.sent) {
            this.logger.warn(
              {
                packageName,
                resurrectionTriggered: result.resurrectionTriggered,
                error: result.error,
                effectiveSubscription,
              },
              `Failed to send transcription data to App ${packageName}`,
            );
          } else if (result.resurrectionTriggered) {
            this.logger.info(
              {
                packageName,
                effectiveSubscription,
              },
              `Transcription data sent to App ${packageName} after resurrection`,
            );
          }
        } catch (error) {
          this.logger.error(
            {
              packageName,
              error: error instanceof Error ? error.message : String(error),
              effectiveSubscription,
            },
            `Error sending transcription data to App ${packageName}`,
          );
        }
      }

      // Enhanced debug logging to show transcription content and provider
      this.logger.debug(
        {
          subscription,
          effectiveSubscription,
          provider: data.provider || "unknown",
          dataType: data.type,
          text: data.text
            ? `"${data.text.substring(0, 100)}${
                data.text.length > 100 ? "..." : ""
              }"`
            : "no text",
          isFinal: data.isFinal,
          confidence: data.confidence,
          appsNotified: subscribedApps.length,
          subscribedApps,
        },
        `📝 TRANSCRIPTION: [${data.provider || "unknown"}] ${
          data.isFinal ? "FINAL" : "interim"
        } "${data.text || "no text"}" → ${subscribedApps.length} apps`,
      );
    } catch (error) {
      this.logger.error(
        {
          error,
          subscription,
          data,
        },
        "Failed to relay transcription data to apps",
      );
    }
  }

  // ===== TRANSCRIPT HISTORY MANAGEMENT =====

  /**
   * Get transcript history for a specific language or all languages
   * @param language Optional language code (e.g., 'en-US', 'fr-FR'). If not provided, returns all languages.
   * @param timeRange Optional time range filter
   * @returns Array of transcript segments
   */
  getTranscriptHistory(
    language?: string,
    timeRange?: { duration?: number; startTime?: Date; endTime?: Date },
  ): TranscriptSegment[] {
    let segments: TranscriptSegment[] = [];

    if (language) {
      // Get segments for specific language
      if (language === "en-US") {
        // For English, prefer languageSegments but fallback to legacy segments
        segments =
          this.transcriptHistory.languageSegments.get(language) ||
          this.transcriptHistory.segments;
      } else {
        segments = this.transcriptHistory.languageSegments.get(language) || [];
      }
    } else {
      // Get all segments from all languages
      segments = Array.from(
        this.transcriptHistory.languageSegments.values(),
      ).flat();
      // Also include legacy segments if not already included
      if (!this.transcriptHistory.languageSegments.has("en-US")) {
        segments = segments.concat(this.transcriptHistory.segments);
      }
    }

    // Apply time-based filtering if provided
    if (timeRange) {
      const currentTime = new Date();
      segments = segments.filter((segment) => {
        const segmentTime = new Date(segment.timestamp);

        if (timeRange.duration) {
          const durationMs = timeRange.duration * 1000;
          const timeDiff = currentTime.getTime() - segmentTime.getTime();
          return timeDiff <= durationMs;
        }

        if (timeRange.startTime && segmentTime < timeRange.startTime) {
          return false;
        }

        if (timeRange.endTime && segmentTime > timeRange.endTime) {
          return false;
        }

        return true;
      });
    }

    // Sort by timestamp
    segments.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    return segments;
  }

  /**
   * Get available languages in transcript history
   * @returns Array of language codes that have transcript data
   */
  getAvailableLanguages(): string[] {
    const languages = new Set<string>();

    // Add languages from language-specific segments
    for (const language of this.transcriptHistory.languageSegments.keys()) {
      languages.add(language);
    }

    // Add 'en-US' if we have legacy segments and no specific en-US entry
    if (this.transcriptHistory.segments.length > 0 && !languages.has("en-US")) {
      languages.add("en-US");
    }

    return Array.from(languages).sort();
  }

  /**
   * Add transcript data to history
   * @param data Transcription data
   * @param streamType Type of stream (transcription)
   */
  private addToTranscriptHistory(data: any, streamType: StreamType): void {
    // Only process transcription data
    if (
      streamType !== StreamType.TRANSCRIPTION ||
      !data.text ||
      !data.transcribeLanguage
    ) {
      return;
    }

    const language = data.transcribeLanguage;
    const segment: TranscriptSegment = {
      resultId:
        data.resultId ||
        `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      speakerId: data.speakerId,
      text: data.text,
      timestamp: new Date(),
      isFinal: data.isFinal || false,
    };

    // Initialize language segments if needed
    if (!this.transcriptHistory.languageSegments.has(language)) {
      this.transcriptHistory.languageSegments.set(language, []);
    }

    const languageSegments =
      this.transcriptHistory.languageSegments.get(language)!;
    const legacySegments = this.transcriptHistory.segments;

    // Handle interim vs final segments (same logic as old system)
    const hasInterimLastLanguage =
      languageSegments.length > 0 &&
      !languageSegments[languageSegments.length - 1].isFinal;
    const hasInterimLastLegacy =
      legacySegments.length > 0 &&
      !legacySegments[legacySegments.length - 1].isFinal;

    if (data.isFinal) {
      // Final segment - replace interim if exists
      if (hasInterimLastLanguage) {
        languageSegments.pop();
      }
      languageSegments.push(segment);

      // For English, also update legacy segments for backward compatibility
      if (language === "en-US") {
        if (hasInterimLastLegacy) {
          legacySegments.pop();
        }
        legacySegments.push(segment);
      }

      this.logger.debug(
        {
          language,
          text: segment.text.substring(0, 100),
          segmentCount: languageSegments.length,
          provider: data.provider,
        },
        "Added FINAL transcript segment to history",
      );
    } else {
      // Interim segment - update or add
      if (hasInterimLastLanguage) {
        languageSegments[languageSegments.length - 1] = segment;
      } else {
        languageSegments.push(segment);
      }

      // For English, also update legacy segments
      if (language === "en-US") {
        if (hasInterimLastLegacy) {
          legacySegments[legacySegments.length - 1] = segment;
        } else {
          legacySegments.push(segment);
        }
      }

      this.logger.debug(
        {
          language,
          text: segment.text.substring(0, 50),
          segmentCount: languageSegments.length,
          provider: data.provider,
        },
        "Added interim transcript segment to history",
      );
    }
  }

  /**
   * Start periodic pruning of old transcript history
   */
  private startHistoryPruning(): void {
    this.historyPruneInterval = setInterval(() => {
      this.pruneOldTranscriptHistory();
    }, this.HISTORY_PRUNE_INTERVAL_MS);

    this.logger.debug(
      {
        retentionMs: this.HISTORY_RETENTION_MS,
        pruneIntervalMs: this.HISTORY_PRUNE_INTERVAL_MS,
      },
      "Started transcript history pruning",
    );
  }

  /**
   * Remove transcript segments older than retention period
   */
  private pruneOldTranscriptHistory(): void {
    const cutoffTime = new Date(Date.now() - this.HISTORY_RETENTION_MS);
    let totalPruned = 0;

    // Prune language-specific segments
    for (const [
      language,
      segments,
    ] of this.transcriptHistory.languageSegments.entries()) {
      const originalCount = segments.length;
      const filteredSegments = segments.filter(
        (segment) =>
          segment.timestamp && new Date(segment.timestamp) >= cutoffTime,
      );

      this.transcriptHistory.languageSegments.set(language, filteredSegments);
      const pruned = originalCount - filteredSegments.length;
      totalPruned += pruned;

      if (pruned > 0) {
        this.logger.debug(
          {
            language,
            prunedCount: pruned,
            remainingCount: filteredSegments.length,
          },
          "Pruned old transcript segments for language",
        );
      }
    }

    // Prune legacy segments
    const originalLegacyCount = this.transcriptHistory.segments.length;
    this.transcriptHistory.segments = this.transcriptHistory.segments.filter(
      (segment) =>
        segment.timestamp && new Date(segment.timestamp) >= cutoffTime,
    );
    const legacyPruned =
      originalLegacyCount - this.transcriptHistory.segments.length;
    totalPruned += legacyPruned;

    if (totalPruned > 0) {
      this.logger.info(
        {
          totalPruned,
          cutoffTime: cutoffTime.toISOString(),
          retentionMinutes: this.HISTORY_RETENTION_MS / (60 * 1000),
        },
        "Pruned old transcript history",
      );
    }
  }

  /**
   * Clear all transcript history
   */
  clearTranscriptHistory(): void {
    const totalSegments =
      this.transcriptHistory.segments.length +
      Array.from(this.transcriptHistory.languageSegments.values()).reduce(
        (sum, segments) => sum + segments.length,
        0,
      );

    this.transcriptHistory.segments = [];
    this.transcriptHistory.languageSegments.clear();

    this.logger.info(
      {
        clearedSegments: totalSegments,
      },
      "Cleared all transcript history",
    );
  }

  /**
   * Cleanup method - should be called when TranscriptionManager is being destroyed
   * This ensures all resources are properly released
   */
  async cleanup(): Promise<void> {
    this.logger.info("Cleaning up TranscriptionManager resources");

    try {
      // Clear VAD buffer timeout
      this.clearVADBuffer();

      // Stop health monitoring
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = undefined;
      }

      // Stop history pruning
      if (this.historyPruneInterval) {
        clearInterval(this.historyPruneInterval);
        this.historyPruneInterval = undefined;
      }

      // Stop all streams
      await this.updateSubscriptions([]);

      // Clean up all stream instances
      for (const [subscription] of this.streams) {
        await this.cleanupStream(subscription, "manager_cleanup");
      }

      // Clear all maps
      this.streams.clear();
      this.activeSubscriptions.clear();
      this.streamRetryAttempts.clear();
      this.streamCreationPromises.clear();

      // Clear pending operations
      this.pendingOperations = [];

      this.logger.info("TranscriptionManager cleanup completed");
    } catch (error) {
      this.logger.error({ error }, "Error during TranscriptionManager cleanup");
    }
  }
}
