/**
 * @fileoverview Type definitions for the new TranscriptionManager system
 */

import { ExtendedStreamType, TranscriptionData } from "@mentra/sdk";
import dotenv from "dotenv";
import { Logger } from "pino";

import UserSession from "../UserSession";
dotenv.config();

// Environment variables for provider configuration
export const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY || "";
export const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || "";
export const SONIOX_API_KEY = process.env.SONIOX_API_KEY || "";
export const SONIOX_ENDPOINT = process.env.SONIOX_ENDPOINT || "wss://stt-rt.soniox.com/transcribe-websocket";
export const SONIOX_MODEL = process.env.SONIOX_MODEL || "stt-rt-v4";
export const ALIBABA_ENDPOINT = process.env.ALIBABA_ENDPOINT || "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
export const ALIBABA_WORKSPACE = process.env.ALIBABA_WORKSPACE || "";
export const ALIBABA_DASHSCOPE_API_KEY = process.env.ALIBABA_DASHSCOPE_API_KEY || "";

// Azure is deprecated — warn if keys are present (they shouldn't be needed)
if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
  console.warn(
    "⚠️  Azure Speech env vars not set (AZURE_SPEECH_KEY, AZURE_SPEECH_REGION). Azure provider will be unavailable — this is expected, Soniox is the primary provider.",
  );
}
if (!SONIOX_API_KEY || !SONIOX_ENDPOINT) {
  const message = "Missing required Soniox environment variables: SONIOX_API_KEY and SONIOX_ENDPOINT";
  if (process.env.NODE_ENV === "production") {
    throw new Error(message);
  } else {
    console.warn(`⚠️  ${message}. Soniox transcription may not work.`);
  }
}

//===========================================================
// Core Enums
//===========================================================

export enum StreamState {
  INITIALIZING = "initializing",
  READY = "ready",
  ACTIVE = "active",
  ERROR = "error",
  CLOSING = "closing",
  CLOSED = "closed",
}

export enum ProviderType {
  AZURE = "azure",
  SONIOX = "soniox",
  ALIBABA = "alibaba",
}

export enum AzureErrorType {
  RACE_CONDITION = "race_condition",
  RATE_LIMIT = "rate_limit",
  NETWORK_ERROR = "network_error",
  TIMEOUT = "timeout",
  AUTH_ERROR = "auth_error",
  UNKNOWN = "unknown",
}

//===========================================================
// Configuration Types
//===========================================================

export interface TranscriptionConfig {
  providers: {
    defaultProvider: ProviderType;
    fallbackProvider: ProviderType;
  };

  azure: AzureProviderConfig;
  soniox: SonioxProviderConfig;
  alibaba: AlibabaProviderConfig;

  performance: {
    maxTotalStreams: number;
    maxMemoryUsageMB: number;
    streamTimeoutMs: number;
    healthCheckIntervalMs: number;
  };

  retries: {
    maxStreamRetries: number;
    retryDelayMs: number;
  };
}

export interface AzureProviderConfig {
  key: string;
  region: string;
  maxConnections?: number;
}

export interface SonioxProviderConfig {
  apiKey: string;
  endpoint: string;
  model?: string; // Default: SONIOX_MODEL env var or 'stt-rt-v4'
  maxConnections?: number;
}

export interface AlibabaProviderConfig {
  endpoint: string;
  workspace: string;
  dashscopeApiKey: string;
  model: string;
}

//===========================================================
// Provider Interfaces
//===========================================================

export interface ProviderHealthStatus {
  isHealthy: boolean;
  lastCheck: number;
  failures: number;
  lastFailure?: number;
  reason?: string;
}

export interface ProviderLanguageCapabilities {
  transcriptionLanguages: string[];
  autoLanguageDetection: boolean;
}

export interface StreamOptions {
  streamId: string;
  userSession: UserSession;
  subscription: ExtendedStreamType;
  callbacks: StreamCallbacks;
}

