import { Logger } from "pino";
import WebSocket from "ws";

import { getLanguageInfo, StreamType, TranscriptionData } from "@mentra/sdk";

import { ResourceTracker } from "../../../../utils/resource-tracker";
import {
  AlibabaProviderConfig,
  ProviderHealthStatus,
  ProviderLanguageCapabilities,
  ProviderType,
  StreamCallbacks,
  StreamHealth,
  StreamInstance,
  StreamMetrics,
  StreamOptions,
  StreamState,
  TranscriptionProvider,
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

class AlibabaTranscriptionStream implements StreamInstance {
  public state = StreamState.INITIALIZING;
  public startTime = Date.now();
  public readyTime?: number;
  public lastActivity = Date.now();
  public lastError?: Error;
  public metrics: StreamMetrics;

  private ws?: WebSocket;
  private connectionTimeout?: NodeJS.Timeout;
  private isClosing = false;
  private disposed = false;
  private resources = new ResourceTracker();
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 3;

  private pendingAudioChunks: ArrayBuffer[] = [];

  private isConfigSent = false;
  // Rolling compaction: maintain finalized prefix as plain text; retain only current tail tokens
  private stablePrefixText: string = "";
  private lastSentInterim = ""; // Track last sent interim to avoid duplicates

  constructor(
    public readonly id: string,
    public readonly subscription: string,
    public readonly provider: AlibabaTranscriptionProvider,
    public readonly language: string,
    public readonly targetLanguage: string | undefined,
    public readonly callbacks: StreamCallbacks,
    public readonly logger: Logger,
    private readonly config: AlibabaProviderConfig,
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

  async initialize(): Promise<void> {
    try {
      const initStartTime = Date.now();

      await this.connect();

      this.metrics.initializationTime = Date.now() - initStartTime;

      this.logger.debug({ streamId: this.id }, "Alibaba transcription stream initialized");
    } catch (error) {
      this.logger.error({ error }, "Failed to initialize Alibaba transcription stream");
      this.handleError(error as Error);
      throw error;
    }
  }

  async writeAudio(data: ArrayBuffer): Promise<boolean> {
    try {
      if (this.state !== StreamState.READY && this.state !== StreamState.ACTIVE) {
        // Buffer audio if still initializing
        if (this.state === StreamState.INITIALIZING) {
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
      this.logger.warn({ error }, "Failed to write audio to Alibaba transcription stream");
      this.metrics.audioWriteFailures++;
      this.metrics.consecutiveFailures++;
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.isClosing || this.state === StreamState.CLOSED || this.disposed) {
      return;
    }

    this.disposed = true;
    this.isClosing = true;
    this.state = StreamState.CLOSING;

    // Clean up all tracked resources (removes event listeners)
    this.resources.dispose();

    this.sendFinishTask();
  }

  getHealth(): StreamHealth {
    return {
      isAlive: this.state === StreamState.READY || this.state === StreamState.ACTIVE,
      lastActivity: this.lastActivity,
      consecutiveFailures: this.metrics.consecutiveFailures,
      lastSuccessfulWrite: this.metrics.lastSuccessfulWrite,
      providerHealth: this.provider.getHealthStatus(),
    };
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
          this.logger.debug("Alibaba transcription WebSocket connected");
          this.sendRunTaskMessage();
          this.state = StreamState.READY;
          resolve();
        };

        const messageHandler = (data: Buffer) => {
          if (this.disposed) return;
          try {
            const message = JSON.parse(data.toString()) as AlibabaMessage;
            this.handleMessage(message);
            // Don't resolve here - Alibaba doesn't send 'ready' in the message handler
            // The actual ready state is handled in handleMessage
          } catch (error) {
            this.logger.error({ error }, "Alibaba transcription WebSocket message error");
            this.handleError(error as Error);
          }
        };

        const errorHandler = (error: Error) => {
          if (this.disposed) return;
          this.logger.error({ error }, "Alibaba transcription WebSocket error");
          this.handleError(error);
          reject(error);
        };

        const closeHandler = (code: number, reason: Buffer) => {
          if (this.disposed) return;
          this.logger.info({ code, reason: reason.toString() }, "Alibaba transcription WebSocket closed");
          if (!this.isClosing && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            this.logger.info(
              { attempt: this.reconnectAttempts },
              "Attempting to reconnect Alibaba transcription WebSocket",
            );
            setTimeout(() => this.connect(), 1000 * this.reconnectAttempts);
          } else {
            this.state = StreamState.CLOSED;
            this.callbacks.onClosed?.(code);
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
        this.logger.error({ error }, "Failed to connect to Alibaba transcription stream");
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
      "Alibaba transcription message received",
    );

    switch (message.header.event) {
      case "task-started":
        this.logger.debug("Alibaba transcription task started");
        this.state = StreamState.ACTIVE;
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
        this.handleError(new Error(`Alibaba transcription error: ${message.header.error_message || "Unknown error"}`));
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

  private handleError(error: Error): void {
    this.state = StreamState.ERROR;
    this.lastError = error;
    this.metrics.errorCount++;
    this.metrics.consecutiveFailures++;

    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = undefined;
    }

    // Reset rolling state on error to prevent stale data
    this.stablePrefixText = "";
    this.lastSentInterim = "";

    this.provider.recordFailure(error);

    if (this.callbacks.onError) {
      this.callbacks.onError(error);
    }
  }

  private handleResult(message: AlibabaMessage): void {
    try {
      this.lastActivity = Date.now();

      const originalText = message.payload.output.transcription?.text;
      const isFinal = message.payload.output.transcription?.sentence_end;
      const startTimeMs = message.payload.output.transcription?.begin_time;
      const endTimeMs = message.payload.output.transcription?.end_time;

      if (!originalText) return;

      const transcriptionData: TranscriptionData = {
        type: StreamType.TRANSCRIPTION,
        text: originalText || "",
        isFinal: isFinal!,
        startTime: startTimeMs!,
        endTime: endTimeMs!,
        speakerId: undefined,
        duration: endTimeMs! - startTimeMs!,
        transcribeLanguage: this.language,
        provider: "alibaba",
        confidence: undefined,
      };

      this.callbacks.onData?.(transcriptionData);

      this.logger.debug(
        {
          isFinal,
          originalText: originalText.substring(0, 50),
          languages: `${this.language}`,
        },
        "Alibaba transcription result",
      );
    } catch (error) {
      this.logger.error({ error }, "Failed to handle Alibaba transcription result");
      this.metrics.errorCount++;
    }
  }

  private handleFinished(): void {
    this.logger.debug("Alibaba transcription task finished");
    this.state = StreamState.CLOSED;
    // Pass 1000 (normal close) since this is an intentional/expected completion
    this.callbacks.onClosed?.(1000);
    // Update metrics
    this.metrics.totalDuration = Date.now() - this.startTime;

    this.logger.info(
      {
        streamId: this.id,
        duration: this.metrics.totalDuration,
      },
      "Alibaba transcription stream closed",
    );
  }

  private processPendingAudio(): void {
    if (this.pendingAudioChunks.length === 0) return;

    this.logger.debug({ count: this.pendingAudioChunks.length }, "Processing pending audio chunks");

    for (const chunk of this.pendingAudioChunks) {
      this.writeAudio(chunk);
    }

    this.pendingAudioChunks = [];
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
          source_language: this.normalizeLanguage(this.language),
          sample_rate: 16000,
          format: "wav",
          transcription_enabled: true,
          translation_enabled: false,
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

export class AlibabaTranscriptionProvider implements TranscriptionProvider {
  readonly name = ProviderType.ALIBABA;
  readonly logger: Logger;

  private isInitialized = false;
  private healthStatus: ProviderHealthStatus;
  private failureCount = 0;
  private lastFailureTime = 0;

  private GUMMY_REALTIME_SUPPORTED_LANGUAGES: string[] = ["zh", "en", "ja", "ko", "yue", "de", "fr", "ru", "it", "es"];

  constructor(
    private config: AlibabaProviderConfig,
    parentLogger: Logger,
  ) {
    this.logger = parentLogger.child({ provider: this.name });

    this.healthStatus = {
      isHealthy: true,
      lastCheck: Date.now(),
      failures: 0,
    };

    this.logger.info(
      {
        supportedLanguages: this.GUMMY_REALTIME_SUPPORTED_LANGUAGES.length,
        languages: this.GUMMY_REALTIME_SUPPORTED_LANGUAGES,
      },
      `Alibaba provider initialized with ${this.GUMMY_REALTIME_SUPPORTED_LANGUAGES.length} supported languages`,
    );
  }

  async initialize(): Promise<void> {
    this.logger.info("Initializing Alibaba provider");

    if (!this.config.dashscopeApiKey || !this.config.workspace) {
      throw new Error("Alibaba API key and workspace are required");
    }

    // TODO: Initialize actual Alibaba client when implementing
    this.isInitialized = true;
    this.logger.info(
      {
        endpoint: this.config.endpoint,
        keyLength: this.config.dashscopeApiKey.length,
      },
      "Alibaba provider initialized (stub)",
    );
  }

  async dispose(): Promise<void> {
    this.isInitialized = false;
    this.logger.info("Disposing Alibaba provider");
    // TODO: Cleanup Alibaba client when implementing
  }

  async createTranscriptionStream(language: string, options: StreamOptions): Promise<StreamInstance> {
    if (!this.isInitialized) {
      throw new Error("Alibaba transcription provider not initialized");
    }

    this.logger.debug(
      {
        language,
        options,
      },
      "Creating Alibaba transcription stream",
    );

    if (!this.supportsLanguage(language)) {
      throw new Error(`Language ${language} not supported by Alibaba`);
    }

    const stream = new AlibabaTranscriptionStream(
      options.streamId,
      options.subscription,
      this,
      language,
      undefined,
      options.callbacks,
      this.logger,
      this.config,
    );

    // Initialize WebSocket connection
    await stream.initialize();

    return stream;
  }

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
    const baseLanguage = language.split("-")[0].toLowerCase();
    return this.GUMMY_REALTIME_SUPPORTED_LANGUAGES.includes(baseLanguage);
  }

  getLanguageCapabilities(): ProviderLanguageCapabilities {
    return {
      transcriptionLanguages: this.GUMMY_REALTIME_SUPPORTED_LANGUAGES,
      autoLanguageDetection: true, // Soniox supports auto language detection
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
    return this.lastFailureTime && now - this.lastFailureTime < timeWindowMs ? this.failureCount : 0;
  }
}
