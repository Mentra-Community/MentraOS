/**
 * @fileoverview Soniox Translation Provider
 * Uses Soniox's unified transcription+translation API but only extracts translation data
 */

import { Logger } from "pino";
import WebSocket from "ws";

import { TranslationData, StreamType } from "@mentra/sdk";

import { ResourceTracker } from "../../../../utils/resource-tracker";
import {
  TranslationProvider,
  TranslationProviderType,
  TranslationProviderHealthStatus,
  TranslationProviderCapabilities,
  TranslationStreamOptions,
  TranslationStreamInstance,
  SonioxTranslationConfig,
  TranslationStreamState,
  TranslationStreamMetrics,
  TranslationStreamHealth,
  TranslationProviderError,
  InvalidLanguagePairError,
} from "../types";

import { SonioxTranslationUtils } from "./SonioxTranslationUtils";

/**
 * Soniox API message types
 */
interface SonioxMessage {
  type: string;
  [key: string]: any;
}

interface SonioxToken {
  text: string;
  start_ms?: number;
  duration_ms?: number;
  is_final: boolean;
  translation_status?: "original" | "translation";
  language?: string;
  source_language?: string;
}

// SonioxResult interface not needed with new token-based approach

/**
 * Soniox-specific translation stream implementation
 */
class SonioxTranslationStream implements TranslationStreamInstance {
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

  // Two-way translation tracking
  private isTwoWay = false;
  private langA?: string;
  private langB?: string;

  // Language-aware utterance tracking - NEW APPROACH
  // Map of sourceLanguage -> utterance data
  private utterancesByLanguage = new Map<
    string,
    {
      startTime?: number;
      originalTokens: SonioxToken[];
      translationTokens: SonioxToken[];
      targetLanguage?: string;
      lastOriginalEndTime?: number;
      waitingForTranslation: boolean;
    }
  >();

  // Track when we last saw tokens for each language to detect switches
  private lastTokenTimeByLanguage = new Map<string, number>();

  // Timeout for waiting for translation tokens
  private translationWaitTimeoutMs = 3000; // 3 seconds
  private utteranceTimeouts = new Map<string, NodeJS.Timeout>();

  constructor(
    options: TranslationStreamOptions,
    provider: TranslationProvider,
    private config: SonioxTranslationConfig,
  ) {
    this.id = options.streamId;
    this.subscription = options.subscription;
    this.provider = provider;
    this.logger = options.userSession.logger.child({
      service: "SonioxTranslationStream",
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
        "Soniox translation stream initialized",
      );
    } catch (error) {
      this.logger.error({ error }, "Failed to initialize Soniox translation stream");
      this.handleError(error as Error);
      throw error;
    }
  }

  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Create WebSocket connection
        const wsUrl = this.config.endpoint;
        this.logger.debug({ wsUrl }, "Connecting to Soniox WebSocket");
        this.ws = new WebSocket(wsUrl);

        // Set connection timeout
        const connectionTimeout = setTimeout(() => {
          this.logger.error("Soniox WebSocket connection timeout");
          this.ws?.terminate();
          reject(new Error("Soniox WebSocket connection timeout"));
        }, 10000); // 10 second timeout

        // Store handler references for proper cleanup (prevents memory leaks)
        const openHandler = () => {
          if (this.disposed) return;
          clearTimeout(connectionTimeout);
          this.logger.debug("Soniox translation WebSocket connected");
          this.sendConfigMessage();
          // Resolve after sending config
          resolve();
        };

        const messageHandler = (data: WebSocket.Data) => {
          if (this.disposed) return;
          try {
            const message = JSON.parse(data.toString()) as SonioxMessage;
            this.handleMessage(message);

            // Don't resolve here - Soniox doesn't send 'ready' in the message handler
            // The actual ready state is handled in handleMessage
          } catch (error) {
            this.logger.error({ error, data: data.toString() }, "Error parsing Soniox message");
          }
        };

        const errorHandler = (error: Error) => {
          if (this.disposed) return;
          this.logger.error({ error }, "Soniox translation WebSocket error");
          this.handleError(
            new TranslationProviderError(
              `Soniox WebSocket error: ${error.message}`,
              TranslationProviderType.SONIOX,
              error,
            ),
          );
          reject(error);
        };