export interface StreamCallbacks {
  onReady?: () => void;
  onError?: (error: Error) => void;
  /**
   * Called when stream is closed.
   * @param code - WebSocket close code (1000 = normal/intentional, 1006 = abnormal/unexpected)
   *               undefined means close code is not available (e.g., non-WebSocket providers)
   */
  onClosed?: (code?: number) => void;
  onData?: (data: TranscriptionData) => void;
}

export interface TranscriptionProvider {
  readonly name: ProviderType;
  readonly logger: Logger;

  // Lifecycle
  initialize(): Promise<void>;
  dispose(): Promise<void>;

  // Stream Management
  createTranscriptionStream(language: string, options: StreamOptions): Promise<StreamInstance>;

  // Capabilities
  supportsSubscription(subscription: ExtendedStreamType): boolean;
  supportsLanguage(language: string): boolean;
  getLanguageCapabilities(): ProviderLanguageCapabilities;

  // Health
  getHealthStatus(): ProviderHealthStatus;
  recordFailure(error: Error): void;
  recordSuccess(): void;
}

//===========================================================
// Stream Instance Interface
//===========================================================

export interface StreamMetrics {
  // Lifecycle
  initializationTime?: number;
  totalDuration: number;

  // Audio Processing
  audioChunksReceived: number;
  audioChunksWritten: number;
  audioDroppedCount: number;
  audioWriteFailures: number;
  consecutiveFailures: number;
  lastSuccessfulWrite?: number;

  // Latency & Backlog Tracking (Legacy - kept for backwards compatibility)
  totalAudioBytesSent?: number; // Total bytes sent to provider
  lastTranscriptEndMs?: number; // Last transcript end time (relative to stream start)
  lastTranscriptLagMs?: number; // Real lag: audio sent duration - transcript end (processingDeficit)
  maxTranscriptLagMs?: number; // Maximum real lag observed
  processingDeficitMs?: number; // DEPRECATED: Misleading during silence - use realtimeLatencyMs instead
  wallClockLagMs?: number; // Wall-clock lag: stream age - transcript end (for debugging only, includes VAD gaps)
  transcriptLagWarnings?: number; // Count of lag warnings (>5s processingDeficit)

  // Activity Tracking (NEW - distinguishes silence from actual lag)
  lastTokenReceivedAt?: number; // Timestamp when we last received ANY token from provider
  tokenBatchesReceived?: number; // Count of token batches received
  lastTokenBatchSize?: number; // Size of last token batch received
  audioBytesSentAtLastToken?: number; // Audio bytes sent at time of last token (for calculating audio during silence)

  // Silence Detection (NEW)
  timeSinceLastTokenMs?: number; // Calculated: now - lastTokenReceivedAt
  audioSentSinceLastTokenMs?: number; // Audio duration (ms) sent since last token received
  isReceivingTokens?: boolean; // Have we received tokens in the last 30s?

  // True Latency (NEW - only meaningful when isReceivingTokens === true)
  realtimeLatencyMs?: number; // When tokens ARE received, how far behind is the provider?
  avgRealtimeLatencyMs?: number; // Rolling average of realtime latency

  // Error Tracking
  errorCount: number;
  lastError?: Error;
}

export interface StreamInstance {
  // Identification
  readonly id: string;
  readonly subscription: ExtendedStreamType;
  readonly provider: TranscriptionProvider;
  readonly logger: Logger;

  // Configuration
  readonly language: string;

  // State
  state: StreamState;
  startTime: number;
  readyTime?: number;
  lastActivity: number;
  lastError?: Error;

  // Metrics
  metrics: StreamMetrics;

  // Callbacks
  callbacks: StreamCallbacks;

  // Methods
  writeAudio(data: ArrayBuffer): Promise<boolean>;
  close(): Promise<void>;
  getHealth(): StreamHealth;
}

