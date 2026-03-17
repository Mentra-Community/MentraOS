import {EventEmitter} from "events"
import type {RealtimeProvider, ProviderConfig, ProviderType} from "./realtime-provider"

/**
 * GeminiRealtimeProvider — connects to Google's Gemini Live API via @google/genai SDK.
 *
 * Handles:
 *   - Live session connection + configuration
 *   - Receiving audio chunks (PCM 24kHz) and emitting them
 *   - Server-side VAD / interruption events
 *   - Response lifecycle events
 *
 * Does NOT handle:
 *   - Mic forwarding (RealtimeManager does that)
 *   - Audio output streaming (RealtimeManager does that)
 *
 * Gemini Live API:
 *   Input:  PCM 16-bit, 16kHz, mono (sent as base64 with mime_type "audio/pcm;rate=16000")
 *   Output: PCM 16-bit, 24kHz, mono (received as base64 inline_data)
 *
 * See: https://ai.google.dev/gemini-api/docs/live
 */

const GEMINI_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"

export class GeminiRealtimeProvider extends EventEmitter implements RealtimeProvider {
  readonly name: ProviderType = "gemini"

  private session: any = null
  private ai: any = null
  private _isConnected = false
  private receiveTask: Promise<void> | null = null
  private shouldReceive = false

  get isConnected(): boolean {
    return this._isConnected
  }

  async connect(config: ProviderConfig): Promise<void> {
    // Dynamic import so @google/genai is only loaded if Gemini is selected
    const {GoogleGenAI, Modality} = await import("@google/genai")

    this.ai = new GoogleGenAI({apiKey: config.apiKey})

    console.log("[Gemini] Connecting to Live API...")

    const liveConfig: any = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: config.systemPrompt,
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: config.voice || "Puck",
          },
        },
      },
    }

    this.session = await this.ai.live.connect({
      model: GEMINI_MODEL,
      config: liveConfig,
      callbacks: {
        onopen: () => {
          console.log("[Gemini] Live session connected")
        },
        onmessage: (message: any) => {
          this.handleMessage(message)
        },
        onerror: (e: any) => {
          console.error("[Gemini] Error:", e?.message || e)
          this.emit("error", e)
        },
        onclose: (e: any) => {
          const code = e?.code || 1000
          const reason = e?.reason || ""
          console.log(`[Gemini] Session closed (code: ${code}, reason: ${reason})`)
          this._isConnected = false
          this.shouldReceive = false
          this.emit("closed", code, reason)
        },
      },
    })

    this._isConnected = true
    console.log("[Gemini] Live session ready")
    this.emit("ready")
  }

  sendAudio(pcmBase64: string): void {
    if (!this.session || !this._isConnected) return

    try {
      this.session.sendRealtimeInput({
        audio: {
          data: pcmBase64,
          mimeType: "audio/pcm;rate=16000",
        },
      })
    } catch {
      // Silently skip if session is closing
    }
  }

  cancelResponse(): void {
    // Gemini Live handles interruption automatically via its built-in VAD.
    // When the user starts speaking, the server sends an interrupted signal
    // and stops generating. No explicit cancel needed.
    // But we can try to send a text message to interrupt if needed.
  }

  disconnect(): void {
    this._isConnected = false
    this.shouldReceive = false

    if (this.session) {
      try {
        this.session.close()
      } catch {
        // Already closed
      }
      this.session = null
    }

    this.ai = null
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private handleMessage(message: any): void {
    try {
      // Handle server content (audio responses from the model)
      if (message.serverContent) {
        const serverContent = message.serverContent

        // Check for interruption (user started talking while AI was speaking)
        if (serverContent.interrupted) {
          console.log("[Gemini] Response interrupted by user")
          this.emit("speechStarted")
          return
        }

        // Check for turn completion
        if (serverContent.turnComplete) {
          this.emit("audioDone")
          this.emit("responseDone", "completed")
          return
        }

        // Process model turn parts (audio data)
        if (serverContent.modelTurn && serverContent.modelTurn.parts) {
          for (const part of serverContent.modelTurn.parts) {
            // Audio data
            if (part.inlineData && part.inlineData.data) {
              const pcmBytes = Buffer.from(part.inlineData.data, "base64")
              this.emit("audio", pcmBytes)
            }

            // Text (transcript of what the AI said)
            if (part.text) {
              this.emit("transcript", part.text)
            }
          }
        }
      }

      // Handle tool calls (function calling) — not used yet but log them
      if (message.toolCall) {
        console.log("[Gemini] Tool call received:", JSON.stringify(message.toolCall))
      }

      // Handle setup complete
      if (message.setupComplete) {
        console.log("[Gemini] Setup complete")
      }
    } catch (err) {
      console.error("[Gemini] Error handling message:", err)
    }
  }
}
