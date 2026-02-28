/**
 * @fileoverview Azure Speech SDK provider implementation
 */

import * as azureSpeechSDK from "microsoft-cognitiveservices-speech-sdk";
import {
  SpeechConfig,
  AudioInputStream,
  AudioConfig,
  ConversationTranscriber,
  TranslationRecognizer,
  SpeechTranslationConfig,
  ProfanityOption,
  OutputFormat,
  SessionEventArgs,
  SpeechRecognitionCanceledEventArgs,
  ConversationTranscriptionEventArgs,
  CancellationReason,
} from "microsoft-cognitiveservices-speech-sdk";

import { StreamType, TranscriptionData, getLanguageInfo } from "@mentra/sdk";
import { Logger } from "pino";
import {
  TranscriptionProvider,
  StreamInstance,
  StreamOptions,
  ProviderType,
  ProviderHealthStatus,
  ProviderLanguageCapabilities,
  AzureProviderConfig,
  StreamState,
  StreamCallbacks,
  StreamMetrics,
  StreamHealth,
  AzureProviderError,
  AzureErrorType,
} from "../types";

// Azure language support (subset for now - can be expanded)
const AZURE_TRANSCRIPTION_LANGUAGES = [
  "en-US",
  "en-GB",
  "es-ES",
  "es-MX",
  "fr-FR",
  "de-DE",
  "it-IT",
  "pt-BR",
  "ja-JP",
  "ko-KR",
  "zh-CN",
  "ru-RU",
  "ar-SA",
  "hi-IN",
];

// Translation support has been moved to TranslationManager
// const AZURE_TRANSLATION_PAIRS = new Map([
//   ['en-US', ['es-ES', 'fr-FR', 'de-DE', 'it-IT', 'pt-BR', 'ja-JP', 'ko-KR', 'zh-CN']],
//   ['es-ES', ['en-US', 'fr-FR', 'de-DE', 'it-IT', 'pt-BR']],
//   ['fr-FR', ['en-US', 'es-ES', 'de-DE', 'it-IT', 'pt-BR']],
//   ['de-DE', ['en-US', 'es-ES', 'fr-FR', 'it-IT', 'pt-BR']],
//   ['zh-CN', ['en-US', 'ja-JP', 'ko-KR']],
//   ['ja-JP', ['en-US', 'zh-CN', 'ko-KR']],
//   ['ko-KR', ['en-US', 'zh-CN', 'ja-JP']]
// ]);

export class AzureTranscriptionProvider implements TranscriptionProvider {
  readonly name = ProviderType.AZURE;
  readonly logger: Logger;

  private speechConfig!: SpeechConfig;
  private healthStatus: ProviderHealthStatus;
  private failureCount = 0;
  private lastFailureTime = 0;

  constructor(
    private config: AzureProviderConfig,
    parentLogger: Logger,
  ) {
    this.logger = parentLogger.child({ provider: this.name });

    this.healthStatus = {
      isHealthy: true,
      lastCheck: Date.now(),
      failures: 0,
    };
  }