export interface StreamHealth {
  isAlive: boolean;
  lastActivity: number;
  consecutiveFailures: number;
  lastSuccessfulWrite?: number;
  providerHealth: ProviderHealthStatus;
  // Legacy metrics (kept for backwards compatibility)
  transcriptLagMs?: number;
  maxTranscriptLagMs?: number;
  processingDeficitMs?: number;
  wallClockLagMs?: number;
  // NEW: Activity tracking - distinguishes silence from actual lag
  isReceivingTokens?: boolean; // Have we received tokens in the last 30s?
  realtimeLatencyMs?: number; // TRUE latency when actively receiving tokens
  avgRealtimeLatencyMs?: number; // Rolling average of realtime latency
  timeSinceLastTokenMs?: number; // How long since any transcription activity
  audioSentSinceLastTokenMs?: number; // Audio duration sent during quiet period
}

//===========================================================
// Error Types
//===========================================================

export class TranscriptionError extends Error {
  constructor(
    message: string,
    public readonly context?: Record<string, any>,
  ) {
    super(message);
    this.name = "TranscriptionError";
  }
}

export class ProviderError extends TranscriptionError {
  constructor(
    message: string,
    public readonly providerName: ProviderType,
    public readonly originalError?: Error,
    context?: Record<string, any>,
  ) {
    super(message, context);
    this.name = "ProviderError";
  }
}

export class AzureProviderError extends ProviderError {
  constructor(
    public readonly errorCode: number,
    public readonly errorDetails: string,
    public readonly errorType: AzureErrorType,
    originalError?: Error,
  ) {
    super(`Azure error ${errorCode}: ${errorDetails}`, ProviderType.AZURE, originalError, {
      errorCode,
      errorDetails,
      errorType,
    });
    this.name = "AzureProviderError";
  }
}

export class SonioxProviderError extends ProviderError {
  constructor(
    message: string,
    public readonly statusCode?: number,
    originalError?: Error,
  ) {
    super(message, ProviderType.SONIOX, originalError, { statusCode });
    this.name = "SonioxProviderError";
  }
}

export class InvalidSubscriptionError extends TranscriptionError {
  constructor(
    message: string,
    public readonly subscription: ExtendedStreamType,
    public readonly suggestions?: string[],
  ) {
    super(message, { subscription, suggestions });
    this.name = "InvalidSubscriptionError";
  }
}

export class NoProviderAvailableError extends TranscriptionError {
  constructor(
    message: string,
    public readonly subscription?: ExtendedStreamType,
  ) {
    super(message, { subscription });
    this.name = "NoProviderAvailableError";
  }
}

export class ResourceLimitError extends TranscriptionError {
  constructor(
    message: string,
    public readonly resourceType: string,
  ) {
    super(message, { resourceType });
    this.name = "ResourceLimitError";
  }
}

export class StreamCreationTimeoutError extends TranscriptionError {
  constructor(message: string) {
    super(message);
    this.name = "StreamCreationTimeoutError";
  }
}

export class StreamInitializationError extends TranscriptionError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, context);
    this.name = "StreamInitializationError";
  }
}

//===========================================================
// Provider Selection Types
//===========================================================

export interface ProviderSelectionOptions {
  excludeProviders?: ProviderType[];
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  suggestions?: string[];
  supportingProviders?: TranscriptionProvider[];
}

//===========================================================
// Default Configuration
//===========================================================

export const DEFAULT_TRANSCRIPTION_CONFIG: TranscriptionConfig = {
  providers: {
    defaultProvider: ProviderType.SONIOX,
    fallbackProvider: ProviderType.SONIOX,
  },

  azure: {
    key: AZURE_SPEECH_KEY,
    region: AZURE_SPEECH_REGION,
  },

  soniox: {
    apiKey: SONIOX_API_KEY,
    endpoint: SONIOX_ENDPOINT,
    model: SONIOX_MODEL,
  },

  alibaba: {
    endpoint: ALIBABA_ENDPOINT,
    workspace: ALIBABA_WORKSPACE,
    dashscopeApiKey: ALIBABA_DASHSCOPE_API_KEY,
    model: "gummy-realtime-v1",
  },

  performance: {
    maxTotalStreams: 500,
    maxMemoryUsageMB: 512,
    streamTimeoutMs: 10000,
    healthCheckIntervalMs: 60000,
  },

  retries: {
    maxStreamRetries: 3,
    retryDelayMs: 5000,
  },
};