        const closeHandler = (code: number, reason: Buffer) => {
          if (this.disposed) return;
          this.logger.info({ code, reason: reason.toString() }, "Soniox translation WebSocket closed");

          if (!this.isClosing && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            this.logger.info(
              { attempt: this.reconnectAttempts },
              "Attempting to reconnect Soniox translation WebSocket",
            );
            setTimeout(() => this.connect(), 1000 * this.reconnectAttempts);
          } else {
            this.state = TranslationStreamState.CLOSED;
            this.callbacks.onClosed?.();
          }
        };

        this.ws.on("open", openHandler);
        this.ws.on("message", messageHandler);
        this.ws.on("error", errorHandler);
        this.ws.on("close", closeHandler);

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
        this.logger.error({ error }, "Failed to create Soniox translation WebSocket");
        reject(error);
      }
    });
  }

  private sendConfigMessage(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Check if this is "all-to-LANG" format (one-way from any language)
    const isAllToFormat = this.sourceLanguage === "all";

    // Normalize language codes for Soniox
    const sourceLang = isAllToFormat ? "auto" : this.normalizeLanguageCode(this.sourceLanguage);
    const targetLang = this.normalizeLanguageCode(this.targetLanguage);

    // Build translation config optimized for translation only
    let translationConfig: any;

    if (isAllToFormat) {
      // One-way translation from ALL languages to target
      this.isTwoWay = false;

      translationConfig = {
        type: "one_way",
        target_language: targetLang,
      };

      this.logger.debug(
        {
          format: "all-to-target",
          targetLanguage: targetLang,
        },
        "Using one-way translation from all languages",
      );
    } else if (this.isTwoWayPair(sourceLang, targetLang)) {
      // Two-way translation between specific language pair
      // This gives better accuracy with language hints
      this.isTwoWay = true;
      this.langA = sourceLang;
      this.langB = targetLang;

      translationConfig = {
        type: "two_way",
        language_a: sourceLang,
        language_b: targetLang,
      };

      this.logger.debug(
        {
          format: "two-way",
          languageA: sourceLang,
          languageB: targetLang,
        },
        "Using two-way translation with language hints for better accuracy",
      );
    } else {
      // One-way translation from specific source to target
      this.isTwoWay = false;

      translationConfig = {
        type: "one_way",
        target_language: targetLang,
      };

      // If source is specific, set it as hint
      if (sourceLang !== "auto") {
        translationConfig.source_languages = [sourceLang];
      }

      this.logger.debug(
        {
          format: "one-way",
          sourceLanguage: sourceLang,
          targetLanguage: targetLang,
        },
        "Using one-way translation with specific source",
      );
    }

    const config = {
      api_key: this.config.apiKey,
      model: this.config.model || "stt-rt-v4",
      audio_format: "pcm_s16le",
      sample_rate: 16000,
      num_channels: 1,
      language: sourceLang === "auto" ? "auto" : sourceLang,
      translation: translationConfig,

      // Enable language identification for better accuracy
      enable_language_identification: true,

      // Optimize for translation
      include_nonfinal: false, // for translation, we don't need non final results.
      enable_endpoint_detection: true,

      // max time for final.
      max_non_final_tokens_duration_ms: 2000,
    };

    this.ws.send(JSON.stringify(config));

    this.logger.debug(
      {
        translationType: translationConfig.type,
        sourceLanguage: this.sourceLanguage,
        targetLanguage: this.targetLanguage,
        normalizedSource: sourceLang,
        normalizedTarget: targetLang,
        isAllToFormat,
        isTwoWay: this.isTwoWay,
      },
      "Sent Soniox translation config",
    );

    // Mark as ready after config is sent (Soniox pattern)
    setTimeout(() => {
      if (this.state === TranslationStreamState.INITIALIZING) {
        this.state = TranslationStreamState.READY;
        this.readyTime = Date.now();
        this.callbacks.onReady?.();

        this.logger.info(
          {
            streamId: this.id,
            initTime: this.readyTime - this.startTime,
          },
          "Soniox translation stream ready",
        );
      }
    }, 1000); // Give Soniox a moment to process config
  }

  private handleMessage(message: SonioxMessage): void {
    this.lastActivity = Date.now();

    // Check if this is a tokens message (Soniox doesn't always send a 'type' field)
    if ("tokens" in message && Array.isArray(message.tokens)) {
      // This is a result message with tokens
      this.handleResult(message);
      return;
    }

    // Enhanced logging to identify message types
    this.logger.info(
      {
        messageType: message.type,
        messageKeys: Object.keys(message),
        message: JSON.stringify(message).substring(0, 500),
      },
      "Soniox message received",
    );

    switch (message.type) {
      case "result":
        this.handleResult(message);
        break;

      case "error":
        this.handleError(
          new TranslationProviderError(
            `Soniox error: ${message.message || "Unknown error"}`,
            TranslationProviderType.SONIOX,
          ),
        );
        break;

      case "ready":
        this.logger.debug("Soniox translation stream ready");
        this.state = TranslationStreamState.ACTIVE;
        // Process any pending audio
        this.processPendingAudio();
        break;

      default:
        this.logger.warn(
          {
            messageType: message.type,
            fullMessage: message,
          },
          "Unhandled Soniox message type - please check if this needs handling",
        );
    }
  }

  private handleResult(message: SonioxMessage): void {
    try {
      // For token messages, the tokens are directly in the message
      const tokens = message.tokens as SonioxToken[];

      if (!tokens || !Array.isArray(tokens)) {
        this.logger.warn(
          {
            messageKeys: Object.keys(message),
          },
          "Soniox result message does not contain tokens array",
        );
        return;
      }

      // Process tokens by language
      const tokensByLanguage = new Map<
        string,
        {
          original: SonioxToken[];
          translation: SonioxToken[];
          hasEnd: boolean;
        }
      >();

      // First pass: organize tokens by language
      for (const token of tokens) {
        // Skip <end> tokens but track them
        if (token.text === "<end>") {
          // Mark end for all active languages
          for (const langData of tokensByLanguage.values()) {
            langData.hasEnd = true;
          }
          continue;
        }

        // Process final tokens only
        if (!token.is_final) continue;

        // Determine the source language
        let sourceLang: string | undefined;
        if (token.translation_status === "original") {
          sourceLang = this.normalizeLanguageCode(token.language || "");
        } else if (token.translation_status === "translation") {
          sourceLang = this.normalizeLanguageCode(token.source_language || "");
        }

        if (!sourceLang) continue;

        // Initialize language data if needed
        if (!tokensByLanguage.has(sourceLang)) {
          tokensByLanguage.set(sourceLang, {
            original: [],
            translation: [],
            hasEnd: false,
          });
        }

        // Add token to appropriate array
        const langData = tokensByLanguage.get(sourceLang)!;
        if (token.translation_status === "original") {
          langData.original.push(token);
        } else if (token.translation_status === "translation") {
          langData.translation.push(token);
        }
      }

      // Second pass: process each language's tokens
      for (const [sourceLang, langData] of tokensByLanguage) {
        // Get or create utterance for this language
        let utterance = this.utterancesByLanguage.get(sourceLang);
        if (!utterance) {
          // Determine target language
          let targetLang = this.targetLanguage;
          if (this.isTwoWay) {
            targetLang = sourceLang === this.langA ? this.langB! : this.langA!;
          }

          utterance = {
            originalTokens: [],
            translationTokens: [],
            targetLanguage: targetLang,
            waitingForTranslation: false,
          };
          this.utterancesByLanguage.set(sourceLang, utterance);
        }

        // Add new tokens
        if (langData.original.length > 0) {
          utterance.originalTokens.push(...langData.original);

          // Update timing
          if (!utterance.startTime && langData.original.length > 0) {
            utterance.startTime = langData.original[0].start_ms || 0;
          }

          const lastOriginal = langData.original[langData.original.length - 1];
          utterance.lastOriginalEndTime = (lastOriginal.start_ms || 0) + (lastOriginal.duration_ms || 0);

          // Mark that we're waiting for translation
          if (!utterance.waitingForTranslation && langData.translation.length === 0) {
            utterance.waitingForTranslation = true;
            this.startTranslationTimeout(sourceLang);
          }
        }

        if (langData.translation.length > 0) {
          utterance.translationTokens.push(...langData.translation);

          // Clear waiting flag and timeout
          if (utterance.waitingForTranslation) {
            utterance.waitingForTranslation = false;
            this.clearTranslationTimeout(sourceLang);
          }
        }

        // Update last seen time for this language
        this.lastTokenTimeByLanguage.set(sourceLang, Date.now());

        // Check if we should send this utterance
        const shouldSend =
          utterance.translationTokens.length > 0 && // Have translation
          (langData.hasEnd || // End token received
            (utterance.originalTokens.length > 0 && !utterance.waitingForTranslation)); // Have complete pair

        if (shouldSend) {
          this.sendLanguageUtterance(sourceLang, langData.hasEnd, langData.hasEnd ? "end_token" : "complete_pair");
        }

        // Clear utterance if we hit an end token
        if (langData.hasEnd) {
          this.clearLanguageUtterance(sourceLang);
        }
      }
    } catch (error) {
      this.logger.error({ error }, "Error handling Soniox translation result");
      this.metrics.errorCount++;
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
      this.logger.warn({ error }, "Failed to write audio to Soniox translation stream");
      this.metrics.audioWriteFailures++;
      this.metrics.consecutiveFailures++;
      return false;
    }
  }

  private processPendingAudio(): void {
    if (this.pendingAudioChunks.length === 0) return;

    this.logger.debug({ count: this.pendingAudioChunks.length }, "Processing pending audio chunks");

    for (const chunk of this.pendingAudioChunks) {
      this.writeAudio(chunk);
    }

    this.pendingAudioChunks = [];
  }

  async close(): Promise<void> {
    if (this.isClosing || this.state === TranslationStreamState.CLOSED || this.disposed) {
      return;
    }

    this.disposed = true;
    this.isClosing = true;
    this.state = TranslationStreamState.CLOSING;

    try {
      // Clean up all tracked resources (removes event listeners)
      this.resources.dispose();

      // Send any remaining utterance data for all languages
      for (const [sourceLang, utterance] of this.utterancesByLanguage) {
        if (utterance.translationTokens.length > 0 || utterance.originalTokens.length > 0) {
          this.logger.info(
            {
              sourceLang,
              originalTokens: utterance.originalTokens.length,
              translationTokens: utterance.translationTokens.length,
              waitingForTranslation: utterance.waitingForTranslation,
            },
            "Sending final utterance on stream close",
          );

          this.sendLanguageUtterance(sourceLang, true, "stream_close");
        }
      }

      // Clear all language utterances and timeouts
      for (const sourceLang of this.utterancesByLanguage.keys()) {
        this.clearLanguageUtterance(sourceLang);
      }

      // Clear all buffers
      this.utterancesByLanguage.clear();
      for (const timeout of this.utteranceTimeouts.values()) {
        clearTimeout(timeout);
      }
      this.utteranceTimeouts.clear();
      this.lastTokenTimeByLanguage.clear();

      // Send final message
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "final" }));

        // Give it a moment to send
        await new Promise((resolve) => setTimeout(resolve, 100));

        this.ws.close();
      }

      // Update metrics
      this.metrics.totalDuration = Date.now() - this.startTime;

      this.state = TranslationStreamState.CLOSED;
      this.callbacks.onClosed?.();

      this.logger.info(
        {
          streamId: this.id,
          duration: this.metrics.totalDuration,
          translationsGenerated: this.metrics.translationsGenerated,
          averageLatency: this.metrics.averageLatency,
        },
        "Soniox translation stream closed",
      );
    } catch (error) {
      this.logger.error({ error }, "Error closing Soniox translation stream");
      this.state = TranslationStreamState.CLOSED;
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

  private handleError(error: Error): void {
    this.lastError = error;
    this.metrics.errorCount++;
    this.metrics.lastError = error;
    this.state = TranslationStreamState.ERROR;
    this.callbacks.onError?.(error);
  }

  private normalizeLanguageCode(languageCode: string): string {
    // Use the utility for consistent language normalization
    return SonioxTranslationUtils.normalizeLanguageCode(languageCode);
  }

  private isTwoWayPair(source: string, target: string): boolean {
    // Use the utility to check against actual Soniox two-way pairs
    return SonioxTranslationUtils.supportsTwoWayTranslation(source, target);
  }

  private getFullLanguageCode(normalizedCode: string): string {
    // Convert normalized language codes back to full BCP-47 codes for SDK compatibility
    // This ensures apps receive language codes in the expected format (e.g., 'en-US' not 'en')
    const languageMap: Record<string, string> = {
      af: "af-ZA",
      ar: "ar-SA",
      az: "az-AZ",
      be: "be-BY",
      bg: "bg-BG",
      bn: "bn-BD",
      bs: "bs-BA",
      ca: "ca-ES",
      cs: "cs-CZ",
      cy: "cy-GB",
      da: "da-DK",
      de: "de-DE",
      el: "el-GR",
      en: "en-US",
      es: "es-ES",
      et: "et-EE",
      eu: "eu-ES",
      fa: "fa-IR",
      fi: "fi-FI",
      fr: "fr-FR",
      gl: "gl-ES",
      gu: "gu-IN",
      he: "iw-IL",
      hi: "hi-IN",
      hr: "hr-HR",
      hu: "hu-HU",
      id: "id-ID",
      it: "it-IT",
      ja: "ja-JP",
      kk: "kk-KZ",
      kn: "kn-IN",
      ko: "ko-KR",
      lt: "lt-LT",
      lv: "lv-LV",
      mk: "mk-MK",
      ml: "ml-IN",
      mr: "mr-IN",
      ms: "ms-MY",
      nl: "nl-NL",
      no: "nb-NO",
      pa: "pa-IN",
      pl: "pl-PL",
      pt: "pt-PT",
      ro: "ro-RO",
      ru: "ru-RU",
      sk: "sk-SK",
      sl: "sl-SI",
      sq: "sq-AL",
      sr: "sr-RS",
      sv: "sv-SE",
      sw: "sw-KE",
      ta: "ta-IN",
      te: "te-IN",
      th: "th-TH",
      tl: "tl-PH",
      tr: "tr-TR",
      uk: "uk-UA",
      ur: "ur-PK",
      vi: "vi-VN",
      zh: "zh-CN",
    };

    return languageMap[normalizedCode] || normalizedCode;
  }

  private sendLanguageUtterance(sourceLang: string, isFinal: boolean, reason: string): void {
    const utterance = this.utterancesByLanguage.get(sourceLang);
    if (!utterance || utterance.translationTokens.length === 0) {
      return; // Nothing to send
    }

    // Build texts from tokens
    const originalText = utterance.originalTokens.map((t) => t.text).join("");
    const translationText = utterance.translationTokens.map((t) => t.text).join("");

    // Calculate timing
    const utteranceStartTime = utterance.startTime || 0;
    let endTime = utteranceStartTime;

    // Use translation tokens for end time (they usually come after original)
    if (utterance.translationTokens.length > 0) {
      const lastToken = utterance.translationTokens[utterance.translationTokens.length - 1];
      endTime = (lastToken.start_ms || 0) + (lastToken.duration_ms || 0);
    } else if (utterance.lastOriginalEndTime) {
      endTime = utterance.lastOriginalEndTime;
    }

    // Create translation data with original text
    // Use full language codes for SDK compatibility (e.g., 'en-US' instead of 'en')
    const transcribeLanguageCode = this.getFullLanguageCode(sourceLang);
    const translateLanguageCode = this.getFullLanguageCode(utterance.targetLanguage!);

    const translationData: TranslationData = {
      type: StreamType.TRANSLATION,
      text: translationText,
      originalText: originalText || undefined, // Include original text
      isFinal,
      startTime: utteranceStartTime,
      endTime,
      speakerId: undefined,
      duration: endTime - utteranceStartTime,
      transcribeLanguage: transcribeLanguageCode,
      translateLanguage: translateLanguageCode,
      didTranslate: true,
      provider: "soniox",
      confidence: undefined,
    };

    // Update metrics
    this.metrics.translationsGenerated++;

    // Calculate latency
    const latency = Date.now() - this.startTime - endTime;
    this.latencyMeasurements.push(latency);
    if (this.latencyMeasurements.length > 100) {
      this.latencyMeasurements.shift();
    }
    this.metrics.averageLatency = this.latencyMeasurements.reduce((a, b) => a + b, 0) / this.latencyMeasurements.length;

    // Send to callback
    this.callbacks.onData?.(translationData);

    this.logger.info(
      {
        originalText: originalText ? originalText.substring(0, 50) + "..." : "none",
        translatedText: translationText.substring(0, 50) + "...",
        isFinal,
        reason,
        languages: `${sourceLang} → ${utterance.targetLanguage}`,
        originalTokens: utterance.originalTokens.length,
        translationTokens: utterance.translationTokens.length,
      },
      "Sent language-specific utterance",
    );
  }

  private clearLanguageUtterance(sourceLang: string): void {
    // Clear the utterance data
    this.utterancesByLanguage.delete(sourceLang);

    // Clear any pending timeout
    this.clearTranslationTimeout(sourceLang);

    this.logger.debug(
      {
        sourceLang,
      },
      "Cleared utterance for language",
    );
  }

  private startTranslationTimeout(sourceLang: string): void {
    // Clear any existing timeout
    this.clearTranslationTimeout(sourceLang);

    // Set new timeout
    const timeout = setTimeout(() => {
      const utterance = this.utterancesByLanguage.get(sourceLang);
      if (utterance && utterance.originalTokens.length > 0 && utterance.waitingForTranslation) {
        this.logger.warn(
          {
            sourceLang,
            originalTokens: utterance.originalTokens.length,
            timeoutMs: this.translationWaitTimeoutMs,
          },
          "Translation timeout - sending without translation",
        );

        // Send what we have as final
        this.sendLanguageUtterance(sourceLang, true, "translation_timeout");
        this.clearLanguageUtterance(sourceLang);
      }
    }, this.translationWaitTimeoutMs);

    this.utteranceTimeouts.set(sourceLang, timeout);
  }

  private clearTranslationTimeout(sourceLang: string): void {
    const timeout = this.utteranceTimeouts.get(sourceLang);
    if (timeout) {
      clearTimeout(timeout);
      this.utteranceTimeouts.delete(sourceLang);
    }
  }
}