  async initialize(): Promise<void> {
    this.logger.info("Initializing Azure Speech provider");

    if (!this.config.key || !this.config.region) {
      throw new Error("Azure Speech key and region are required");
    }

    try {
      this.speechConfig = azureSpeechSDK.SpeechConfig.fromSubscription(
        this.config.key,
        this.config.region,
      );

      this.speechConfig.setProfanity(ProfanityOption.Raw);
      this.speechConfig.outputFormat = OutputFormat.Simple;

      this.logger.info(
        {
          region: this.config.region,
          keyLength: this.config.key.length,
        },
        "Azure Speech provider initialized",
      );
    } catch (error) {
      this.logger.error(
        { error },
        "Failed to initialize Azure Speech provider",
      );
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.logger.info("Disposing Azure Speech provider");

    if (this.speechConfig) {
      this.speechConfig.close();
    }
  }

  async createTranscriptionStream(
    language: string,
    options: StreamOptions,
  ): Promise<StreamInstance> {
    this.logger.debug(
      {
        language,
        streamId: options.streamId,
      },
      "Creating Azure transcription stream",
    );

    if (!this.supportsLanguage(language)) {
      throw new AzureProviderError(
        2, // Invalid argument
        `Language ${language} not supported`,
        AzureErrorType.AUTH_ERROR,
      );
    }

    const pushStream = azureSpeechSDK.AudioInputStream.createPushStream();
    const audioConfig = AudioConfig.fromStreamInput(pushStream);

    const speechConfig = azureSpeechSDK.SpeechConfig.fromSubscription(
      this.config.key,
      this.config.region,
    );
    speechConfig.speechRecognitionLanguage = language;
    speechConfig.setProfanity(ProfanityOption.Raw);

    const recognizer = new ConversationTranscriber(speechConfig, audioConfig);

    const stream = new AzureTranscriptionStream(
      options.streamId,
      options.subscription,
      this,
      language,
      recognizer,
      pushStream,
      options.callbacks,
      this.logger,
    );

    this.setupAzureEventHandlers(stream, recognizer);

    // Start transcription
    await this.startAzureRecognition(stream, recognizer);

    return stream;
  }

  // Translation is now handled by a separate TranslationManager
  // async createTranslationStream(
  //   sourceLanguage: string,
  //   targetLanguage: string,
  //   options: StreamOptions
  // ): Promise<StreamInstance> {
  //   // Translation functionality moved to TranslationManager
  // }

  supportsSubscription(subscription: string): boolean {
    const languageInfo = getLanguageInfo(subscription);
    if (!languageInfo) {
      return false;
    }

    // Only support transcription
    if (languageInfo.type === StreamType.TRANSCRIPTION) {
      return this.supportsLanguage(languageInfo.transcribeLanguage);
    }

    return false;
  }

  supportsLanguage(language: string): boolean {
    return AZURE_TRANSCRIPTION_LANGUAGES.includes(language);
  }

  // Translation validation is now handled by TranslationManager
  // validateLanguagePair(source: string, target: string): boolean {
  //   // Translation functionality moved to TranslationManager
  // }

  getLanguageCapabilities(): ProviderLanguageCapabilities {
    return {
      transcriptionLanguages: [...AZURE_TRANSCRIPTION_LANGUAGES],
      autoLanguageDetection: true,
    };
  }

  getHealthStatus(): ProviderHealthStatus {
    // Update health based on recent failures
    const now = Date.now();
    const recentFailures = this.getRecentFailureCount(300000); // 5 minutes

    this.healthStatus.lastCheck = now;
    this.healthStatus.failures = this.failureCount;
    this.healthStatus.lastFailure = this.lastFailureTime;

    // Mark as unhealthy if too many recent failures
    if (recentFailures >= 5) {
      this.healthStatus.isHealthy = false;
      this.healthStatus.reason = `Too many recent failures: ${recentFailures}`;
    } else if (!this.healthStatus.isHealthy && recentFailures < 2) {
      // Gradually restore health
      this.healthStatus.isHealthy = true;
      this.healthStatus.reason = undefined;
    }

    return { ...this.healthStatus };
  }

  recordFailure(error: Error): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    this.logger.warn(
      {
        error: error.message,
        totalFailures: this.failureCount,
      },
      "Recorded provider failure",
    );
  }

  recordSuccess(): void {
    // Don't reset failure count completely, just mark as more recent success
    const now = Date.now();

    // If it's been a while since last failure, gradually reduce count
    if (this.lastFailureTime && now - this.lastFailureTime > 300000) {
      // 5 minutes
      this.failureCount = Math.max(0, this.failureCount - 1);
    }

    this.logger.debug("Recorded provider success");
  }

  private getRecentFailureCount(timeWindowMs: number): number {
    const now = Date.now();
    return this.lastFailureTime && now - this.lastFailureTime < timeWindowMs
      ? this.failureCount
      : 0;
  }

