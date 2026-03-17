import type {EventEmitter} from "events"

/**
 * RealtimeProvider — common interface for conversational AI providers.
 *
 * Each provider (OpenAI Realtime, Gemini Live) implements this interface.
 * The RealtimeManager orchestrates the audio pipeline and delegates the
 * AI connection to whichever provider is selected.
 *
 * Audio formats:
 *   Input:  PCM 16-bit, 16kHz, mono (from glasses mic via MentraOS)
 *   Output: PCM 16-bit, 24kHz, mono (written to AudioOutputStream → MP3 → phone)
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProviderType = "openai" | "gemini"

export interface ProviderConfig {
  /** API key for the provider */
  apiKey: string
  /** System prompt / instructions for the AI */
  systemPrompt: string
  /** Voice to use (provider-specific, e.g. "ash" for OpenAI, "Puck" for Gemini) */
  voice?: string
}

export interface RealtimeProviderEvents {
  /** AI sent a chunk of audio (PCM 24kHz 16-bit mono as Buffer) */
  audio: (pcmBytes: Buffer) => void
  /** AI finished generating the current audio response */
  audioDone: (chunkCount: number) => void
  /** Full transcript of what the AI said */
  transcript: (text: string) => void
  /** User started speaking (VAD detected by the provider) */
  speechStarted: () => void
  /** User stopped speaking (VAD detected by the provider) */
  speechStopped: () => void
  /** AI started generating a response */
  responseCreated: () => void
  /** AI finished (status: "completed" | "failed" | "cancelled") */
  responseDone: (status: string, error?: any) => void
  /** Provider-level error */
  error: (error: any) => void
  /** Connection closed */
  closed: (code: number, reason: string) => void
  /** Provider is ready to receive audio */
  ready: () => void
}

// ─── Interface ───────────────────────────────────────────────────────────────

export interface RealtimeProvider extends EventEmitter {
  /** Provider name for logging */
  readonly name: ProviderType

  /**
   * Connect to the provider's realtime API.
   * Resolves when the session is configured and ready to receive audio.
   */
  connect(config: ProviderConfig): Promise<void>

  /**
   * Send a chunk of mic audio to the provider.
   * @param pcmBase64 — Base64-encoded PCM 16kHz 16-bit mono
   */
  sendAudio(pcmBase64: string): void

  /**
   * Cancel the current AI response (for interruption).
   */
  cancelResponse(): void

  /**
   * Disconnect and clean up.
   */
  disconnect(): void

  /**
   * Whether the provider is currently connected and ready.
   */
  readonly isConnected: boolean
}
