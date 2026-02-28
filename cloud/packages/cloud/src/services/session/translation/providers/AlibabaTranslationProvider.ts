import { Logger } from "pino";
import WebSocket from "ws";

import { StreamType, TranslationData } from "@mentra/sdk";

import { ResourceTracker } from "../../../../utils/resource-tracker";
import {
  AlibabaTranslationConfig,
  TranslationProvider,
  TranslationProviderCapabilities,
  TranslationProviderHealthStatus,
  TranslationProviderType,
  TranslationStreamInstance,
  TranslationStreamOptions,
  TranslationStreamState,
  TranslationStreamMetrics,
  TranslationProviderError,
  TranslationStreamHealth,
} from "../types";

interface AlibabaMessage {
  header: {
    event: string;
    error_message?: string;
  };
  payload: {
    output: {
      translations?: {
        sentence_id: number;
        begin_time: number;
        end_time: number;
        text: string;
        lang: string;
        words?: {
          begin_time: number;
          end_time: number;
          text: string;
          punctuation: string;
          fixed: string;
        }[];
        sentence_end: boolean;
      }[];
      transcription?: {
        sentence_id: number;
        begin_time: number;
        end_time: number;
        text: string;
        words?: {
          begin_time: number;
          end_time: number;
          text: string;
          punctuation: string;
          fixed: string;
        }[];
        sentence_end: boolean;
      };
    };
  };
}

class AlibabaTranslationStream implements TranslationStreamInstance {
  readonly id: string;
  readonly subscription: string;
  readonly provider: TranslationProvider;
  readonly logger: Logger;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;

  state: TranslationStreamState = TranslationStreamState.INITIALIZING;
  startTime: number = Date.now();
  readyTime?: number;
  lastActivity: number = Date.now();
  lastError?: Error;

  metrics: TranslationStreamMetrics = {
    initializationTime: undefined,
    totalDuration: 0,
    audioChunksReceived: 0,
    audioChunksWritten: 0,
    audioDroppedCount: 0,
    audioWriteFailures: 0,
    consecutiveFailures: 0,
    lastSuccessfulWrite: undefined,
    translationsGenerated: 0,
    averageLatency: undefined,
    errorCount: 0,
    lastError: undefined,
  };

  callbacks: TranslationStreamOptions["callbacks"];

  private ws?: WebSocket;
  private isClosing = false;
  private disposed = false;
  private resources = new ResourceTracker();
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 3;
  private pendingAudioChunks: ArrayBuffer[] = [];
  private latencyMeasurements: number[] = [];

  constructor(
    options: TranslationStreamOptions,
    provider: TranslationProvider,
    private config: AlibabaTranslationConfig,
  ) {
    this.id = options.streamId;
    this.subscription = options.subscription;
    this.provider = provider;
    this.logger = options.userSession.logger.child({
      service: "AlibabaTranslationStream",
      streamId: this.id,
    });
    this.sourceLanguage = options.sourceLanguage;
    this.targetLanguage = options.targetLanguage;
    this.callbacks = options.callbacks;
  }

  async initialize(): Promise<void> {
    try {
      const initStartTime = Date.now();

      await this.connect();

      this.metrics.initializationTime = Date.now() - initStartTime;

      this.logger.info(
        {
          sourceLanguage: this.sourceLanguage,
          targetLanguage: this.targetLanguage,
          initTime: this.metrics.initializationTime,
        },
        "Alibaba translation stream initialized",
      );
    } catch (error) {
      this.logger.error({ error }, "Failed to initialize Alibaba translation stream");
      this.handleError(error as Error);
      throw error;
    }
  }

