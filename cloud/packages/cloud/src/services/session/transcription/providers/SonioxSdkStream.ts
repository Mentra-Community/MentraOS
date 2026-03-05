/**
 * @fileoverview Soniox SDK-based transcription stream.
 *
 * Replaces the raw-WebSocket `SonioxTranscriptionStream` (~840 lines) with a thin
 * wrapper around the official Soniox Node SDK (`@soniox/node`).
 *
 * Root cause this fixes:
 *   Soniox delivers a **rolling token window** (full token list growing by 1+ per
 *   message). The old code iterated every token on every message assuming deltas,
 *   re-triggering speaker-change detection and generating a new utteranceId every
 *   ~150ms — producing 5+ duplicate cards in Captions.
 *
 * The SDK's `RealtimeSegmentBuffer` handles the rolling window internally and
 * correctly groups tokens by speaker/language, emitting only stable segments.
 *
 * See: cloud/issues/041-soniox-sdk/spike.md for full root-cause analysis.
 */

import { Logger } from "pino";
import {
  SonioxNodeClient,
  RealtimeUtteranceBuffer,
  type RealtimeSttSession,
  type RealtimeResult,
  type RealtimeToken,
  type SttSessionConfig,
} from "@soniox/node";

import { StreamType, parseLanguageStream, TranscriptionData, SonioxToken } from "@mentra/sdk";

import {
  StreamInstance,
  StreamCallbacks,
  StreamState,
  StreamHealth,
  StreamMetrics,
  SonioxProviderConfig,
} from "../../../../services/session/transcription/types";

