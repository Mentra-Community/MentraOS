/**
 * @fileoverview TranslationManager - Per-session translation management with provider abstraction
 * Handles translation streams independently from transcription
 */

import { Logger } from "pino";
import {
  ExtendedStreamType,
  CloudToAppMessageType,
  DataStream,
  TranslationData,
  parseLanguageStream,
} from "@mentra/sdk";
import UserSession from "../UserSession";
import { PosthogService } from "../../logging/posthog.service";
// import subscriptionService from "../subscription.service";
import {
  TranslationConfig,
  TranslationProvider,
  TranslationStreamInstance,
  TranslationProviderType,
  TranslationStreamState,
  TranslationError,
  InvalidLanguagePairError,
  TranslationStreamCreationError,
  DEFAULT_TRANSLATION_CONFIG,
  TranslationProviderSelectionOptions,
  TranslationStreamOptions,
} from "./types";

export class TranslationManager {
  public readonly logger: Logger;

  // Provider Management
  private providers = new Map<TranslationProviderType, TranslationProvider>();

  // Initialization State
  private isInitialized = false;
  private initializationPromise: Promise<void>;

  // Stream Management
  private streams = new Map<string, TranslationStreamInstance>();
  private activeSubscriptions = new Set<ExtendedStreamType>();

  // Retry Logic
  private streamRetryAttempts = new Map<string, number>();
  private streamCreationInProgress = new Set<string>();

  // Audio Buffering
  private audioBuffer: ArrayBuffer[] = [];
  private audioBufferMaxSize = 50; // ~2.5 seconds at 50ms chunks
  private isBufferingAudio = false;
  private audioBufferTimeout?: NodeJS.Timeout;
  private audioBufferTimeoutMs = 10000; // 10 second timeout
  private DEPLOYMENT_REGION: string = process.env.DEPLOYMENT_REGION || "global";
  private IS_CHINA: boolean = this.DEPLOYMENT_REGION === "china";

  // Health Monitoring
  private healthCheckInterval?: NodeJS.Timeout;

  constructor(
    private userSession: UserSession,
    private config: TranslationConfig = DEFAULT_TRANSLATION_CONFIG,
  ) {
    this.logger = userSession.logger.child({ service: "TranslationManager" });

    // Start initialization but don't block constructor
    this.initializationPromise = this.initializeProviders();
    this.startHealthMonitoring();

    this.logger.info(
      {
        defaultProvider: this.config.providers.defaultProvider,
        fallbackProvider: this.config.providers.fallbackProvider,
      },
      "TranslationManager created - initializing providers...",
    );
  }