/**
 * Soniox Translation Provider implementation
 */
export class SonioxTranslationProvider implements TranslationProvider {
  readonly name = TranslationProviderType.SONIOX;
  readonly logger: Logger;

  private isInitialized = false;
  private healthStatus: TranslationProviderHealthStatus = {
    isHealthy: true,
    lastCheck: Date.now(),
    failures: 0,
  };

  // Get supported languages from the actual Soniox mappings
  private supportedLanguages = new Set(SonioxTranslationUtils.getSupportedLanguages());

  constructor(
    private config: SonioxTranslationConfig,
    parentLogger: Logger,
  ) {
    this.logger = parentLogger.child({ provider: "soniox-translation" });
  }

  async initialize(): Promise<void> {
    try {
      // Validate configuration
      if (!this.config.apiKey) {
        throw new Error("Soniox translation provider requires API key");
      }

      if (!this.config.endpoint) {
        throw new Error("Soniox translation provider requires endpoint URL");
      }

      this.isInitialized = true;
      this.logger.info("Soniox translation provider initialized");
    } catch (error) {
      this.logger.error({ error }, "Failed to initialize Soniox translation provider");
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.isInitialized = false;
    this.logger.info("Soniox translation provider disposed");
  }

  async createTranslationStream(options: TranslationStreamOptions): Promise<TranslationStreamInstance> {
    if (!this.isInitialized) {
      throw new Error("Soniox translation provider not initialized");
    }

    // Validate language pair
    if (!this.supportsLanguagePair(options.sourceLanguage, options.targetLanguage)) {
      throw new InvalidLanguagePairError(
        `Soniox does not support translation from ${options.sourceLanguage} to ${options.targetLanguage}`,
        options.sourceLanguage,
        options.targetLanguage,
      );
    }

    const stream = new SonioxTranslationStream(options, this, this.config);
    await stream.initialize();

    this.recordSuccess();
    return stream;
  }

  supportsLanguagePair(source: string, target: string): boolean {
    // Special case: "all" means translate from any language to target
    if (source === "all") {
      return this.supportedLanguages.has(SonioxTranslationUtils.normalizeLanguageCode(target));
    }

    // Use the utility to check if the language pair is supported
    return SonioxTranslationUtils.supportsTranslation(source, target);
  }

  supportsAutoDetection(): boolean {
    return true; // Soniox supports auto language detection
  }

  getCapabilities(): TranslationProviderCapabilities {
    // Build supported pairs from actual Soniox mappings
    const supportedPairs = new Map<string, string[]>();

    // For each supported language, check what it can translate to
    for (const sourceLanguage of this.supportedLanguages) {
      const targets: string[] = [];

      for (const targetLanguage of this.supportedLanguages) {
        if (
          sourceLanguage !== targetLanguage &&
          SonioxTranslationUtils.supportsTranslation(sourceLanguage, targetLanguage)
        ) {
          targets.push(targetLanguage);
        }
      }

      if (targets.length > 0) {
        supportedPairs.set(sourceLanguage, targets);
      }
    }

    return {
      supportedLanguagePairs: supportedPairs,
      supportsAutoDetection: true,
      supportsRealtimeTranslation: true,
      maxConcurrentStreams: this.config.maxConnections || 500, // Default to 500 if not set
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
