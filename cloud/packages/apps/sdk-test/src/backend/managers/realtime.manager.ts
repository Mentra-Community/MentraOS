import type {UserSession} from "../UserSession"
import type {AppSession} from "@mentra/sdk"
import type {RealtimeProvider, ProviderType, ProviderConfig} from "./realtime-provider"
import {OpenAIRealtimeProvider} from "./openai-realtime.provider"
import {GeminiRealtimeProvider} from "./gemini-realtime.provider"

/**
 * RealtimeManager — orchestrates conversational AI for a single user.
 *
 * Provider-agnostic: delegates the AI connection to whichever provider
 * is selected (OpenAI Realtime or Gemini Live). Handles the audio pipeline:
 *
 *   Glasses mic (PCM 16kHz) → Cloud → SDK onAudioChunk → Provider
 *   Provider → PCM 24kHz → AudioOutputStream (encodes to MP3) → Cloud relay → Phone
 *
 * The developer just writes audio chunks to the output stream. Gaps between
 * AI responses are fine — the cloud relay and phone coordinate transparently
 * to reconnect when new audio arrives after a pause.
 */

// OpenAI Realtime expects base64-encoded PCM
function bufferToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let binary = ""
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful and friendly AI assistant running on smart glasses. " +
  "Keep your responses concise and conversational — the user is wearing glasses " +
  "and hearing you through a small speaker. Be natural, like talking to a friend."

export interface RealtimeStartOptions {
  /** Which provider to use. Default: "gemini" */
  provider?: ProviderType
  /** Override the system prompt */
  systemPrompt?: string
  /** Voice name (provider-specific). OpenAI: "ash", "ballad", etc. Gemini: "Puck", "Charon", etc. */
  voice?: string
}

export class RealtimeManager {
  private provider: RealtimeProvider | null = null
  private audioCleanup: (() => void) | null = null
  private audioChunkCount = 0
  private activeProvider: ProviderType | null = null

  constructor(private userSession: UserSession) {}

  /** Whether a realtime session is currently active */
  get isActive(): boolean {
    return this.provider !== null && this.provider.isConnected
  }

  /** Which provider is currently active (null if idle) */
  get currentProvider(): ProviderType | null {
    return this.activeProvider
  }

  /**
   * Start a realtime conversation session.
   *
   * Order of operations (intentional — provider must connect before we allocate
   * expensive resources like the audio output stream):
   *
   * 1. Validate the glasses session is alive
   * 2. Connect to the selected provider (OpenAI or Gemini)
   * 3. Re-validate the glasses session (it may have dropped during connect)
   * 4. Open an AudioOutputStream (PCM→MP3 encoding, streams to phone)
   * 5. Subscribe to glasses mic audio and forward to the provider
   */
  async start(options: RealtimeStartOptions = {}): Promise<void> {
    const session = this.getValidSession()

    if (this.isActive) {
      throw new Error("Realtime session already active")
    }

    const providerType = options.provider || "gemini"
    const systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT
    const voice = options.voice

    // Resolve API key
    const apiKey = this.resolveApiKey(providerType)

    console.log(`[RealtimeManager] Starting ${providerType} realtime session...`)

    // 1. Create and connect the provider FIRST — before allocating any resources.
    //    If the provider fails to connect (wrong model, timeout, auth error), we
    //    bail out without having created an orphaned output stream or audio play request.
    this.provider = this.createProvider(providerType)
    this.activeProvider = providerType
    this.audioChunkCount = 0

    const config: ProviderConfig = {
      apiKey,
      systemPrompt,
      voice,
    }

    try {
      await this.provider.connect(config)
    } catch (err: any) {
      console.error(`[RealtimeManager] Failed to connect to ${providerType}:`, err.message)
      // Provider failed — clean up just the provider (no stream was created yet)
      this.provider.removeAllListeners()
      this.provider = null
      this.activeProvider = null
      this.audioChunkCount = 0
      throw err
    }

    // 2. Re-validate the glasses session — it may have dropped while we were
    //    waiting for the provider to connect (network instability, user disconnect).
    const currentSession = this.getValidSessionOrNull()
    if (!currentSession) {
      console.warn("[RealtimeManager] Glasses session lost during provider connect, tearing down")
      this.provider.disconnect()
      this.provider.removeAllListeners()
      this.provider = null
      this.activeProvider = null
      this.audioChunkCount = 0
      throw new Error("Glasses session disconnected during realtime setup")
    }

    // 3. Wire up provider events before creating the output stream.
    //    The "closed" handler needs to reference outputStream, so it's wired
    //    after provider.connect but before createOutputStream.
    this.wireProviderEvents(currentSession)

    // 4. Create the audio output stream (PCM 24kHz → MP3 → cloud relay → phone).
    //    The developer just writes chunks — gaps between AI responses are fine.
    //    The cloud relay handles phone reconnection transparently.
    try {
      const stream = await this.userSession.outputStream.claim("realtime")
      console.log("[RealtimeManager] Audio output stream ready, URL:", stream.streamUrl)
      console.log("[RealtimeManager] Output stream state:", stream.state)
    } catch (err: any) {
      console.error("[RealtimeManager] Failed to create output stream:", err.message)
      // Clean up the connected provider since we can't deliver audio
      await this.cleanup()
      throw err
    }

    // 5. Start forwarding mic audio
    this.startMicForwarding(currentSession)

    // Show status on glasses (non-fatal — WS may have closed between checks)
    this.safeShowTextWall(currentSession, `🎙️ AI active (${providerType})\nSpeak naturally...`)

    console.log(`[RealtimeManager] ${providerType} session fully active`)
  }

