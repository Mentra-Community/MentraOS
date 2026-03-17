import {EventEmitter} from "events"
import WebSocket from "ws"
import type {RealtimeProvider, ProviderConfig, ProviderType} from "./realtime-provider"

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime"
const OPENAI_MODEL = "gpt-realtime-1.5"

/**
 * OpenAIRealtimeProvider — connects to OpenAI's Realtime API via WebSocket.
 *
 * Handles:
 *   - WebSocket connection + session configuration
 *   - Receiving audio deltas (PCM 24kHz) and emitting them
 *   - Server-side VAD events
 *   - Response lifecycle events
 *
 * Does NOT handle:
 *   - Mic forwarding (RealtimeManager does that)
 *   - Audio output streaming (RealtimeManager does that)
 */
export class OpenAIRealtimeProvider extends EventEmitter implements RealtimeProvider {
  readonly name: ProviderType = "openai"

  private ws: WebSocket | null = null
  private _isConnected = false

  get isConnected(): boolean {
    return this._isConnected
  }

  async connect(config: ProviderConfig): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = `${OPENAI_REALTIME_URL}?model=${OPENAI_MODEL}`

      this.ws = new WebSocket(url, {
        headers: {
          "Authorization": `Bearer ${config.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      })

      const connectTimeout = setTimeout(() => {
        if (!this._isConnected) {
          this.ws?.close()
          reject(new Error("OpenAI Realtime connection timed out (10s)"))
        }
      }, 10_000)

      this.ws.on("open", () => {
        console.log("[OpenAI] Connected to Realtime API")
      })

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const event = JSON.parse(data.toString())
          this.handleEvent(event, config, resolve, connectTimeout)
        } catch (err) {
          console.error("[OpenAI] Failed to parse event:", err)
        }
      })

      this.ws.on("error", (err) => {
        console.error("[OpenAI] WebSocket error:", err.message)
        this.emit("error", err)
        if (!this._isConnected) {
          clearTimeout(connectTimeout)
          reject(err)
        }
      })

      this.ws.on("close", (code, reason) => {
        const reasonStr = reason?.toString() || ""
        console.log(`[OpenAI] WebSocket closed (code: ${code}, reason: ${reasonStr})`)
        this._isConnected = false
        this.emit("closed", code, reasonStr)
      })
    })
  }

  sendAudio(pcmBase64: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    try {
      this.ws.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: pcmBase64,
        }),
      )
    } catch {
      // Silently skip if WS is closing
    }
  }

  cancelResponse(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({type: "response.cancel"}))
  }

  disconnect(): void {
    this._isConnected = false
    if (this.ws) {
      try {
        this.ws.close(1000, "Session ended")
      } catch {
        // Already closed
      }
      this.ws = null
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private handleEvent(
    event: any,
    config: ProviderConfig,
    onReady: () => void,
    connectTimeout: ReturnType<typeof setTimeout>,
  ): void {
    switch (event.type) {
      case "session.created": {
        console.log("[OpenAI] Session created, configuring...")

        this.ws!.send(
          JSON.stringify({
            type: "session.update",
            session: {
              modalities: ["text", "audio"],
              instructions: config.systemPrompt,
              voice: config.voice || "ash",
              input_audio_format: "pcm16",
              output_audio_format: "pcm16",
              input_audio_transcription: {
                model: "whisper-1",
              },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
              },
            },
          }),
        )
        break
      }

      case "session.updated": {
        console.log("[OpenAI] Session configured, ready for audio")
        this._isConnected = true
        clearTimeout(connectTimeout)
        this.emit("ready")
        onReady()
        break
      }

      case "response.audio.delta": {
        if (!event.delta) break
        const pcmBytes = Buffer.from(event.delta, "base64")
        this.emit("audio", pcmBytes)
        break
      }

      case "response.audio.done": {
        this.emit("audioDone")
        break
      }

      case "response.audio_transcript.done": {
        if (event.transcript) {
          this.emit("transcript", event.transcript)
        }
        break
      }

      case "input_audio_buffer.speech_started": {
        this.emit("speechStarted")
        break
      }

      case "input_audio_buffer.speech_stopped": {
        this.emit("speechStopped")
        break
      }

      case "response.created": {
        this.emit("responseCreated")
        break
      }

      case "response.done": {
        const status = event.response?.status || "unknown"
        const error = status === "failed" ? event.response?.status_details?.error : undefined
        this.emit("responseDone", status, error)
        break
      }

      case "error": {
        this.emit("error", event.error)
        break
      }

      default:
        // rate_limits.updated, response.output_item.added, etc.
        break
    }
  }
}