  private setupAzureEventHandlers(
    stream: AzureTranscriptionStream,
    recognizer: ConversationTranscriber | TranslationRecognizer,
  ): void {
    // Session lifecycle events
    recognizer.sessionStarted = (sender, event) => {
      this.logger.info(
        {
          streamId: stream.id,
          sessionId: event.sessionId,
        },
        "Azure session started",
      );

      // CRITICAL: Wait for Azure to be truly ready before allowing audio
      setTimeout(() => {
        if (stream.state === StreamState.INITIALIZING) {
          stream.state = StreamState.READY;
          stream.readyTime = Date.now();
          stream.metrics.initializationTime =
            stream.readyTime - stream.startTime;

          this.recordSuccess();

          if (stream.callbacks.onReady) {
            stream.callbacks.onReady();
          }

          this.logger.info(
            {
              streamId: stream.id,
              initTime: stream.metrics.initializationTime,
            },
            "Azure stream ready",
          );
        }
      }, 750); // 750ms safety delay
    };

    recognizer.sessionStopped = (sender, event) => {
      this.logger.info(
        {
          streamId: stream.id,
          sessionId: event.sessionId,
        },
        "Azure session stopped",
      );

      stream.state = StreamState.CLOSED;

      if (stream.callbacks.onClosed) {
        // Pass 1000 (normal close) since sessionStopped is a clean shutdown
        stream.callbacks.onClosed(1000);
      }
    };

    // Error handling
    recognizer.canceled = (sender: any, event: any) => {
      this.handleAzureCanceled(stream, event);
    };

    // Recognition results - only handle transcription
    // Translation is now handled by TranslationManager
    this.setupTranscriptionHandlers(
      stream,
      recognizer as ConversationTranscriber,
    );
  }

  private setupTranscriptionHandlers(
    stream: AzureTranscriptionStream,
    recognizer: ConversationTranscriber,
  ): void {
    recognizer.transcribing = (sender, event) => {
      if (!event.result.text) return;

      const data: TranscriptionData = {
        type: StreamType.TRANSCRIPTION,
        text: event.result.text,
        isFinal: false,
        startTime: this.calculateRelativeTime(event.result.offset),
        endTime: this.calculateRelativeTime(
          event.result.offset + event.result.duration,
        ),
        speakerId: event.result.speakerId,
        transcribeLanguage: stream.language,
        provider: "azure",
      };

      if (stream.callbacks.onData) {
        stream.callbacks.onData(data);
      }

      this.logger.debug(
        {
          streamId: stream.id,
          text: data.text.substring(0, 100),
          isFinal: data.isFinal,
          provider: "azure",
        },
        `🎙️ AZURE: ${data.isFinal ? "FINAL" : "interim"} transcription - "${data.text}"`,
      );
    };

    recognizer.transcribed = (sender, event) => {
      if (!event.result.text) return;

      const data: TranscriptionData = {
        type: StreamType.TRANSCRIPTION,
        text: event.result.text,
        isFinal: true,
        startTime: this.calculateRelativeTime(event.result.offset),
        endTime: this.calculateRelativeTime(
          event.result.offset + event.result.duration,
        ),
        speakerId: event.result.speakerId,
        transcribeLanguage: stream.language,
        provider: "azure",
      };

      if (stream.callbacks.onData) {
        stream.callbacks.onData(data);
      }

      this.logger.debug(
        {
          streamId: stream.id,
          text: data.text.substring(0, 100),
          isFinal: data.isFinal,
          provider: "azure",
        },
        `🎙️ AZURE: ${data.isFinal ? "FINAL" : "interim"} transcription - "${data.text}"`,
      );
    };
  }

