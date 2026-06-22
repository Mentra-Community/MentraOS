import {registerMiniapp} from "@mentra/miniapp/background"
import type {CloudClientStatus, MiniappSession, TranscriptionData, UnsubscribeFn} from "@mentra/miniapp/background"

import type {Channels} from "../shared/channels"
import type {ChatMessage, ChatRole, EverythingBackendStatus, EverythingSnapshot} from "../shared/types"

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void
type On = <C extends keyof Channels & string>(channel: C, cb: (payload: Channels[C]) => void) => () => void

interface ChatResponse {
  text?: string
  imageBase64?: string | null
}

const DEFAULT_BACKEND_URL = "https://everything.mentraglass.com"
const MAX_MESSAGES = 50
// Glasses canvas is 576x288; a single positioned container is capped at
// 200x100, so render the chart at that size and center it on the canvas.
const IMAGE_W = 200
const IMAGE_H = 100
const IMAGE_BOX = {
  width: IMAGE_W,
  height: IMAGE_H,
  x: Math.round((576 - IMAGE_W) / 2),
  y: Math.round((288 - IMAGE_H) / 2),
}

function configuredBackendUrl(): string {
  const fromEnv = process.env.MENTRA_PUBLIC_EVERYTHING_BACKEND_URL?.trim()
  return (fromEnv || DEFAULT_BACKEND_URL).replace(/\/+$/, "")
}

class EverythingController {
  private readonly unsubs: Array<() => void> = []
  private transcriptionCleanup: UnsubscribeFn | null = null
  private messages: ChatMessage[] = []
  private recording = false
  private recordingBuffer = ""
  private processing = false
  private cloudStatus: CloudClientStatus = {status: "disconnected", audioTransport: "none"}
  private backendStatus: EverythingBackendStatus = "idle"
  private lastError: string | null = null
  private readonly backendUrl = configuredBackendUrl()

  private ui!: {
    send: Send
    on: On
    onOpen: (cb: () => void) => () => void
  }

  constructor(private readonly session: MiniappSession) {}

  async start(): Promise<void> {
    this.ui = this.session.ui as unknown as {
      send: Send
      on: On
      onOpen: (cb: () => void) => () => void
    }

    this.wireUI()
    this.wireCloudStatus()
    this.transcriptionCleanup = this.session.transcription.on((data) => {
      this.handleTranscription(data)
    })

    console.log(`Everything: started conversational AI miniapp backend=${this.backendUrl}`)
  }

  stop(): void {
    if (this.transcriptionCleanup) {
      this.transcriptionCleanup()
      this.transcriptionCleanup = null
    }
    for (const unsub of this.unsubs) {
      try {
        unsub()
      } catch {
        /* ignore */
      }
    }
    this.unsubs.length = 0
  }

  private wireUI(): void {
    this.unsubs.push(this.ui.onOpen(() => this.sendSnapshot()))
    this.unsubs.push(this.ui.on("everything:request-snapshot", () => this.sendSnapshot()))
    this.unsubs.push(this.ui.on("everything:start-recording", () => this.startRecording()))
    this.unsubs.push(this.ui.on("everything:stop-recording", () => this.stopRecording()))
    this.unsubs.push(
      this.ui.on("everything:send", ({text}) => {
        void this.handleUserMessage(text)
      }),
    )
    this.unsubs.push(this.ui.on("everything:clear", () => this.clear()))
  }

  private wireCloudStatus(): void {
    try {
      this.unsubs.push(
        this.session.cloud.onStatusChanged((status) => {
          this.cloudStatus = {...status}
          this.ui.send("everything:cloud-status", {...this.cloudStatus})
        }),
      )
    } catch (err) {
      console.log("Everything: cloud status subscribe failed", err)
    }
  }

  private handleTranscription(data: TranscriptionData): void {
    if (!this.recording) return
    const text = data.text.trim()
    if (!text) return

    if (data.isFinal) {
      this.recordingBuffer = appendUtterance(this.recordingBuffer, text)
      // Surface the running buffer so the composer reflects committed speech.
      this.ui.send("everything:interim", {text: this.recordingBuffer})
    } else {
      // Show buffer + the live (uncommitted) partial without storing it.
      this.ui.send("everything:interim", {text: appendUtterance(this.recordingBuffer, text)})
    }
  }