  /**
   * Stop the realtime session and clean up all resources.
   */
  async stop(): Promise<void> {
    console.log("[RealtimeManager] Stopping realtime session...")
    await this.cleanup()
    console.log("[RealtimeManager] Realtime session stopped")
  }

  /**
   * Interrupt the AI — flush output audio and cancel any in-progress response.
   */
  async interrupt(): Promise<void> {
    if (!this.isActive) return

    // Flush the output stream (silences immediately)
    const stream = this.userSession.outputStream.getActiveStream()
    if (this.userSession.outputStream.isOwnedBy("realtime") && stream && stream.state === "streaming") {
      await stream.flush()
    }

    // Tell the provider to cancel the current response
    this.provider?.cancelResponse()
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /**
   * Get the current AppSession, throwing if the glasses aren't connected.
   */
  private getValidSession(): AppSession {
    const session = this.userSession.appSession
    if (!session) {
      throw new Error("No active glasses session")
    }
    return session
  }

  /**
   * Get the current AppSession, returning null if disconnected.
   * Used for non-fatal checks where we want to handle the missing session gracefully.
   */
  private getValidSessionOrNull(): AppSession | null {
    return this.userSession.appSession ?? null
  }

  /**
   * Show text on glasses, swallowing any errors from a dead WebSocket.
   * This is a best-effort display — the session might be gone.
   */
  private safeShowTextWall(session: AppSession, text: string): void {
    try {
      session.layouts.showTextWall(text)
    } catch {
      console.log("[RealtimeManager] Could not show text wall (WS may be closed)")
    }
  }

  private createProvider(type: ProviderType): RealtimeProvider {
    switch (type) {
      case "openai":
        return new OpenAIRealtimeProvider()
      case "gemini":
        return new GeminiRealtimeProvider()
      default:
        throw new Error(`Unknown provider: ${type}`)
    }
  }

  private resolveApiKey(type: ProviderType): string {
    switch (type) {
      case "openai": {
        const key = process.env.OPENAI_API_KEY
        if (!key) throw new Error("OPENAI_API_KEY environment variable not set")
        return key
      }
      case "gemini": {
        const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
        if (!key) throw new Error("GEMINI_API_KEY (or GOOGLE_API_KEY) environment variable not set")
        return key
      }
      default:
        throw new Error(`Unknown provider: ${type}`)
    }
  }

  /**
   * Wire provider events to the audio output stream and logging.
   */
  private wireProviderEvents(session: AppSession): void {
    if (!this.provider) return

    // AI sent audio — write PCM to the output stream.
    // Just write and forget. The cloud relay handles gaps and phone reconnection.
    this.provider.on("audio", (pcmBytes: Buffer) => {
      const outputStream = this.userSession.outputStream.getActiveStream()
      if (!this.userSession.outputStream.isOwnedBy("realtime") || !outputStream || outputStream.state !== "streaming") {
        if (this.audioChunkCount === 0) {
          console.warn("[RealtimeManager] Audio received but output stream not ready, dropping")
        }
        return
      }

      try {
        outputStream.write(pcmBytes)
        this.audioChunkCount++

        if (this.audioChunkCount === 1) {
          console.log(`[RealtimeManager] ✓ First audio chunk from AI: ${pcmBytes.length} bytes`)
        } else if (this.audioChunkCount % 50 === 0) {
          console.log(`[RealtimeManager] Audio chunks sent: ${this.audioChunkCount} (latest: ${pcmBytes.length} bytes)`)
        }
      } catch (err) {
        console.error("[RealtimeManager] Error writing audio to output stream:", err)
      }
    })

    // AI finished an audio segment
    this.provider.on("audioDone", () => {
      console.log(`[RealtimeManager] AI audio response complete (${this.audioChunkCount} chunks sent)`)
      this.audioChunkCount = 0
    })

    // AI transcript
    this.provider.on("transcript", (text: string) => {
      console.log(`[RealtimeManager] AI said: "${text}"`)
    })

    // VAD events
    this.provider.on("speechStarted", () => {
      console.log("[RealtimeManager] User started speaking (VAD)")
    })

    this.provider.on("speechStopped", () => {
      console.log("[RealtimeManager] User stopped speaking (VAD)")
    })

    // Response lifecycle
    this.provider.on("responseCreated", () => {
      console.log("[RealtimeManager] AI is generating a response...")
    })

    this.provider.on("responseDone", (status: string, error?: any) => {
      if (status === "failed" || error) {
        console.error(`[RealtimeManager] Response FAILED:`, JSON.stringify(error))
      } else {
        console.log(`[RealtimeManager] Response done, status: ${status}`)
      }
    })

    // Provider errors
    this.provider.on("error", (error: any) => {
      console.error(`[RealtimeManager] Provider error:`, JSON.stringify(error))
    })

    // Provider closed
    this.provider.on("closed", (code: number, reason: string) => {
      console.log(`[RealtimeManager] Provider connection closed (code: ${code}, reason: ${reason})`)

      // Clean up mic listener
      if (this.audioCleanup) {
        this.audioCleanup()
        this.audioCleanup = null
      }

      // End output stream if still active
      this.userSession.outputStream.release("realtime", true).catch(() => {})

      this.activeProvider = null
    })
  }

  /**
   * Subscribe to glasses mic audio and forward PCM chunks to the provider.
   *
   * The SDK delivers audio as ArrayBuffer chunks via onAudioChunk.
   * Both OpenAI and Gemini expect base64-encoded PCM16 at 16kHz mono —
   * which is exactly what the glasses mic produces. Direct pass-through.
   */
  private startMicForwarding(session: AppSession): void {
    this.audioCleanup = session.events.onAudioChunk((chunk) => {
      if (!this.provider || !this.provider.isConnected) return

      try {
        const base64Audio = bufferToBase64(new Uint8Array(chunk.arrayBuffer))
        this.provider.sendAudio(base64Audio)
      } catch {
        // Silently skip if provider is closing
      }
    })

    console.log(`[RealtimeManager] Mic forwarding active → ${this.activeProvider}`)
  }

  /**
   * Clean up all resources.
   */
  private async cleanup(): Promise<void> {
    // Remove mic audio listener
    if (this.audioCleanup) {
      this.audioCleanup()
      this.audioCleanup = null
    }

    // Disconnect provider
    if (this.provider) {
      try {
        this.provider.disconnect()
        this.provider.removeAllListeners()
      } catch {
        // Already closed
      }
      this.provider = null
    }

    // End the shared output stream if realtime owns it
    await this.userSession.outputStream.release("realtime", true)

    this.activeProvider = null
    this.audioChunkCount = 0
  }
}