  // Translation is now handled by TranslationManager
  /* private setupTranslationHandlers(
    stream: AzureTranscriptionStream,
    recognizer: TranslationRecognizer
  ): void {

    recognizer.recognizing = (sender, event) => {
      if (!event.result.translations) return;

      const translatedText = event.result.translations.get(stream.targetLanguage!);
      if (!translatedText) return;

      const didTranslate = this.didTranslationOccur(event.result.text, translatedText);

      const data: TranslationData = {
        type: StreamType.TRANSLATION,
        text: translatedText,
        originalText: event.result.text,
        isFinal: false,
        startTime: this.calculateRelativeTime(event.result.offset),
        endTime: this.calculateRelativeTime(event.result.offset + event.result.duration),
        speakerId: event.result.speakerId,
        transcribeLanguage: stream.language,
        translateLanguage: stream.targetLanguage!,
        didTranslate,
        provider: 'azure'
      };

      if (stream.callbacks.onData) {
        stream.callbacks.onData(data);
      }

      this.logger.debug({
        streamId: stream.id,
        originalText: data.originalText?.substring(0, 50),
        translatedText: data.text.substring(0, 50),
        isFinal: data.isFinal,
        didTranslate: data.didTranslate,
        provider: 'azure'
      }, `🌐 AZURE TRANSLATION: ${data.isFinal ? 'FINAL' : 'interim'} "${data.originalText}" → "${data.text}"`);
    };

    recognizer.recognized = (sender, event) => {
      if (!event.result.translations) return;

      const translatedText = event.result.translations.get(stream.targetLanguage!);
      if (!translatedText) return;

      const didTranslate = this.didTranslationOccur(event.result.text, translatedText);

      const data: TranslationData = {
        type: StreamType.TRANSLATION,
        text: translatedText,
        originalText: event.result.text,
        isFinal: true,
        startTime: this.calculateRelativeTime(event.result.offset),
        endTime: this.calculateRelativeTime(event.result.offset + event.result.duration),
        speakerId: event.result.speakerId,
        transcribeLanguage: stream.language,
        translateLanguage: stream.targetLanguage!,
        didTranslate,
        provider: 'azure'
      };

      if (stream.callbacks.onData) {
        stream.callbacks.onData(data);
      }

      this.logger.debug({
        streamId: stream.id,
        originalText: data.originalText?.substring(0, 50),
        translatedText: data.text.substring(0, 50),
        isFinal: data.isFinal,
        didTranslate: data.didTranslate,
        provider: 'azure'
      }, `🌐 AZURE TRANSLATION: ${data.isFinal ? 'FINAL' : 'interim'} "${data.originalText}" → "${data.text}"`);
    };
  } */

  private async startAzureRecognition(
    stream: AzureTranscriptionStream,
    recognizer: ConversationTranscriber | TranslationRecognizer,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Only handle transcription - translation is now handled by TranslationManager
      (recognizer as ConversationTranscriber).startTranscribingAsync(
        () => resolve(),
        (error) =>
          reject(new AzureProviderError(999, error, AzureErrorType.UNKNOWN)),
      );
    });
  }

  private handleAzureCanceled(
    stream: AzureTranscriptionStream,
    event: SpeechRecognitionCanceledEventArgs,
  ): void {
    const errorCode = event.errorCode;
    const errorDetails = event.errorDetails || "";
    const errorType = this.classifyAzureError(errorCode, errorDetails);

    this.logger.warn(
      {
        streamId: stream.id,
        errorCode,
        errorDetails,
        errorType,
        reason: event.reason,
      },
      "Azure stream canceled",
    );

    stream.state = StreamState.ERROR;
    stream.lastError = new AzureProviderError(
      errorCode,
      errorDetails,
      errorType,
    );

    this.recordFailure(stream.lastError);

    if (stream.callbacks.onError) {
      stream.callbacks.onError(stream.lastError);
    }
  }

  private classifyAzureError(
    errorCode: number,
    errorDetails: string,
  ): AzureErrorType {
    switch (errorCode) {
      case 7:
        return AzureErrorType.RACE_CONDITION;
      case 4:
        if (errorDetails.includes("4429")) {
          return AzureErrorType.RATE_LIMIT;
        }
        return AzureErrorType.NETWORK_ERROR;
      case 6:
        return AzureErrorType.TIMEOUT;
      case 1:
      case 2:
        return AzureErrorType.AUTH_ERROR;
      default:
        return AzureErrorType.UNKNOWN;
    }
  }

  private calculateRelativeTime(offset: number): number {
    // Convert Azure ticks to milliseconds
    return Math.round(offset / 10000);
  }

  // Translation is now handled by TranslationManager
  /* private didTranslationOccur(originalText: string, translatedText: string): boolean {
    // Simple comparison to detect if translation actually occurred
    const normalizedOriginal = originalText.toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '').trim();
    const normalizedTranslated = translatedText.toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '').trim();

    return normalizedOriginal !== normalizedTranslated;
  } */
}