  async writeAudio(data: ArrayBuffer): Promise<boolean> {
    try {
      if (this.state !== TranslationStreamState.READY && this.state !== TranslationStreamState.ACTIVE) {
        // Buffer audio if still initializing
        if (this.state === TranslationStreamState.INITIALIZING) {
          this.pendingAudioChunks.push(data);
          return true;
        }
        this.metrics.audioDroppedCount++;
        return false;
      }

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.metrics.audioWriteFailures++;
        return false;
      }

      this.metrics.audioChunksReceived++;

      // Send audio data
      this.ws.send(data);

      this.metrics.audioChunksWritten++;
      this.metrics.lastSuccessfulWrite = Date.now();
      this.metrics.consecutiveFailures = 0;
      this.lastActivity = Date.now();

      return true;
    } catch (error) {
      this.logger.warn({ error }, "Failed to write audio to Alibaba translation stream");
      this.metrics.audioWriteFailures++;
      this.metrics.consecutiveFailures++;
      return false;
    }
  }

  getHealth(): TranslationStreamHealth {
    return {
      isAlive: this.state === TranslationStreamState.READY || this.state === TranslationStreamState.ACTIVE,
      lastActivity: this.lastActivity,
      consecutiveFailures: this.metrics.consecutiveFailures,
      lastSuccessfulWrite: this.metrics.lastSuccessfulWrite,
      providerHealth: this.provider.getHealthStatus(),
    };
  }

  async close(): Promise<void> {
    if (this.isClosing || this.state === TranslationStreamState.CLOSED || this.disposed) {
      return;
    }

    this.disposed = true;
    this.isClosing = true;
    this.state = TranslationStreamState.CLOSING;

    // Clean up all tracked resources (removes event listeners)
    this.resources.dispose();

    this.sendFinishTask();
  }

  private processPendingAudio(): void {
    if (this.pendingAudioChunks.length === 0) return;

    this.logger.debug({ count: this.pendingAudioChunks.length }, "Processing pending audio chunks");

    for (const chunk of this.pendingAudioChunks) {
      this.writeAudio(chunk);
    }

    this.pendingAudioChunks = [];
  }

  private async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        const wsUrl = this.config.endpoint;
        const headers = {
          Authorization: `Bearer ${this.config.dashscopeApiKey}`,
          "X-DashScope-WorkSpace": this.config.workspace,
          "X-DashScope-DataInspection": "enable",
        };
        const ws = new WebSocket(wsUrl, { headers });
        this.ws = ws;
        const connectionTimeout = setTimeout(() => {
          this.logger.error("Alibaba WebSocket connection timeout");
          this.ws?.terminate();
          reject(new Error("Alibaba WebSocket connection timeout"));
        }, 10000); // 10 second timeout

        // Store handler references for proper cleanup (prevents memory leaks)
        const openHandler = () => {
          if (this.disposed) return;
          clearTimeout(connectionTimeout);
          this.logger.debug("Alibaba translation WebSocket connected");
          this.sendRunTaskMessage();
          this.state = TranslationStreamState.READY;
          resolve();
        };

        const messageHandler = (data: WebSocket.Data) => {
          if (this.disposed) return;
          try {
            const message = JSON.parse(data.toString()) as AlibabaMessage;
            this.handleMessage(message);
            // Don't resolve here - Alibaba doesn't send 'ready' in the message handler
            // The actual ready state is handled in handleMessage
          } catch (error) {
            this.logger.error({ error }, "Alibaba translation WebSocket message error");
            this.handleError(error as Error);
          }
        };

        const errorHandler = (error: Error) => {
          if (this.disposed) return;
          this.logger.error({ error }, "Alibaba translation WebSocket error");
          this.handleError(
            new TranslationProviderError("Alibaba translation WebSocket error", TranslationProviderType.ALIBABA, error),
          );
          reject(error);
        };

        const closeHandler = (code: number, reason: Buffer) => {
          if (this.disposed) return;
          this.logger.info({ code, reason: reason.toString() }, "Alibaba translation WebSocket closed");
          if (!this.isClosing && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            this.logger.info(
              { attempt: this.reconnectAttempts },
              "Attempting to reconnect Alibaba translation WebSocket",
            );
            setTimeout(() => this.connect(), 1000 * this.reconnectAttempts);
          } else {
            this.state = TranslationStreamState.CLOSED;
            this.callbacks.onClosed?.();
          }
        };

        ws.on("open", openHandler);
        ws.on("message", messageHandler);
        ws.on("error", errorHandler);
        ws.on("close", closeHandler);

        // Track handlers for cleanup
        this.resources.track(() => {
          if (this.ws) {
            this.ws.off("open", openHandler);
            this.ws.off("message", messageHandler);
            this.ws.off("error", errorHandler);
            this.ws.off("close", closeHandler);
          }
        });
      } catch (error) {
        this.logger.error({ error }, "Failed to connect to Alibaba translation stream");
        reject(error);
      }
    });
  }

  private handleMessage(message: AlibabaMessage): void {
    this.lastActivity = Date.now();

    this.logger.info(
      {
        messageType: message.header.event,
        messageKeys: Object.keys(message),
        message: JSON.stringify(message).substring(0, 500),
      },
      "Alibaba translation message received",
    );

    switch (message.header.event) {
      case "task-started":
        this.logger.debug("Alibaba translation task started");
        this.state = TranslationStreamState.ACTIVE;
        this.processPendingAudio();
        break;
      case "result-generated":
        this.handleResult(message);
        break;
      case "task-finished":
        this.handleFinished();
        break;
      case "task-failed":
        // TODO: Do i need to close the websocket here?????
        this.handleError(
          new TranslationProviderError(
            `Alibaba translation error: ${message.header.error_message || "Unknown error"}`,
            TranslationProviderType.ALIBABA,
          ),
        );
        break;
      default:
        this.logger.warn(
          {
            messageType: message.header.event,
            fullMessage: message,
          },
          "Unhandled Alibaba message type - please check if this needs handling",
        );
    }
  }

  private handleResult(message: AlibabaMessage): void {
    try {
      // Create translation data
      this.lastActivity = Date.now();

      const originalText = message.payload.output.transcription?.text;
      const translatedText = message.payload.output.translations?.[0].text;
      const isFinal = message.payload.output.translations?.[0].sentence_end;
      const startTimeMs = message.payload.output.transcription?.begin_time;
      const endTimeMs = message.payload.output.transcription?.end_time;

      if (!originalText) return;
      if (!translatedText) {
        this.logger.warn(
          {
            targetLanguage: this.targetLanguage,
            availableTranslations: message.payload.output.translations ? ["translation"] : [],
          },
          "No translation found for target language",
        );
        return;
      }

      const translationData: TranslationData = {
        type: StreamType.TRANSLATION,
        text: translatedText || "",
        originalText: originalText || "",
        isFinal: isFinal!,
        startTime: startTimeMs!,
        endTime: endTimeMs!,
        speakerId: undefined,
        duration: endTimeMs! - startTimeMs!,
        transcribeLanguage: this.sourceLanguage,
        translateLanguage: this.targetLanguage,
        didTranslate: true,
        provider: "alibaba",
        confidence: undefined, // Alibaba doesn't provide confidence for translations
      };

      // Update metrics
      this.metrics.translationsGenerated++;

      // Calculate latency (approximate)
      // TODO: Fix this......
      const latency = Date.now() - (this.startTime + translationData.endTime);
      this.latencyMeasurements.push(latency);
      if (this.latencyMeasurements.length > 100) {
        this.latencyMeasurements.shift();
      }
      this.metrics.averageLatency =
        this.latencyMeasurements.reduce((a, b) => a + b, 0) / this.latencyMeasurements.length;

      // Send to callback
      this.callbacks.onData?.(translationData);

      this.logger.debug(
        {
          isFinal,
          originalText: originalText.substring(0, 50),
          translatedText: translatedText.substring(0, 50),
          languages: `${this.sourceLanguage} → ${this.targetLanguage}`,
        },
        "Alibaba translation result",
      );
    } catch (error) {
      this.logger.error({ error }, "Failed to handle Alibaba translation result");
      this.metrics.errorCount++;
    }
  }

  private handleError(error: Error): void {
    this.lastError = error;
    this.metrics.errorCount++;
    this.metrics.lastError = error;
    this.state = TranslationStreamState.ERROR;
    this.callbacks.onError?.(error);
  }

  private handleFinished(): void {
    this.logger.debug("Alibaba translation task finished");
    this.state = TranslationStreamState.CLOSED;
    this.callbacks.onClosed?.();
    // Update metrics
    this.metrics.totalDuration = Date.now() - this.startTime;

    this.logger.info(
      {
        streamId: this.id,
        duration: this.metrics.totalDuration,
        translationsGenerated: this.metrics.translationsGenerated,
        averageLatency: this.metrics.averageLatency,
      },
      "Alibaba translation stream closed",
    );
  }

  private sendRunTaskMessage(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // TODO: check the source language. if all send auto else send the source language????
    // TODO: Do I need to use some other id????
    const TASK_ID = this.id;
    const runTaskMessage = {
      header: {
        action: "run-task",
        task_id: TASK_ID,
        streaming: "duplex",
      },
      payload: {
        task_group: "audio",
        task: "asr",
        function: "recognition",
        model: "gummy-realtime-v1",
        parameters: {
          source_language: this.normalizeLanguage(this.sourceLanguage),
          sample_rate: 16000,
          format: "wav",
          transcription_enabled: true,
          translation_enabled: true,
          translation_target_languages: [this.normalizeLanguage(this.targetLanguage)],
        },
        input: {},
      },
    };
    this.ws.send(JSON.stringify(runTaskMessage));
  }

  private sendFinishTask() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const finishTaskMessage = {
      header: {
        action: "finish-task",
        task_id: this.id,
        streaming: "duplex",
      },
      payload: {
        input: {},
      },
    };
    this.ws.send(JSON.stringify(finishTaskMessage));
  }

  private normalizeLanguage(language: string): string {
    // TODO: Handle the all language code. if that's possible???
    const baseLanguage = language.split("-")[0].toLowerCase();
    return baseLanguage;
  }
}

