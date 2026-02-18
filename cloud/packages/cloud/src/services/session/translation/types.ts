/**
 * @fileoverview Type definitions for the TranslationManager system
 */

import { ExtendedStreamType, TranslationData } from "@mentra/sdk";
import { Logger } from "pino";
import UserSession from "../UserSession";
import dotenv from "dotenv";
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

// Log warning if environment variables are not set
if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
  console.warn(
    "[TranslationManager] Warning: Azure Speech environment variables not set (AZURE_SPEECH_KEY, AZURE_SPEECH_REGION)",
  );
}
if (!SONIOX_API_KEY) {
  console.warn("[TranslationManager] Warning: Soniox environment variable not set (SONIOX_API_KEY)");
}

//===========================================================
// Core Enums
//===========================================================

export enum TranslationStreamState {
  INITIALIZING = "initializing",
  READY = "ready",
  ACTIVE = "active",
  ERROR = "error",
  CLOSING = "closing",
  CLOSED = "closed",
}

export enum TranslationProviderType {
  AZURE = "azure",
  SONIOX = "soniox",
  ALIBABA = "alibaba",
}

//===========================================================
// Configuration Types
//===========================================================

export interface TranslationConfig {
  providers: {
    defaultProvider: TranslationProviderType;
    fallbackProvider: TranslationProviderType;
  };

  azure: AzureTranslationConfig;
  soniox: SonioxTranslationConfig;
  alibaba: AlibabaTranslationConfig;

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

export interface AzureTranslationConfig {
  key: string;
  region: string;
  endpoint?: string;
  maxConnections?: number;
}

export interface SonioxTranslationConfig {
  apiKey: string;
  endpoint: string;
  model?: string; // Default: SONIOX_MODEL env var or 'stt-rt-v4'
  maxConnections?: number;
}

export interface AlibabaTranslationConfig {
  endpoint: string;
  workspace: string;
  dashscopeApiKey: string;
  model: string;
}

// export interface AlibabaTranslationConfig {
//   accessKeyId: string;
//   accessKeySecret: string;
//   appKey: string;
//   endpoint: string;
//   model?: string;
//   maxConnections?: number;
//   sampleRate?: number; // Audio sample rate, e.g., 16000
//   format?: string; // Audio format, e.g., "pcm"
//   enableIntermediateResult?: boolean;
//   enablePunctuationPrediction?: boolean;
//   enableInverseTextNormalization?: boolean;
//   maxStartSilence?: number; // Max silence duration in milliseconds before timeout
//   maxEndSilence?: number; // Max silence duration in milliseconds before end of speech
// }

//===========================================================
// Provider Interfaces
//===========================================================

export interface TranslationProviderHealthStatus {
  isHealthy: boolean;
  lastCheck: number;
  failures: number;
  lastFailure?: number;
  reason?: string;
}

export interface TranslationProviderCapabilities {
  supportedLanguagePairs: Map<string, string[]>; // source -> [targets]
  supportsAutoDetection: boolean;
  supportsRealtimeTranslation: boolean;
  maxConcurrentStreams: number;
}

export interface TranslationStreamOptions {
  streamId: string;
  userSession: UserSession;
  subscription: ExtendedStreamType;
  sourceLanguage: string;
  targetLanguage: string;
  callbacks: TranslationStreamCallbacks;
  config?: Record<string, any>; // Provider-specific config
}

export interface TranslationStreamCallbacks {
  onReady?: () => void;
  onError?: (error: Error) => void;
  onClosed?: () => void;
  onData?: (data: TranslationData) => void;
}

export interface TranslationProvider {
  readonly name: TranslationProviderType;
  readonly logger: Logger;

  // Lifecycle
  initialize(): Promise<void>;
  dispose(): Promise<void>;

  // Stream Management
  createTranslationStream(options: TranslationStreamOptions): Promise<TranslationStreamInstance>;

  // Capabilities
  supportsLanguagePair(source: string, target: string): boolean;
  supportsAutoDetection(): boolean;
  getCapabilities(): TranslationProviderCapabilities;

  // Health
  getHealthStatus(): TranslationProviderHealthStatus;
  recordFailure(error: Error): void;
  recordSuccess(): void;
}

//===========================================================
// Stream Instance Interface
//===========================================================

export interface TranslationStreamMetrics {
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

  // Translation Metrics
  translationsGenerated: number;
  averageLatency?: number;

  // Error Tracking
  errorCount: number;
  lastError?: Error;
}

export interface TranslationStreamInstance {
  // Identification
  readonly id: string;
  readonly subscription: ExtendedStreamType;
  readonly provider: TranslationProvider;
  readonly logger: Logger;

  // Configuration
  readonly sourceLanguage: string;
  readonly targetLanguage: string;

  // State
  state: TranslationStreamState;
  startTime: number;
  readyTime?: number;
  lastActivity: number;
  lastError?: Error;

  // Metrics
  metrics: TranslationStreamMetrics;

  // Callbacks
  callbacks: TranslationStreamCallbacks;

  // Methods
  writeAudio(data: ArrayBuffer): Promise<boolean>;
  close(): Promise<void>;
  getHealth(): TranslationStreamHealth;
}

export interface TranslationStreamHealth {
  isAlive: boolean;
  lastActivity: number;
  consecutiveFailures: number;
  lastSuccessfulWrite?: number;
  providerHealth: TranslationProviderHealthStatus;
}

//===========================================================
// Error Types
//===========================================================

export class TranslationError extends Error {
  constructor(
    message: string,
    public readonly context?: Record<string, any>,
  ) {
    super(message);
    this.name = "TranslationError";
  }
}

export class TranslationProviderError extends TranslationError {
  constructor(
    message: string,
    public readonly providerName: TranslationProviderType,
    public readonly originalError?: Error,
    context?: Record<string, any>,
  ) {
    super(message, context);
    this.name = "TranslationProviderError";
  }
}

export class InvalidLanguagePairError extends TranslationError {
  constructor(
    message: string,
    public readonly sourceLanguage: string,
    public readonly targetLanguage: string,
    public readonly supportedPairs?: string[],
  ) {
    super(message, { sourceLanguage, targetLanguage, supportedPairs });
    this.name = "InvalidLanguagePairError";
  }
}

export class TranslationStreamCreationError extends TranslationError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, context);
    this.name = "TranslationStreamCreationError";
  }
}

//===========================================================
// Helper Types
//===========================================================

export interface LanguagePair {
  source: string;
  target: string;
}

export interface TranslationProviderSelectionOptions {
  excludeProviders?: TranslationProviderType[];
  preferProvider?: TranslationProviderType;
}

//===========================================================
// Default Configuration
//===========================================================

export const DEFAULT_TRANSLATION_CONFIG: TranslationConfig = {
  providers: {
    defaultProvider: TranslationProviderType.SONIOX,
    fallbackProvider: TranslationProviderType.SONIOX,
  },

  azure: {
    key: AZURE_SPEECH_KEY,
    region: AZURE_SPEECH_REGION,
    endpoint: process.env.AZURE_TRANSLATION_ENDPOINT,
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
    maxMemoryUsageMB: 256,
    streamTimeoutMs: 10000,
    healthCheckIntervalMs: 60000,
  },

  retries: {
    maxStreamRetries: 3,
    retryDelayMs: 5000,
  },
};