  // Normalize Buffer to ArrayBuffer for provider APIs
  private toArrayBuffer(input: ArrayBuffer | Buffer): ArrayBuffer {
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) {
      const buf = input as unknown as Buffer;
      const ab = new ArrayBuffer(buf.length);
      new Uint8Array(ab).set(buf);
      return ab;
    }
    return input as ArrayBuffer;
  }

  /**
   * Update active subscriptions
   */
  async updateSubscriptions(
    subscriptions: ExtendedStreamType[],
  ): Promise<void> {
    // Ensure we're initialized before processing subscriptions
    await this.ensureInitialized();

    // Filter to only translation subscriptions
    const translationSubscriptions = subscriptions.filter((sub) => {
      if (typeof sub === "string" && sub.startsWith("translation:")) {
        // Validate it's not same-language translation
        const match = sub.match(/translation:([^-]+)-to-([^-]+)$/);
        if (match && match[1] === match[2]) {
          this.logger.warn(
            {
              subscription: sub,
              source: match[1],
              target: match[2],
            },
            "Filtering out invalid same-language translation subscription",
          );
          return false;
        }
        return true;
      }
      return false;
    });

    const desired = new Set(translationSubscriptions);
    const current = new Set(this.streams.keys());

    this.logger.debug(
      {
        desired: Array.from(desired),
        current: Array.from(current),
      },
      "Updating translation subscriptions",
    );

    // Stop removed streams
    for (const subscription of current) {
      if (!desired.has(subscription)) {
        await this.stopStream(subscription);
      }
    }

    // Start new streams - no optimization, 1:1 mapping
    for (const subscription of desired) {
      if (!current.has(subscription)) {
        await this.startStream(subscription);
      }
    }

    this.activeSubscriptions = desired;
  }

  /**
   * Feed audio to all active translation streams
   */
  feedAudio(audioData: ArrayBuffer | Buffer): void {
    // If we're buffering, add to buffer
    if (this.isBufferingAudio) {
      this.audioBuffer.push(this.toArrayBuffer(audioData));

      // Prevent buffer from growing too large
      if (this.audioBuffer.length > this.audioBufferMaxSize) {
        this.audioBuffer.shift();
      }

      this.logger.debug(
        {
          bufferSize: this.audioBuffer.length,
          maxSize: this.audioBufferMaxSize,
        },
        "Buffering audio for translation startup",
      );
      return;
    }

    // Normal audio feeding
    this.feedAudioToStreams(audioData);
  }

  /**
   * Ensure translation streams exist for active subscriptions
   */
  async ensureStreamsExist(): Promise<void> {
    const currentSubscriptions = Array.from(this.activeSubscriptions);

    this.logger.info(
      {
        subscriptions: currentSubscriptions,
        existingStreams: this.streams.size,
        bufferSize: this.audioBuffer.length,
      },
      "Ensuring translation streams match active subscriptions",
    );

    // Clean up streams without subscriptions
    const streamsToCleanup: string[] = [];
    for (const [subscription] of this.streams.entries()) {
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
        "Cleaning up translation streams with no active subscriptions",
      );

      for (const subscription of streamsToCleanup) {
        await this.cleanupStream(subscription, "subscription_removed");
      }
    }

    // If no subscriptions, we're done
    if (currentSubscriptions.length === 0) {
      this.logger.info(
        "No active translation subscriptions - all streams cleaned up",
      );
      return;
    }

    // Start buffering audio for any new streams
    this.startAudioBuffering();

    // Create missing streams
    const createPromises: Promise<void>[] = [];

    for (const subscription of currentSubscriptions) {
      const existingStream = this.streams.get(subscription);

      if (existingStream && this.isStreamHealthy(existingStream)) {
        this.logger.debug(
          { subscription },
          "Translation stream already exists and is healthy",
        );
        continue;
      }

      if (existingStream) {
        this.logger.info(
          { subscription },
          "Translation stream exists but is unhealthy - will create new stream",
        );
        await this.cleanupStream(subscription, "unhealthy_stream_replacement");
      }

      // Create new stream
      this.logger.info({ subscription }, "Creating new translation stream");
      createPromises.push(this.startStream(subscription));
    }

    if (createPromises.length === 0) {
      this.logger.info(
        "All required translation streams already exist and are healthy",
      );
      this.flushAudioBuffer();
      return;
    }

    // Wait for all new streams to be created
    const results = await Promise.allSettled(createPromises);

    // Count results
    let successCount = 0;
    let failureCount = 0;

    results.forEach((result) => {
      if (result.status === "rejected") {
        failureCount++;
        this.logger.error(
          {
            error: result.reason,
          },
          "Failed to create translation stream",
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
      "Translation stream synchronization completed",
    );

    // Flush buffered audio to streams
    this.flushAudioBuffer();
  }

  /**
   * Stop all translation streams but preserve subscriptions for VAD resume
   */
  async stopAllStreams(): Promise<void> {
    try {
      this.logger.info(
        "Stopping all translation streams (preserving subscriptions)",
      );

      // Clear audio buffer
      this.clearAudioBuffer();

      // Close all streams without clearing subscriptions
      const closePromises: Promise<void>[] = [];

      for (const [subscription, stream] of this.streams) {
        this.logger.debug(
          { subscription, streamId: stream.id },
          "Closing translation stream",
        );
        closePromises.push(
          stream
            .close()
            .catch((error) =>
              this.logger.warn(
                { error, subscription },
                "Error closing translation stream",
              ),
            ),
        );
      }

      await Promise.allSettled(closePromises);

      // Clear the streams map but NOT the activeSubscriptions set
      this.streams.clear();

      this.logger.info(
        {
          closedStreams: closePromises.length,
          preservedSubscriptions: this.activeSubscriptions.size,
        },
        "All translation streams stopped, subscriptions preserved for VAD resume",
      );
    } catch (error) {
      this.logger.error(error, "Error stopping all translation streams");
    }
  }

  /**
   * Stop all translation streams and clear subscriptions (full cleanup)
   */
  async stopAll(): Promise<void> {
    try {
      this.logger.info(
        "Stopping all translation streams and clearing subscriptions",
      );

      // Clear audio buffer
      this.clearAudioBuffer();

      // Stop all streams and clear subscriptions
      await this.updateSubscriptions([]);
    } catch (error) {
      this.logger.error(error, "Error stopping all translation streams");
    }
  }

  /**
   * Feed audio data to translation streams
   */
  // feedAudio(audioData: ArrayBuffer): void {
  //   // If we're buffering audio for stream startup, add to buffer
  //   if (this.isBufferingAudio) {
  //     this.audioBuffer.push(audioData);
  //     return;
  //   }

  //   // Otherwise feed directly to streams
  //   this.feedAudioToStreams(audioData);
  // }

  /**
   * Get current stream metrics
   */
  getMetrics(): Record<string, any> {
    const metrics: Record<string, any> = {
      totalStreams: this.streams.size,
      activeStreams: 0,
      byProvider: {} as Record<string, any>,
      byState: {} as Record<string, number>,
      byLanguagePair: {} as Record<string, number>,
    };

    // Count by various dimensions
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

      // By language pair
      const pair = `${stream.sourceLanguage}->${stream.targetLanguage}`;
      if (!metrics.byLanguagePair[pair]) {
        metrics.byLanguagePair[pair] = 0;
      }
      metrics.byLanguagePair[pair]++;

      // Active count
      if (
        stream.state === TranslationStreamState.READY ||
        stream.state === TranslationStreamState.ACTIVE
      ) {
        metrics.activeStreams++;
      }
    }

    return metrics;
  }

  /**
   * Dispose of the manager and cleanup resources
   */
  async dispose(): Promise<void> {
    this.logger.info("Disposing TranslationManager");

    // Stop health monitoring
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Clear audio buffer timeout
    this.clearAudioBuffer();

    // Close all streams
    const closePromises = Array.from(this.streams.values()).map((stream) =>
      stream
        .close()
        .catch((error) =>
          this.logger.warn(
            { error, streamId: stream.id },
            "Error closing translation stream during disposal",
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
              "Error disposing translation provider",
            ),
          ),
    );

    await Promise.allSettled(providerDisposePromises);
    this.providers.clear();

    this.logger.info("TranslationManager disposed");
  }

  // ===== PRIVATE METHODS =====

  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    this.logger.debug("Waiting for TranslationManager initialization...");
    await this.initializationPromise;

    if (!this.isInitialized) {
      throw new Error("TranslationManager initialization failed");
    }
  }

  private async initializeProviders(): Promise<void> {
    try {
      this.logger.info("Starting translation provider initialization...");

      const availableProviders: TranslationProviderType[] = [];
      const providerErrors: Array<{ provider: string; error: Error }> = [];

      try {
        if (this.IS_CHINA) {
          const { AlibabaTranslationProvider } = await import(
            "./providers/AlibabaTranslationProvider"
          );
          const alibabaProvider = new AlibabaTranslationProvider(
            this.config.alibaba,
            this.logger,
          );
          await alibabaProvider.initialize();
          this.providers.set(TranslationProviderType.ALIBABA, alibabaProvider);
          availableProviders.push(TranslationProviderType.ALIBABA);
          this.logger.info(
            "Alibaba translation provider initialized successfully",
          );
        }
      } catch (error) {
        this.logger.error(
          error,
          "Failed to initialize Alibaba translation provider",
        );
        providerErrors.push({ provider: "Alibaba", error: error as Error });
      }

      // Try to initialize Azure provider
      try {
        if (!this.IS_CHINA) {
          const { AzureTranslationProvider } = await import(
            "./providers/AzureTranslationProvider"
          );
          const azureProvider = new AzureTranslationProvider(
            this.config.azure,
            this.logger,
          );
          await azureProvider.initialize();
          this.providers.set(TranslationProviderType.AZURE, azureProvider);
          availableProviders.push(TranslationProviderType.AZURE);
          this.logger.info(
            "Azure translation provider initialized successfully",
          );
        } else {
          this.logger.info(
            "Azure translation provider not initialized - China region",
          );
        }
      } catch (error) {
        this.logger.error(
          error,
          "Failed to initialize Azure translation provider",
        );
        providerErrors.push({ provider: "Azure", error: error as Error });
      }

      // Try to initialize Soniox provider
      try {
        if (!this.IS_CHINA) {
          const { SonioxTranslationProvider } = await import(
            "./providers/SonioxTranslationProvider"
          );
          const sonioxProvider = new SonioxTranslationProvider(
            this.config.soniox,
            this.logger,
          );
          await sonioxProvider.initialize();
          this.providers.set(TranslationProviderType.SONIOX, sonioxProvider);
          availableProviders.push(TranslationProviderType.SONIOX);
          this.logger.info(
            "Soniox translation provider initialized successfully",
          );
        } else {
          this.logger.info(
            "Soniox translation provider not initialized - China region",
          );
        }
      } catch (error) {
        this.logger.error(
          error,
          "Failed to initialize Soniox translation provider",
        );
        providerErrors.push({ provider: "Soniox", error: error as Error });
      }

      // Check if we have at least one provider
      if (this.providers.size === 0) {
        const errorMsg = `No translation providers available. Errors: ${providerErrors.map((e) => `${e.provider}: ${e.error.message}`).join(", ")}`;
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

      // Mark as initialized
      this.isInitialized = true;

      this.logger.info(
        {
          availableProviders,
          totalProviders: this.providers.size,
          skippedProviders: providerErrors.length,
        },
        "Translation provider initialization completed",
      );

      if (providerErrors.length > 0) {
        this.logger.warn(
          {
            providerErrors: providerErrors.map((e) => ({
              provider: e.provider,
              error: e.error.message,
            })),
          },
          "Some translation providers failed to initialize but system will continue with available providers",
        );
      }
    } catch (error) {
      this.logger.error(
        { error },
        "Critical failure in translation provider initialization",
      );
      throw error;
    }
  }

  private async startStream(subscription: ExtendedStreamType): Promise<void> {
    await this.ensureInitialized();

    // Prevent duplicate creation
    if (this.streamCreationInProgress.has(subscription)) {
      this.logger.debug(
        { subscription },
        "Translation stream creation already in progress",
      );
      return;
    }

    // Check existing stream
    const existingStream = this.streams.get(subscription);
    if (existingStream && this.isStreamHealthy(existingStream)) {
      this.logger.debug(
        { subscription },
        "Translation stream already exists and healthy",
      );
      return;
    }

    // Clean up any existing stream
    if (existingStream) {
      await this.cleanupStream(subscription, "replacing_stream");
    }

    this.streamCreationInProgress.add(subscription);

    try {
      // Parse the language pair from subscription
      const langInfo = parseLanguageStream(subscription);
      if (!langInfo || langInfo.type !== "translation") {
        throw new TranslationError(
          `Invalid translation subscription: ${subscription}`,
        );
      }

      const sourceLanguage = langInfo.transcribeLanguage;
      const targetLanguage = langInfo.translateLanguage!;

      // Select provider
      const provider = await this.selectProvider(
        sourceLanguage,
        targetLanguage,
      );

      this.logger.debug(
        {
          subscription,
          provider: provider.name,
          sourceLanguage,
          targetLanguage,
        },
        "Selected translation provider",
      );

      // Create stream options
      const streamOptions: TranslationStreamOptions = {
        streamId: this.generateStreamId(subscription),
        userSession: this.userSession,
        subscription,
        sourceLanguage,
        targetLanguage,
        callbacks: this.createStreamCallbacks(subscription),
      };

      // Create stream
      this.logger.debug(
        { subscription, streamId: streamOptions.streamId },
        "Creating translation stream with provider",
      );
      const stream = await provider.createTranslationStream(streamOptions);

      this.logger.debug(
        {
          subscription,
          streamId: stream.id,
          streamState: stream.state,
        },
        "Translation stream created, waiting for ready state",
      );

      // Wait for ready
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
          sourceLanguage,
          targetLanguage,
        },
        `🚀 TRANSLATION STREAM CREATED: [${provider.name.toUpperCase()}] for "${subscription}"`,
      );

      // Track success
      PosthogService.trackEvent(
        "translation_stream_created",
        this.userSession.userId,
        {
          subscription,
          provider: provider.name,
          sourceLanguage,
          targetLanguage,
          sessionId: this.userSession.sessionId,
        },
      );
    } catch (error) {
      this.logger.error(error, "Translation stream creation failed");
      this.handleStreamError(subscription, null, error as Error);
    } finally {
      this.streamCreationInProgress.delete(subscription);
    }
  }

  private async stopStream(subscription: ExtendedStreamType): Promise<void> {
    const stream = this.streams.get(subscription);
    if (stream) {
      this.logger.info(
        { subscription, streamId: stream.id },
        "Stopping translation stream",
      );

      try {
        await stream.close();
      } catch (error) {
        this.logger.warn(
          { error, subscription },
          "Error stopping translation stream",
        );
      }

      this.streams.delete(subscription);
      this.streamRetryAttempts.delete(subscription);
    }
  }

  private createStreamCallbacks(subscription: ExtendedStreamType) {
    return {
      onReady: () => {
        this.logger.debug({ subscription }, "Translation stream ready");
      },

      onError: (error: Error) => {
        const stream = this.streams.get(subscription);
        if (stream) {
          this.handleStreamError(subscription, stream, error);
        }
      },

      onClosed: () => {
        this.logger.info(
          { subscription },
          "Translation stream closed by provider",
        );
        this.streams.delete(subscription);
      },

      onData: (data: TranslationData) => {
        // Relay to apps that are subscribed
        this.relayDataToApps(subscription, data).catch((error) => {
          this.logger.error(
            { error, subscription, data },
            "Error relaying translation data",
          );
        });
      },
    };
  }

  private async relayDataToApps(
    subscription: ExtendedStreamType,
    data: TranslationData,
  ): Promise<void> {
    try {
      // Get subscribed apps
      const subscribedApps =
        this.userSession.subscriptionManager.getSubscribedApps(subscription);

      this.logger.debug(
        {
          subscription,
          subscribedApps,
          sourceLanguage: data.transcribeLanguage,
          targetLanguage: data.translateLanguage,
          didTranslate: data.didTranslate,
          textPreview: data.text
            ? `"${data.text.substring(0, 100)}${data.text.length > 100 ? "..." : ""}"`
            : "no text",
        },
        "Broadcasting translation data to apps",
      );

      // Send to each app using AppManager
      for (const packageName of subscribedApps) {
        const appSessionId = `${this.userSession.sessionId}-${packageName}`;

        const dataStream: DataStream = {
          type: CloudToAppMessageType.DATA_STREAM,
          sessionId: appSessionId,
          streamType: subscription,
          data,
          timestamp: new Date(),
        };

        try {
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
              },
              `Failed to send translation data to App ${packageName}`,
            );
          }
        } catch (error) {
          this.logger.error(
            {
              packageName,
              error: error instanceof Error ? error.message : String(error),
            },
            `Error sending translation data to App ${packageName}`,
          );
        }
      }

      // Log translation activity
      this.logger.info(
        {
          subscription,
          provider: data.provider || "unknown",
          sourceText: data.originalText
            ? `"${data.originalText.substring(0, 50)}..."`
            : undefined,
          translatedText: data.text
            ? `"${data.text.substring(0, 50)}..."`
            : "no text",
          isFinal: data.isFinal,
          languages: `${data.transcribeLanguage} → ${data.translateLanguage}`,
          appsNotified: subscribedApps.length,
        },
        `🌐 TRANSLATION: [${data.provider || "unknown"}] ${data.isFinal ? "FINAL" : "interim"} → ${subscribedApps.length} apps`,
      );
    } catch (error) {
      this.logger.error(
        {
          error,
          subscription,
          data,
        },
        "Failed to relay translation data to apps",
      );
    }
  }

  private async selectProvider(
    sourceLanguage: string,
    targetLanguage: string,
    options?: TranslationProviderSelectionOptions,
  ): Promise<TranslationProvider> {
    if (this.IS_CHINA) {
      const chineseProvider = this.providers.get(
        TranslationProviderType.ALIBABA,
      ) as TranslationProvider;

      const supportsLanguagePair = chineseProvider?.supportsLanguagePair(
        sourceLanguage,
        targetLanguage,
      );
      if (chineseProvider && supportsLanguagePair) {
        return chineseProvider;
      }

      this.logger.warn(
        {
          sourceLanguage,
          targetLanguage,
          provider: TranslationProviderType.ALIBABA,
        },
        "Chinese provider does not support language pair",
      );

      throw new InvalidLanguagePairError(
        `No provider supports translation from ${sourceLanguage} to ${targetLanguage}`,
        sourceLanguage,
        targetLanguage,
      );
    }

    const excludedProviders = new Set(options?.excludeProviders || []);
    const preferredProvider = options?.preferProvider;

    this.logger.debug(
      {
        sourceLanguage,
        targetLanguage,
        excludedProviders: Array.from(excludedProviders),
        preferredProvider,
        defaultProvider: this.config.providers.defaultProvider,
        fallbackProvider: this.config.providers.fallbackProvider,
        availableProviders: Array.from(this.providers.keys()),
      },
      "Selecting translation provider",
    );

    // Try preferred provider first
    if (preferredProvider && !excludedProviders.has(preferredProvider)) {
      const provider = this.providers.get(preferredProvider);
      if (provider) {
        const supports = provider.supportsLanguagePair(
          sourceLanguage,
          targetLanguage,
        );
        this.logger.debug(
          {
            provider: preferredProvider,
            supports,
            sourceLanguage,
            targetLanguage,
          },
          "Checking preferred provider",
        );
        if (supports) {
          return provider;
        }
      }
    }

    // Try default provider
    const defaultProvider = this.providers.get(
      this.config.providers.defaultProvider,
    );
    if (
      defaultProvider &&
      !excludedProviders.has(this.config.providers.defaultProvider)
    ) {
      const supports = defaultProvider.supportsLanguagePair(
        sourceLanguage,
        targetLanguage,
      );
      this.logger.debug(
        {
          provider: this.config.providers.defaultProvider,
          supports,
          sourceLanguage,
          targetLanguage,
        },
        "Checking default provider",
      );
      if (supports) {
        return defaultProvider;
      }
    }

    // Try fallback provider
    const fallbackProvider = this.providers.get(
      this.config.providers.fallbackProvider,
    );
    if (
      fallbackProvider &&
      !excludedProviders.has(this.config.providers.fallbackProvider)
    ) {
      const supports = fallbackProvider.supportsLanguagePair(
        sourceLanguage,
        targetLanguage,
      );
      this.logger.debug(
        {
          provider: this.config.providers.fallbackProvider,
          supports,
          sourceLanguage,
          targetLanguage,
        },
        "Checking fallback provider",
      );
      if (supports) {
        return fallbackProvider;
      }
    }

    // Try any available provider
    for (const [type, provider] of this.providers) {
      if (!excludedProviders.has(type)) {
        const supports = provider.supportsLanguagePair(
          sourceLanguage,
          targetLanguage,
        );
        this.logger.debug(
          {
            provider: type,
            supports,
            sourceLanguage,
            targetLanguage,
          },
          "Checking provider",
        );
        if (supports) {
          return provider;
        }
      }
    }

    throw new InvalidLanguagePairError(
      `No provider supports translation from ${sourceLanguage} to ${targetLanguage}`,
      sourceLanguage,
      targetLanguage,
    );
  }

  private async handleStreamError(
    subscription: ExtendedStreamType,
    stream: TranslationStreamInstance | null,
    error: Error,
  ): Promise<void> {
    const currentProvider = stream?.provider.name;

    this.logger.warn(
      {
        subscription,
        error: error.message,
        provider: currentProvider,
      },
      "Translation stream error occurred",
    );

    // Record provider failure
    if (stream) {
      stream.provider.recordFailure(error);
    }

    // Clean up failed stream
    await this.cleanupStream(subscription, "provider_error");

    // If we don't have the subscription active anymore, don't retry
    if (!this.activeSubscriptions.has(subscription)) {
      this.logger.info(
        { subscription },
        "Subscription no longer active - not retrying translation stream",
      );
      return;
    }

    // Implement retry logic
    const attempts = this.streamRetryAttempts.get(subscription) || 0;

    if (attempts >= this.config.retries.maxStreamRetries) {
      this.logger.error(
        { subscription, attempts },
        "Maximum retry attempts reached for translation stream",
      );
      this.streamRetryAttempts.delete(subscription);

      // Track final failure
      PosthogService.trackEvent(
        "translation_stream_permanent_failure",
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

    // Schedule retry
    this.scheduleStreamRetry(subscription, attempts + 1);
  }

  private scheduleStreamRetry(
    subscription: ExtendedStreamType,
    attempt: number,
  ): void {
    this.streamRetryAttempts.set(subscription, attempt);

    const delay = this.config.retries.retryDelayMs * attempt;

    this.logger.info(
      {
        subscription,
        attempt,
        delay,
      },
      "Scheduling translation stream retry",
    );

    setTimeout(async () => {
      try {
        await this.startStream(subscription);
        this.streamRetryAttempts.delete(subscription); // Success
      } catch (error) {
        this.logger.warn(
          { subscription, attempt, error },
          "Translation stream retry failed",
        );
      }
    }, delay);
  }

  private async waitForStreamReady(
    stream: TranslationStreamInstance,
    timeoutMs: number,
  ): Promise<void> {
    const startTime = Date.now();

    while (
      stream.state === TranslationStreamState.INITIALIZING &&
      Date.now() - startTime < timeoutMs
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (stream.state === TranslationStreamState.INITIALIZING) {
      throw new TranslationStreamCreationError(
        "Translation stream initialization timeout",
      );
    }

    if (stream.state === TranslationStreamState.ERROR) {
      throw new TranslationStreamCreationError(
        "Translation stream initialization failed",
        {
          error: stream.lastError,
          streamId: stream.id,
        },
      );
    }

    if (stream.state !== TranslationStreamState.READY) {
      throw new TranslationStreamCreationError(
        `Translation stream in unexpected state: ${stream.state}`,
      );
    }
  }

  private async cleanupStream(
    subscription: ExtendedStreamType,
    reason: string,
  ): Promise<void> {
    const stream = this.streams.get(subscription);
    if (stream) {
      this.logger.debug(
        { subscription, reason },
        "Cleaning up translation stream",
      );

      try {
        await stream.close();
      } catch (error) {
        this.logger.warn(
          { error, subscription },
          "Error closing translation stream during cleanup",
        );
      }

      this.streams.delete(subscription);
    }
  }

  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(() => {
      this.cleanupDeadStreams();
    }, this.config.performance.healthCheckIntervalMs);
  }

  private async cleanupDeadStreams(): Promise<void> {
    const now = Date.now();
    const deadStreams: [string, TranslationStreamInstance][] = [];

    for (const [subscription, stream] of this.streams) {
      const timeSinceActivity = now - stream.lastActivity;

      const isDead =
        timeSinceActivity > 300000 || // 5 minutes
        stream.state === TranslationStreamState.ERROR ||
        stream.state === TranslationStreamState.CLOSED ||
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
        "Cleaning up dead translation stream",
      );

      await this.cleanupStream(subscription, "dead_stream_cleanup");
    }
  }

  private isStreamHealthy(stream: TranslationStreamInstance): boolean {
    return (
      stream.state === TranslationStreamState.READY ||
      stream.state === TranslationStreamState.ACTIVE ||
      stream.state === TranslationStreamState.INITIALIZING
    );
  }

  private generateStreamId(subscription: ExtendedStreamType): string {
    return `translation-${this.userSession.sessionId}-${subscription}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private startAudioBuffering(): void {
    this.isBufferingAudio = true;
    this.audioBuffer = [];

    // Set timeout to automatically flush buffer
    this.audioBufferTimeout = setTimeout(() => {
      this.logger.warn(
        {
          bufferSize: this.audioBuffer.length,
          timeoutMs: this.audioBufferTimeoutMs,
        },
        "Translation audio buffer timeout reached - force flushing",
      );

      this.flushAudioBuffer();
    }, this.audioBufferTimeoutMs);

    this.logger.debug(
      {
        timeoutMs: this.audioBufferTimeoutMs,
      },
      "Started audio buffering for translation stream startup",
    );
  }

  private flushAudioBuffer(): void {
    // Clear timeout if it exists
    if (this.audioBufferTimeout) {
      clearTimeout(this.audioBufferTimeout);
      this.audioBufferTimeout = undefined;
    }

    if (!this.isBufferingAudio || this.audioBuffer.length === 0) {
      this.isBufferingAudio = false;
      return;
    }

    this.logger.debug(
      {
        bufferSize: this.audioBuffer.length,
        activeStreams: this.streams.size,
      },
      "Flushing audio buffer to translation streams",
    );

    // Send all buffered audio chunks to active streams
    for (const audioData of this.audioBuffer) {
      this.feedAudioToStreams(audioData);
    }

    // Clear buffer and stop buffering
    this.audioBuffer = [];
    this.isBufferingAudio = false;
  }

  private clearAudioBuffer(): void {
    // Clear timeout if it exists
    if (this.audioBufferTimeout) {
      clearTimeout(this.audioBufferTimeout);
      this.audioBufferTimeout = undefined;
    }

    this.audioBuffer = [];
    this.isBufferingAudio = false;
    this.logger.debug("Cleared translation audio buffer");
  }

  private feedAudioToStreams(audioData: ArrayBuffer | Buffer): void {
    if (!this.isInitialized || this.streams.size === 0) {
      return;
    }

    // Log audio feeding periodically
    if (Math.random() < 0.01) {
      // 1% of the time to avoid log spam
      this.logger.debug(
        {
          audioSize: audioData.byteLength,
          activeStreams: this.streams.size,
          streamStates: Array.from(this.streams.entries()).map(
            ([sub, stream]) => ({
              subscription: sub,
              state: stream.state,
              consecutiveFailures: stream.metrics.consecutiveFailures,
            }),
          ),
        },
        "Feeding audio to translation streams",
      );
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
            streamState: stream.state,
          },
          "Error feeding audio to translation stream",
        );
      }
    }
  }
}