import type { SonioxTranscriptionProvider } from "./SonioxTranscriptionProvider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateUtteranceId(): string {
  return `utt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function avgConfidence(tokens: ReadonlyArray<RealtimeToken>): number | undefined {
  if (tokens.length === 0) return undefined;
  const sum = tokens.reduce((acc, t) => acc + t.confidence, 0);
  return sum / tokens.length;
}

function toSdkTokens(tokens: ReadonlyArray<RealtimeToken>): SonioxToken[] {
  return tokens.map((t) => ({
    text: t.text,
    startMs: t.start_ms ?? 0,
    endMs: t.end_ms ?? 0,
    confidence: t.confidence,
    isFinal: t.is_final,
    speaker: t.speaker,
  }));
}

// ---------------------------------------------------------------------------
// SonioxSdkStream
// ---------------------------------------------------------------------------

/**
 * Transcription stream backed by the official Soniox Node SDK.
 *
 * Implements the same `StreamInstance` interface as the old
 * `SonioxTranscriptionStream` so that `TranscriptionManager` and
 * `SonioxTranscriptionProvider.createTranscriptionStream()` can return it
 * without any changes to their callers.
 *
 * Also exposes `forceFinalizePendingTokens()` for VAD-stop integration
 * (called via duck-typing from `TranscriptionManager.finalizePendingTokens`).
 */
export class SonioxSdkStream implements StreamInstance {
  // ── StreamInstance fields ────────────────────────────────────────────
  public state: StreamState = StreamState.INITIALIZING;
  public startTime: number = Date.now();
  public readyTime?: number;
  public lastActivity: number = Date.now();
  public lastError?: Error;
  public metrics: StreamMetrics;

  // ── SDK internals ───────────────────────────────────────────────────
  private session: RealtimeSttSession;
  private utteranceBuffer: RealtimeUtteranceBuffer;
  private disposed = false;

  // ── Utterance tracking ──────────────────────────────────────────────
  private currentUtteranceId: string | null = null;
  private currentSpeakerId: string | undefined;
  private currentLanguage: string | undefined;

  // Track last emitted interim text to avoid duplicate callbacks.
  private lastEmittedInterimText = "";

  // ── Stable-prefix accumulation ──────────────────────────────────────
  // The SDK's rolling window compacts (prunes) finalized tokens mid-
  // utterance, causing result.tokens to lose earlier text. To prevent
  // the interim from shrinking, we accumulate finalized-token text into
  // `stablePrefixText` ourselves. Each result's interim is then:
  //   stablePrefixText + (non-final tokens' text)
  //
  // `prevWindowFinalLen` tracks the *character length* of joined final-
  // token text from the previous result. When the window grows (new
  // tokens finalized), we append only the delta. When it shrinks
  // (compaction), we leave stablePrefixText alone (it already has the
  // pruned text) and reset the tracker to the new smaller length.
  private stablePrefixText = "";
  private prevWindowFinalLen = 0;

  constructor(
    public readonly id: string,
    public readonly subscription: string,
    public readonly provider: SonioxTranscriptionProvider,
    public readonly language: string,
    public readonly targetLanguage: string | undefined,
    public readonly callbacks: StreamCallbacks,
    public readonly logger: Logger,
    private readonly config: SonioxProviderConfig,
    client: SonioxNodeClient,
  ) {
    // ── Build session config ────────────────────────────────────────
    const sessionConfig = this.buildSessionConfig();

    this.session = client.realtime.stt(sessionConfig);

    // ── Utterance buffer: collects final tokens until endpoint ──────
    //   Used as a fallback for building final text if lastEmittedInterimText
    //   is empty when endpoint fires. Primary interim path is simpler:
    //   emit full rolling-window text from each `result` event.
    this.utteranceBuffer = new RealtimeUtteranceBuffer({
      final_only: true,
      group_by: ["speaker"],
    });

    // ── Metrics ─────────────────────────────────────────────────────
    this.metrics = {
      totalDuration: 0,
      audioChunksReceived: 0,
      audioChunksWritten: 0,
      audioDroppedCount: 0,
      audioWriteFailures: 0,
      consecutiveFailures: 0,
      errorCount: 0,
      totalAudioBytesSent: 0,
      lastTranscriptEndMs: 0,
      lastTranscriptLagMs: 0,
      maxTranscriptLagMs: 0,
      processingDeficitMs: 0,
      wallClockLagMs: 0,
      transcriptLagWarnings: 0,
      lastTokenReceivedAt: undefined,
      tokenBatchesReceived: 0,
      lastTokenBatchSize: 0,
      audioBytesSentAtLastToken: 0,
      timeSinceLastTokenMs: 0,
      audioSentSinceLastTokenMs: 0,
      isReceivingTokens: false,
      realtimeLatencyMs: 0,
      avgRealtimeLatencyMs: 0,
    };
  }

  // ====================================================================
  // Lifecycle
  // ====================================================================

  async initialize(): Promise<void> {
    this.logger.debug({ streamId: this.id }, "Connecting Soniox SDK session");

    // ── Wire up events BEFORE connecting ───────────────────────────
    this.session.on("result", (result: RealtimeResult) => this.handleResult(result));
    this.session.on("endpoint", () => this.handleEndpoint());
    this.session.on("finalized", () => this.handleFinalized());
    this.session.on("finished", () => this.handleFinished());
    this.session.on("error", (error: Error) => this.handleError(error));
    this.session.on("disconnected", (reason?: string) => this.handleDisconnected(reason));

    this.session.on("connected", () => {
      this.state = StreamState.READY;
      this.readyTime = Date.now();
      this.metrics.initializationTime = this.readyTime - this.startTime;
      this.lastActivity = Date.now();

      this.logger.info(
        {
          streamId: this.id,
          initTime: this.metrics.initializationTime,
          language: this.language,
          targetLanguage: this.targetLanguage,
        },
        "✅ Soniox SDK stream connected and ready",
      );

      this.callbacks.onReady?.();
    });

    try {
      await this.session.connect();
    } catch (error) {
      this.handleError(error as Error);
      throw error;
    }
  }

  async writeAudio(data: ArrayBuffer): Promise<boolean> {
    this.lastActivity = Date.now();
    this.metrics.audioChunksReceived++;

    if (this.state !== StreamState.READY && this.state !== StreamState.ACTIVE) {
      this.metrics.audioDroppedCount++;
      return false;
    }

    if (this.session.state !== "connected") {
      this.metrics.audioDroppedCount++;
      return false;
    }

    try {
      this.session.sendAudio(new Uint8Array(data));

      this.state = StreamState.ACTIVE;
      this.metrics.audioChunksWritten++;
      this.metrics.lastSuccessfulWrite = Date.now();
      this.metrics.consecutiveFailures = 0;
      this.metrics.totalAudioBytesSent = (this.metrics.totalAudioBytesSent || 0) + data.byteLength;

      return true;
    } catch (error) {
      this.metrics.audioWriteFailures++;
      this.metrics.consecutiveFailures++;
      this.metrics.errorCount++;

      this.logger.warn({ error, streamId: this.id }, "Error writing audio to Soniox SDK session");

      if (this.metrics.consecutiveFailures >= 5) {
        this.handleError(error as Error);
      }
      return false;
    }
  }

  /**
   * VAD-stop integration. Called from TranscriptionManager via duck-typing:
   *   if ("forceFinalizePendingTokens" in stream) { ... }
   *
   * Asks the Soniox server to finalize in-progress transcription.
   * The 'finalized' event will fire when the server confirms, at which
   * point we flush the utterance buffer and emit a final.
   */
  forceFinalizePendingTokens(): void {
    if (this.session.state !== "connected") {
      this.logger.debug(
        { streamId: this.id, sessionState: this.session.state },
        "🎙️ SONIOX SDK: VAD stop - session not connected, skipping finalize",
      );
      return;
    }

    this.logger.debug({ streamId: this.id }, "🎙️ SONIOX SDK: VAD stop - requesting server-side finalization");

    try {
      this.session.finalize();
    } catch (error) {
      this.logger.warn({ error, streamId: this.id }, "Error calling session.finalize()");
    }
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.state = StreamState.CLOSING;

    try {
      // Graceful shutdown: finish() waits for remaining results, then closes.
      // If the session is already disconnected, close() is a no-op.
      const sessionState = this.session.state;
      if (sessionState === "connected" || sessionState === "finishing") {
        try {
          await this.session.finish();
        } catch {
          // finish() can throw if the session errored out; swallow and close
          this.session.close();
        }
      } else if (sessionState !== "finished" && sessionState !== "closed" && sessionState !== "error") {
        this.session.close();
      }
    } catch (error) {
      this.logger.warn({ error, streamId: this.id }, "Error during Soniox SDK stream close");
    }

    // Reset buffers
    this.utteranceBuffer.reset();
    this.currentUtteranceId = null;
    this.lastEmittedInterimText = "";

    this.state = StreamState.CLOSED;
    this.metrics.totalDuration = Date.now() - this.startTime;

    this.logger.debug(
      {
        streamId: this.id,
        duration: this.metrics.totalDuration,
        audioChunksWritten: this.metrics.audioChunksWritten,
        tokenBatchesReceived: this.metrics.tokenBatchesReceived,
      },
      "Soniox SDK stream closed",
    );
  }

  getHealth(): StreamHealth {
    this.updateActivityMetrics();

    return {
      isAlive: this.state === StreamState.READY || this.state === StreamState.ACTIVE,
      lastActivity: this.lastActivity,
      consecutiveFailures: this.metrics.consecutiveFailures,
      lastSuccessfulWrite: this.metrics.lastSuccessfulWrite,
      providerHealth: this.provider.getHealthStatus(),
      isReceivingTokens: this.metrics.isReceivingTokens,
      realtimeLatencyMs: this.metrics.realtimeLatencyMs,
      avgRealtimeLatencyMs: this.metrics.avgRealtimeLatencyMs,
      timeSinceLastTokenMs: this.metrics.timeSinceLastTokenMs,
      audioSentSinceLastTokenMs: this.metrics.audioSentSinceLastTokenMs,
    };
  }

  // ====================================================================
  // SDK Event Handlers
  // ====================================================================

  /**
   * Fires on every WebSocket message with parsed tokens.
   *
   * IMPORTANT: The SDK's rolling window compacts finalized tokens mid-
   * utterance — `result.tokens` can shrink as old finals are pruned.
   * To prevent the interim from losing its beginning, we accumulate
   * finalized-token text into `stablePrefixText` and only read the
   * non-final tail from each result. The interim is always:
   *
   *     stablePrefixText + (non-final tokens' text)
   *
   * This survives window compaction because the pruned finals are
   * already stored in stablePrefixText.
   *
   *  - Feed the result into the utterance buffer for clean finals on
   *    `endpoint`.
   *  - Speaker attribution uses the LAST token's speaker field.
   *    Speaker changes within the window do NOT rotate the utteranceId.
   */
  private handleResult(result: RealtimeResult): void {
    const now = Date.now();
    this.lastActivity = now;

    // ── Update metrics ──────────────────────────────────────────────
    this.metrics.tokenBatchesReceived = (this.metrics.tokenBatchesReceived || 0) + 1;
    this.metrics.lastTokenBatchSize = result.tokens.length;
    this.metrics.lastTokenReceivedAt = now;
    this.metrics.audioBytesSentAtLastToken = this.metrics.totalAudioBytesSent || 0;

    // Latency: how far behind is the provider?
    if (result.total_audio_proc_ms > 0 && result.final_audio_proc_ms > 0) {
      const latency = result.total_audio_proc_ms - result.final_audio_proc_ms;
      this.metrics.realtimeLatencyMs = latency;
      const alpha = 0.2;
      this.metrics.avgRealtimeLatencyMs =
        alpha * latency + (1 - alpha) * (this.metrics.avgRealtimeLatencyMs || latency);
    }

    // ── Feed utterance buffer (for finals on endpoint) ──────────────
    this.utteranceBuffer.addResult(result);

    if (result.tokens.length === 0) return;

    // ── Accumulate newly-finalized tokens into stablePrefixText ─────
    // Separate final vs non-final tokens, then compare the joined final
    // text against the previous result to detect new content.
    const finalTokens: RealtimeToken[] = [];
    const nonFinalTokens: RealtimeToken[] = [];
    for (const token of result.tokens) {
      if (token.is_final) finalTokens.push(token);
      else nonFinalTokens.push(token);
    }

    const currentFinalText = finalTokens.map((t) => t.text).join("");

    if (currentFinalText.length > this.prevWindowFinalLen) {
      // Window's final portion grew — new tokens were finalized.
      // Append only the delta (the new characters at the end).
      this.stablePrefixText += currentFinalText.substring(this.prevWindowFinalLen);
    }
    // If it shrunk (compaction) or stayed the same, stablePrefixText
    // already contains the text — nothing to append.

    this.prevWindowFinalLen = currentFinalText.length;

    // ── Build interim = stable prefix + non-final tail ──────────────
    const tailText = nonFinalTokens.map((t) => t.text).join("");
    const fullText = (this.stablePrefixText + tailText).trim();

    if (!fullText || fullText === this.lastEmittedInterimText) return;

    // Use the last token for speaker/language — it's the most recent
    const lastToken = result.tokens[result.tokens.length - 1];
    const firstToken = result.tokens[0];

    this.ensureUtterance(lastToken.speaker, lastToken.language);

    const interimData: TranscriptionData = {
      type: StreamType.TRANSCRIPTION,
      text: fullText,
      isFinal: false,
      utteranceId: this.currentUtteranceId || undefined,
      speakerId: this.currentSpeakerId || "0",
      confidence: avgConfidence(result.tokens),
      startTime: firstToken.start_ms ?? now,
      endTime: lastToken.end_ms ?? now + 1000,
      transcribeLanguage: this.language,
      detectedLanguage: lastToken.language || this.currentLanguage || this.language,
      provider: "soniox",
      metadata: {
        provider: "soniox",
        soniox: {
          // Only include the last few tokens to keep metadata size reasonable
          tokens: toSdkTokens(result.tokens.slice(-10)),
        },
      },
    };

    this.callbacks.onData?.(interimData);
    this.lastEmittedInterimText = fullText;
    this.provider.recordSuccess();

    this.logger.debug(
      {
        streamId: this.id,
        text: fullText.substring(0, 80),
        isFinal: false,
        utteranceId: this.currentUtteranceId,
        speakerId: this.currentSpeakerId,
        tokenCount: result.tokens.length,
        prefixLen: this.stablePrefixText.length,
        tailTokens: nonFinalTokens.length,
        finalAudioMs: result.final_audio_proc_ms,
        totalAudioMs: result.total_audio_proc_ms,
      },
      `🎙️ SONIOX SDK: interim - "${fullText.substring(0, 60)}"`,
    );
  }

  /**
   * Endpoint event: the server detected that the speaker stopped talking.
   *
   * Emit a final with the last emitted interim text (which is the most
   * complete version of this utterance). Then rotate utteranceId so the
   * next speech segment gets its own card.
   */
  private handleEndpoint(): void {
    this.lastActivity = Date.now();

    // The most complete text for this utterance is whatever we last emitted
    // as an interim. Use that as the final, ensuring the frontend transitions
    // the card from interim → final seamlessly (same utteranceId, same text).
    if (this.lastEmittedInterimText.trim()) {
      this.emitFinal(
        this.lastEmittedInterimText,
        this.currentSpeakerId,
        this.currentLanguage,
        undefined, // no token array needed for final
      );
    } else {
      // Try the utterance buffer as a fallback
      const utterance = this.utteranceBuffer.markEndpoint();
      if (utterance && utterance.text.trim()) {
        this.emitFinal(utterance.text, utterance.speaker, utterance.language, utterance.tokens);
      }
    }

    // Rotate utterance ID and reset prefix for the next speech segment
    this.currentUtteranceId = null;
    this.currentSpeakerId = undefined;
    this.currentLanguage = undefined;
    this.lastEmittedInterimText = "";
    this.stablePrefixText = "";
    this.prevWindowFinalLen = 0;

    // Reset utterance buffer for the next utterance
    this.utteranceBuffer.reset();

    this.logger.debug({ streamId: this.id }, "🎙️ SONIOX SDK: endpoint — rotated utterance");
  }

  /**
   * Finalized event: the server confirmed a manual `session.finalize()` call
   * (triggered by VAD stop). Behaves like endpoint — emit final from the
   * last known interim text, then reset for the next utterance.
   */
  private handleFinalized(): void {
    this.lastActivity = Date.now();

    if (this.lastEmittedInterimText.trim()) {
      this.emitFinal(this.lastEmittedInterimText, this.currentSpeakerId, this.currentLanguage, undefined);
    } else {
      // Fallback: flush utterance buffer
      const utterance = this.utteranceBuffer.markEndpoint();
      if (utterance && utterance.text.trim()) {
        this.emitFinal(utterance.text, utterance.speaker, utterance.language, utterance.tokens);
      }
    }

    // Reset for next utterance
    this.currentUtteranceId = null;
    this.currentSpeakerId = undefined;
    this.currentLanguage = undefined;
    this.lastEmittedInterimText = "";
    this.stablePrefixText = "";
    this.prevWindowFinalLen = 0;
    this.utteranceBuffer.reset();

    this.logger.debug({ streamId: this.id }, "🎙️ SONIOX SDK: finalization complete (VAD stop)");
  }

  /**
   * Finished event: the session is ending (server signaled end of stream).
   */
  private handleFinished(): void {
    this.logger.debug({ streamId: this.id }, "Soniox SDK session finished");
    // Flush any pending data as a final
    if (this.lastEmittedInterimText.trim()) {
      this.emitFinal(this.lastEmittedInterimText, this.currentSpeakerId, this.currentLanguage, undefined);
      this.lastEmittedInterimText = "";
      this.stablePrefixText = "";
      this.prevWindowFinalLen = 0;
      this.currentUtteranceId = null;
    }
  }

  private handleError(error: Error): void {
    this.state = StreamState.ERROR;
    this.lastError = error;
    this.metrics.errorCount++;
    this.metrics.consecutiveFailures++;

    this.provider.recordFailure(error);

    this.logger.error({ error, streamId: this.id, sessionState: this.session.state }, "Soniox SDK stream error");

    this.callbacks.onError?.(error);
  }

  private handleDisconnected(reason?: string): void {
    this.logger.info({ streamId: this.id, reason }, "Soniox SDK session disconnected");

    // Only fire onClosed if we haven't already disposed
    if (!this.disposed) {
      // Use 1006 for abnormal/unexpected disconnect, 1000 for normal
      const isNormal = this.state === StreamState.CLOSING || this.state === StreamState.CLOSED;
      this.callbacks.onClosed?.(isNormal ? 1000 : 1006);
    }
  }

  // ====================================================================
  // Internal helpers
  // ====================================================================

  /**
   * Ensure we have an active utterance. If not, start one.
   * Speaker changes within an utterance do NOT create new utterance IDs —
   * that's the critical fix. The SDK's segment buffer handles speaker
   * grouping internally.
   */
  private ensureUtterance(speaker?: string, language?: string): void {
    if (!this.currentUtteranceId) {
      this.currentUtteranceId = generateUtteranceId();
      this.currentSpeakerId = speaker;
      this.currentLanguage = language;
    } else {
      // Update speaker/language from latest data, but keep same utteranceId
      if (speaker) this.currentSpeakerId = speaker;
      if (language) this.currentLanguage = language;
    }
  }

  /**
   * Emit a final TranscriptionData and log it.
   */
  private emitFinal(text: string, speaker?: string, language?: string, tokens?: ReadonlyArray<RealtimeToken>): void {
    this.ensureUtterance(speaker, language);

    const finalData: TranscriptionData = {
      type: StreamType.TRANSCRIPTION,
      text,
      isFinal: true,
      utteranceId: this.currentUtteranceId || undefined,
      speakerId: this.currentSpeakerId || "0",
      confidence: tokens ? avgConfidence(tokens) : undefined,
      startTime: (tokens && tokens.length > 0 ? tokens[0].start_ms : undefined) ?? Date.now(),
      endTime: (tokens && tokens.length > 0 ? tokens[tokens.length - 1].end_ms : undefined) ?? Date.now() + 1000,
      transcribeLanguage: this.language,
      detectedLanguage: this.currentLanguage || this.language,
      provider: "soniox",
      metadata: {
        provider: "soniox",
        ...(tokens && tokens.length > 0 ? { soniox: { tokens: toSdkTokens(tokens) } } : {}),
      },
    };

    this.callbacks.onData?.(finalData);
    this.provider.recordSuccess();

    this.logger.debug(
      {
        streamId: this.id,
        text: text.substring(0, 100),
        isFinal: true,
        utteranceId: this.currentUtteranceId,
        speakerId: this.currentSpeakerId,
        provider: "soniox",
      },
      `🎙️ SONIOX SDK: FINAL - "${text.substring(0, 80)}"`,
    );
  }

  /**
   * Build the SttSessionConfig from our subscription string and provider config.
   */
  private buildSessionConfig(): SttSessionConfig {
    const languageInfo = parseLanguageStream(this.subscription);
    const hintsParam = languageInfo?.options?.hints;
    const disableLangIdParam = languageInfo?.options?.["no-language-identification"];

    const additionalHints = hintsParam ? (hintsParam as string).split(",").map((h: string) => h.trim()) : [];

    const isAutoMode = this.language === "auto";
    const languageHint = this.language.split("-")[0];
    const targetLanguageHint = this.targetLanguage ? this.targetLanguage.split("-")[0] : undefined;

    let languageHints: string[];
    if (isAutoMode) {
      languageHints = additionalHints;
    } else if (targetLanguageHint) {
      languageHints = [languageHint, targetLanguageHint, ...additionalHints];
    } else {
      languageHints = [languageHint, ...additionalHints];
    }
    languageHints = [...new Set(languageHints)];

    const enableLanguageIdentification = !(disableLangIdParam === true || disableLangIdParam === "true");

    const sessionConfig: SttSessionConfig = {
      model: this.config.model || "stt-rt-v4",
      audio_format: "pcm_s16le",
      sample_rate: 16000,
      num_channels: 1,
      enable_language_identification: enableLanguageIdentification,
      enable_endpoint_detection: true,
      enable_speaker_diarization: true,
      language_hints: languageHints.length > 0 ? languageHints : undefined,
      context: {
        terms: ["Mentra", "MentraOS", "Hey Mentra"],
        text: "Mentra MentraOS, Hey Mentra (an AI assistant)",
      },
    };

    // Translation config
    if (this.targetLanguage) {
      sessionConfig.translation = {
        type: "two_way",
        language_a: this.language.split("-")[0],
        language_b: this.targetLanguage.split("-")[0],
      };
      if (!sessionConfig.language_hints || sessionConfig.language_hints.length === 0) {
        sessionConfig.language_hints = [this.language.split("-")[0], this.targetLanguage.split("-")[0]];
      }
    }

    this.logger.debug(
      {
        streamId: this.id,
        model: sessionConfig.model,
        language: this.language,
        targetLanguage: this.targetLanguage,
        languageHints: sessionConfig.language_hints,
        enableLanguageId: sessionConfig.enable_language_identification,
        enableDiarization: sessionConfig.enable_speaker_diarization,
        enableEndpoint: sessionConfig.enable_endpoint_detection,
        hasTranslation: !!sessionConfig.translation,
      },
      "Built Soniox SDK session config",
    );

    return sessionConfig;
  }

  /**
   * Update activity metrics for silence detection (called on-demand).
   */
  private updateActivityMetrics(): void {
    const now = Date.now();
    const lastTokenTime = this.metrics.lastTokenReceivedAt || this.startTime;

    this.metrics.timeSinceLastTokenMs = now - lastTokenTime;
    this.metrics.isReceivingTokens = (this.metrics.timeSinceLastTokenMs ?? 0) < 30000;

    const audioBytesSentAtLastToken = this.metrics.audioBytesSentAtLastToken || 0;
    const currentAudioBytesSent = this.metrics.totalAudioBytesSent || 0;
    const bytesSinceLastToken = currentAudioBytesSent - audioBytesSentAtLastToken;
    this.metrics.audioSentSinceLastTokenMs = bytesSinceLastToken / 32; // 32 bytes per ms at 16kHz 16-bit
  }
}