/**
 * Azure-specific stream implementation
 */
class AzureTranscriptionStream implements StreamInstance {
  public state = StreamState.INITIALIZING;
  public startTime = Date.now();
  public readyTime?: number;
  public lastActivity = Date.now();
  public lastError?: Error;
  public metrics: StreamMetrics;

  constructor(
    public readonly id: string,
    public readonly subscription: string,
    public readonly provider: AzureTranscriptionProvider,
    public readonly language: string,
    public readonly azureRecognizer:
      | ConversationTranscriber
      | TranslationRecognizer,
    public readonly pushStream: AudioInputStream,
    public readonly callbacks: StreamCallbacks,
    public readonly logger: Logger,
  ) {
    this.metrics = {
      totalDuration: 0,
      audioChunksReceived: 0,
      audioChunksWritten: 0,
      audioDroppedCount: 0,
      audioWriteFailures: 0,
      consecutiveFailures: 0,
      errorCount: 0,
    };
  }

  async writeAudio(data: ArrayBuffer): Promise<boolean> {
    this.lastActivity = Date.now();
    this.metrics.audioChunksReceived++;

    // Simple state check - drop audio if not ready
    if (this.state !== StreamState.READY && this.state !== StreamState.ACTIVE) {
      this.metrics.audioDroppedCount++;
      return false;
    }

    try {
      (this.pushStream as any).write(data);
      this.state = StreamState.ACTIVE;
      this.metrics.audioChunksWritten++;
      this.metrics.lastSuccessfulWrite = Date.now();
      this.metrics.consecutiveFailures = 0;
      return true;
    } catch (error) {
      this.metrics.audioWriteFailures++;
      this.metrics.consecutiveFailures++;
      this.metrics.errorCount++;

      // Too many failures? Mark as error
      if (this.metrics.consecutiveFailures >= 5) {
        this.state = StreamState.ERROR;
        this.lastError = error as Error;

        if (this.callbacks.onError) {
          this.callbacks.onError(this.lastError);
        }
      }

      return false;
    }
  }

  async close(): Promise<void> {
    this.state = StreamState.CLOSING;

    try {
      // Only handle transcription - translation is now handled by TranslationManager
      await new Promise<void>((resolve, reject) => {
        (this.azureRecognizer as ConversationTranscriber).stopTranscribingAsync(
          () => resolve(),
          (error) => reject(error),
        );
      });

      this.azureRecognizer.close();
      this.pushStream.close();

      this.state = StreamState.CLOSED;
      this.metrics.totalDuration = Date.now() - this.startTime;
    } catch (error) {
      this.logger.warn(
        { error, streamId: this.id },
        "Error during stream close",
      );
      this.state = StreamState.CLOSED; // Force closed even on error
    }
  }

  getHealth(): StreamHealth {
    return {
      isAlive:
        this.state === StreamState.READY || this.state === StreamState.ACTIVE,
      lastActivity: this.lastActivity,
      consecutiveFailures: this.metrics.consecutiveFailures,
      lastSuccessfulWrite: this.metrics.lastSuccessfulWrite,
      providerHealth: this.provider.getHealthStatus(),
    };
  }
}