  private startRecording(): void {
    this.recording = true
    this.recordingBuffer = ""
    this.ui.send("everything:recording", {recording: true})
    this.ui.send("everything:interim", {text: ""})
  }

  private stopRecording(): void {
    this.recording = false
    this.ui.send("everything:recording", {recording: false})
    this.ui.send("everything:interim", {text: ""})
    const text = this.recordingBuffer.trim()
    this.recordingBuffer = ""
    if (text) void this.handleUserMessage(text)
  }

  private async handleUserMessage(rawText: string): Promise<void> {
    const text = rawText.trim()
    if (!text || this.processing) return

    const userMessage = this.addMessage("user", text)
    void userMessage
    await this.sendToBackend()
  }

  private async sendToBackend(): Promise<void> {
    this.setProcessing(true)
    this.setBackendStatus("processing", null)

    try {
      const res = await this.session.auth.fetch(`${this.backendUrl}/api/chat`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          userId: this.session.userId,
          messages: this.messages.map((m) => ({role: m.role, text: m.text})),
        }),
      })

      const body = (await res.json().catch(() => ({}))) as ChatResponse & {error?: string}
      if (!res.ok) {
        throw new Error(body.error || body.text || `backend ${res.status}`)
      }

      const answer = (body.text ?? "").trim() || "(no response)"
      const imageBase64 = body.imageBase64 ?? null
      this.setBackendStatus("ok", null)
      this.addMessage("assistant", answer, imageBase64)

      if (imageBase64) {
        try {
          this.session.canvas.showBitmap(imageBase64, IMAGE_BOX)
        } catch (err) {
          console.log("Everything: canvas.showBitmap failed", err)
        }
      } else {
        this.session.canvas.showText(answer)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Chat request failed"
      this.setBackendStatus(message.includes("ANTHROPIC_API_KEY") ? "unconfigured" : "error", message)
      this.addMessage("assistant", `⚠️ ${message}`)
      console.log(`Everything: chat backend failed: ${message}`)
    } finally {
      this.setProcessing(false)
    }
  }

  private clear(): void {
    this.messages = []
    this.lastError = null
    this.backendStatus = "idle"
    try {
      this.session.canvas.clear()
    } catch {
      /* ignore */
    }
    this.sendSnapshot()
  }

  private addMessage(role: ChatRole, text: string, imageBase64: string | null = null): ChatMessage {
    const message: ChatMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      role,
      text,
      imageBase64,
      createdAt: Date.now(),
    }
    this.messages.push(message)
    if (this.messages.length > MAX_MESSAGES) this.messages = this.messages.slice(-MAX_MESSAGES)
    this.ui.send("everything:message", message)
    return message
  }

  private setProcessing(processing: boolean): void {
    this.processing = processing
    this.ui.send("everything:processing", {processing})
  }

  private setBackendStatus(status: EverythingBackendStatus, lastError: string | null): void {
    this.backendStatus = status
    this.lastError = lastError
    this.ui.send("everything:backend-status", {status, lastError})
  }

  private sendSnapshot(): void {
    const snapshot: EverythingSnapshot = {
      messages: [...this.messages],
      recording: this.recording,
      processing: this.processing,
      backendUrl: this.backendUrl,
      backendStatus: this.backendStatus,
      cloudStatus: {...this.cloudStatus},
      lastError: this.lastError,
    }
    this.ui.send("everything:snapshot", snapshot)
  }
}

function appendUtterance(buffer: string, utterance: string): string {
  const base = buffer.trim()
  const next = utterance.trim()
  if (!base) return next
  if (!next) return base
  return `${base} ${next}`
}

registerMiniapp((session) => {
  const controller = new EverythingController(session)
  void controller.start()
  session.onBeforeDisconnect(() => {
    controller.stop()
  })
})