export class AlibabaTranslationProvider implements TranslationProvider {
  readonly name = TranslationProviderType.ALIBABA;
  readonly logger: Logger;

  private isInitialized = false;
  private healthStatus: TranslationProviderHealthStatus = {
    isHealthy: true,
    lastCheck: Date.now(),
    failures: 0,
  };

  private supportedLanguagePairs: Record<string, string[]> = {
    zh: ["en", "ja", "ko"],
    en: ["zh", "ja", "ko"],
    ja: ["zh", "en"],
    ko: ["zh", "en"],
    yue: ["zh", "en"],
    de: ["zh", "en"],
    fr: ["zh", "en"],
    ru: ["zh", "en"],
    it: ["zh", "en"],
    es: ["zh", "en"],
  };

  constructor(
    private config: AlibabaTranslationConfig,
    parentLogger: Logger,
  ) {
    this.logger = parentLogger.child({ provider: "alibaba-translation" });
  }

  async initialize(): Promise<void> {
    try {
      // TODO: Check if keys and all present. If yes fine. Else throw error
      this.isInitialized = true;
      this.logger.info("Alibaba translation provider initialized");
    } catch (error) {
      this.logger.error({ error }, "Failed to initialize Alibaba translation provider");
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.isInitialized = false;
    this.logger.info("Alibaba translation provider disposed");
  }

  async createTranslationStream(options: TranslationStreamOptions): Promise<TranslationStreamInstance> {
    if (!this.isInitialized) {
      throw new Error("Alibaba translation provider not initialized");
    }

    const stream = new AlibabaTranslationStream(options, this, this.config);
    await stream.initialize();

    this.recordSuccess();
    return stream;
  }

  supportsLanguagePair(source: string, target: string): boolean {
    const sourceBase = source.split("-")[0].toLowerCase();
    const targetBase = target.split("-")[0].toLowerCase();

    // Can't translate to same language
    if (sourceBase === targetBase) return false;

    return this.supportedLanguagePairs[sourceBase].includes(targetBase);
  }

  supportsAutoDetection(): boolean {
    return true;
  }

  getCapabilities(): TranslationProviderCapabilities {
    const supportedPairs = new Map<string, string[]>();

    // Build language pairs map
    for (const source of Object.keys(this.supportedLanguagePairs)) {
      for (const target of this.supportedLanguagePairs[source]) {
        if (source !== target) {
          supportedPairs.set(source, [target]);
        }
      }
    }

    return {
      supportedLanguagePairs: supportedPairs,
      supportsAutoDetection: true,
      supportsRealtimeTranslation: true,
      maxConcurrentStreams: 10,
    };
  }

  getHealthStatus(): TranslationProviderHealthStatus {
    return { ...this.healthStatus };
  }

  recordFailure(error: Error): void {
    this.healthStatus.failures++;
    this.healthStatus.lastFailure = Date.now();
    this.healthStatus.reason = error.message;

    // Mark unhealthy after 3 consecutive failures
    if (this.healthStatus.failures >= 3) {
      this.healthStatus.isHealthy = false;
    }
  }

  recordSuccess(): void {
    this.healthStatus.failures = 0;
    this.healthStatus.isHealthy = true;
    this.healthStatus.lastCheck = Date.now();
    delete this.healthStatus.reason;
  }
}
