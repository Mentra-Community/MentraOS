/**
 * ElevenLabsController — ConvAI mic → WebSocket + agent audio playback.
 *
 * Ports Mentra-Bluetooth-SDK-Starter-Kit/examples/react-native-elevenlabs-audio/App.tsx
 * conversation logic into the always-on background JSContext:
 *   signed URL → WebSocket → session.mic.onAudioChunk as { user_audio_chunk }
 *   agent audio_event (PCM base64) → session.speaker.createStream
 *
 * Do not run the session.mic tester and this conversation at the same time.
 */

import {base64ToBytes} from "@mentra/miniapp/background"
import type {MiniappSession, UnsubscribeFn} from "@mentra/miniapp/background"

import type {Channels} from "../../shared/channels"
import {getElevenLabsConfig} from "../../shared/elevenlabsConfig"
import type {
  ElevenLabsCloseSource,
  ElevenLabsConversationState,
  ElevenLabsDiagnostics,
  ElevenLabsLogEntry,
  ElevenLabsSnapshot,
  ElevenLabsStreamStats,
} from "../../shared/types"

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void

type ElevenLabsEvent = {
  type?: string
  [key: string]: unknown
}

type SpeakerSampleRate = 16000 | 24000 | 48000

type SpeakerWriter = {
  writeBase64(b64: string): Promise<{bufferedMs: number}>
  write(chunk: Uint8Array | ArrayBuffer): Promise<{bufferedMs: number}>
  close(): Promise<{durationMs?: number}>
  abort(): Promise<void>
}

const emptyStats = (): ElevenLabsStreamStats => ({
  droppedChunks: 0,
  frames: 0,
  receivedBytes: 0,
  sentBytes: 0,
  sentChunks: 0,
})

const emptyDiagnostics = (): ElevenLabsDiagnostics => ({
  elevenLabsEventCount: 0,
  firstPcmDelayMs: null,
  firstPcmAtMs: null,
  lastElevenLabsEvent: "None",
  lastPcmAtMs: null,
  lastPcmSize: null,
  lastSendError: null,
  micRequestedAtMs: null,
  micStage: "Idle",
  signedUrlLatencyMs: null,
  signedUrlStatus: "Not requested",
  websocketCloseAfterMs: null,
  websocketCloseCode: null,
  websocketCloseReason: "",
  websocketCloseSource: "none",
  websocketCloseWasClean: null,
  websocketOpenedAtMs: null,
  websocketState: "Not connected",
  websocketTarget: "Unknown",
})

export class ElevenLabsController {
  private started = false
  private readonly unsubs: Array<() => void> = []
  private send: Send | null = null

  private readonly config = getElevenLabsConfig()
  private conversationState: ElevenLabsConversationState = "Idle"
  private lastError: string | null = null
  private lastTranscript = ""
  private lastAgentResponse = ""
  private metadata = ""
  private vadScore: number | null = null
  private stats = emptyStats()
  private diagnostics = emptyDiagnostics()
  private logs: ElevenLabsLogEntry[] = []
  private logIndex = 0

  private websocket: WebSocket | null = null
  private micUnsub: UnsubscribeFn | null = null
  private audioMetadataCaptured = false
  private closeSource: ElevenLabsCloseSource = "none"
  private firstPcmTimeout: ReturnType<typeof setTimeout> | null = null
  private websocketOpenedAtMs: number | null = null
  private startInFlight = false

  /** Agent TTS format from conversation_initiation_metadata (e.g. pcm_16000). */
  private agentOutputFormat: string | null = null
  private agentSampleRate = 16000
  private speakerSampleRate: SpeakerSampleRate = 16000
  private speakerWriter: SpeakerWriter | null = null
  private speakerOpenPromise: Promise<SpeakerWriter | null> | null = null
  private speakerWriteChain: Promise<void> = Promise.resolve()
  private agentAudioChunksPlayed = 0
  /**
   * While agent TTS is playing (plus a short hangover), do not forward mic PCM
   * to ElevenLabs. Otherwise the glasses speaker leaks into the mic and STT
   * echoes the agent back as "user" speech (feedback loop / "..." transcripts).
   */
  private agentSpeakingUntilMs = 0
  private static readonly MIC_MUTE_HANGOVER_MS = 450

  constructor(private readonly session: MiniappSession) {}

  start(): void {
    if (this.started) return
    this.started = true

    const ui = this.session.ui as unknown as {
      send: Send
      onOpen: (cb: () => void) => () => void
      handle: <C extends keyof Channels & string>(
        channel: C,
        handler: (payload: unknown, ctx?: {signal: AbortSignal}) => Promise<unknown> | unknown,
      ) => () => void
    }

    this.send = ui.send

    this.unsubs.push(
      ui.onOpen(() => {
        this.pushSnapshot()
      }),
    )

    this.unsubs.push(
      ui.handle("elevenlabs:start", async () => {
        await this.startConversation()
        if (this.lastError && this.conversationState === "Idle") {
          throw new Error(this.lastError)
        }
        return {ok: true as const}
      }),
    )

    this.unsubs.push(
      ui.handle("elevenlabs:stop", async () => {
        await this.stopConversation("user_stop")
        return {ok: true as const}
      }),
    )
  }

  private snapshot(): ElevenLabsSnapshot {
    return {
      agentId: this.config.agentId,
      signedUrlEndpoint: this.config.signedUrlEndpoint,
      conversationState: this.conversationState,
      lastError: this.lastError,
      lastTranscript: this.lastTranscript,
      lastAgentResponse: this.lastAgentResponse,
      metadata: this.metadata,
      vadScore: this.vadScore,
      stats: {...this.stats},
      diagnostics: {...this.diagnostics},
      logs: this.logs.slice(),
    }
  }

  private pushSnapshot(): void {
    this.send?.("elevenlabs:update", this.snapshot())
  }

  private appendLog(message: string): void {
    console.log(`[ElevenLabs] ${message}`)
    this.logIndex += 1
    this.logs = [
      {
        id: `${Date.now()}-${this.logIndex}`,
        message,
      },
      ...this.logs,
    ].slice(0, 40)
    this.pushSnapshot()
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.lastError = message
    this.appendLog(`error: ${message}`)
  }

  private updateDiagnostics(next: Partial<ElevenLabsDiagnostics>): void {
    this.diagnostics = {...this.diagnostics, ...next}
  }

  private async startConversation(): Promise<void> {
    if (this.conversationState === "Streaming" || this.conversationState === "Signing" || this.startInFlight) {
      return
    }

    this.startInFlight = true
    this.lastError = null
    this.conversationState = "Signing"
    this.lastTranscript = ""
    this.lastAgentResponse = ""
    this.metadata = ""
    this.audioMetadataCaptured = false
    this.vadScore = null
    this.stats = emptyStats()
    this.closeSource = "remote"
    this.websocketOpenedAtMs = null
    this.agentOutputFormat = null
    this.agentSampleRate = 16000
    this.speakerSampleRate = 16000
    this.agentAudioChunksPlayed = 0
    this.agentSpeakingUntilMs = 0
    await this.closeSpeaker()
    this.clearFirstPcmTimeout()
    this.diagnostics = {
      ...emptyDiagnostics(),
      micStage: "Waiting for WebSocket",
      signedUrlStatus: "Requesting",
      websocketTarget: describeUrl(this.config.signedUrlEndpoint),
    }
    this.appendLog("fetching ElevenLabs signed URL")

    try {
      const signedUrlStartedAtMs = Date.now()
      const signedUrl = await fetchSignedUrlFromLocalServer(
        this.config.signedUrlEndpoint,
        this.config.agentId,
      )
      this.updateDiagnostics({
        signedUrlLatencyMs: Date.now() - signedUrlStartedAtMs,
        signedUrlStatus: "OK",
        websocketState: "Connecting",
        websocketTarget: describeUrl(signedUrl),
      })
      this.pushSnapshot()

      const websocket = new WebSocket(signedUrl)
      this.websocket = websocket

      websocket.onopen = () => {
        const openedAtMs = Date.now()
        this.websocketOpenedAtMs = openedAtMs
        this.conversationState = "Streaming"
        this.updateDiagnostics({
          micStage: "Starting mic",
          websocketOpenedAtMs: openedAtMs,
          websocketState: "Open",
        })
        this.appendLog("ElevenLabs WebSocket open")
        sendJson(websocket, {type: "conversation_initiation_client_data"})
        try {
          this.startGlassesPcm()
        } catch (error) {
          this.closeSource = "mic_start_failed"
          this.updateDiagnostics({micStage: "Mic start failed"})
          this.fail(error)
          websocket.close()
        }
      }

      websocket.onmessage = (event) => {
        this.handleElevenLabsMessage(websocket, event.data)
      }

      websocket.onerror = (event) => {
        this.lastError = "ElevenLabs WebSocket error"
        this.updateDiagnostics({websocketState: "Error"})
        this.appendLog(`ElevenLabs WebSocket error: ${JSON.stringify(event)}`)
      }

      websocket.onclose = (event) => {
        const openedAtMs = this.websocketOpenedAtMs
        const closedAtMs = Date.now()
        const closeAfterMs = openedAtMs === null ? null : closedAtMs - openedAtMs
        const source = this.closeSource
        const code = event.code
        const reason = event.reason || ""
        const wasClean = event.wasClean

        this.appendLog(
          `ElevenLabs WebSocket closed: source=${source} code=${code} reason=${
            reason || "(empty)"
          } clean=${String(wasClean)} after=${closeAfterMs === null ? "?" : `${closeAfterMs}ms`}`,
        )
        if (source === "remote" && closeAfterMs !== null && closeAfterMs < 5000) {
          this.lastError = `ElevenLabs closed the WebSocket after ${closeAfterMs}ms (code ${code}, reason ${
            reason || "empty"
          }).`
        }
        this.clearFirstPcmTimeout()
        this.updateDiagnostics({
          micStage: "Stopped",
          websocketCloseAfterMs: closeAfterMs,
          websocketCloseCode: code,
          websocketCloseReason: reason,
          websocketCloseSource: source,
          websocketCloseWasClean: wasClean,
          websocketState: "Closed",
        })
        this.websocket = null
        this.stopGlassesPcm()
        void this.closeSpeaker()
        this.conversationState = "Idle"
        this.pushSnapshot()
      }
    } catch (error) {
      this.conversationState = "Idle"
      this.clearFirstPcmTimeout()
      this.updateDiagnostics({
        micStage: "Not started",
        signedUrlStatus: "Failed",
        websocketState: "Not connected",
      })
      this.fail(error)
    } finally {
      this.startInFlight = false
    }
  }

  private async stopConversation(reason: ElevenLabsCloseSource = "user_stop"): Promise<void> {
    this.closeSource = reason
    this.clearFirstPcmTimeout()
    this.updateDiagnostics({micStage: "Stopping"})
    this.stopGlassesPcm()
    await this.closeSpeaker()
    this.websocket?.close()
    this.websocket = null
    this.conversationState = "Idle"
    this.pushSnapshot()
  }

  private startGlassesPcm(): void {
    this.stopMicSubscription()
    this.appendLog("requesting continuous glasses PCM via session.mic.onAudioChunk")
    this.updateDiagnostics({micStage: "Enabling mic stream"})
    const micRequestedAtMs = Date.now()
    this.updateDiagnostics({micRequestedAtMs, micStage: "Mic requested; waiting for PCM"})
    this.micUnsub = this.session.mic.onAudioChunk((chunk) => {
      this.handlePcmFrame(chunk.data, chunk.sampleRate, chunk.format)
    })
    this.startFirstPcmWatchdog()
    this.pushSnapshot()
  }

  private stopGlassesPcm(): void {
    this.stopMicSubscription()
    try {
      this.session.mic.stop()
    } catch {
      /* ignore */
    }
  }

  private stopMicSubscription(): void {
    if (this.micUnsub) {
      try {
        this.micUnsub()
      } catch {
        /* ignore */
      }
      this.micUnsub = null
    }
  }

  private clearFirstPcmTimeout(): void {
    if (this.firstPcmTimeout) {
      clearTimeout(this.firstPcmTimeout)
      this.firstPcmTimeout = null
    }
  }

  private startFirstPcmWatchdog(): void {
    this.clearFirstPcmTimeout()
    this.firstPcmTimeout = setTimeout(() => {
      if (!this.diagnostics.firstPcmAtMs) {
        this.updateDiagnostics({micStage: "Mic requested; no PCM yet"})
        this.appendLog("mic requested, still waiting for first PCM frame")
      }
    }, 3000)
  }

  private handlePcmFrame(base64Pcm: string, sampleRate?: number, format?: string): void {
    const websocket = this.websocket
    const byteLength = approxBase64ByteLength(base64Pcm)
    const receivedAtMs = Date.now()
    const nextBase: ElevenLabsStreamStats = {
      ...this.stats,
      frames: this.stats.frames + 1,
      receivedBytes: this.stats.receivedBytes + byteLength,
    }

    if (nextBase.frames === 1) {
      this.clearFirstPcmTimeout()
      this.appendLog(`first PCM frame: ~${byteLength} bytes`)
    }

    if (!this.audioMetadataCaptured) {
      this.audioMetadataCaptured = true
      const rate = sampleRate ?? 16000
      const fmt = format ?? "pcm16"
      this.metadata = `${rate} Hz, ${fmt}`
    }

    if (nextBase.frames === 1 || nextBase.frames % 10 === 0) {
      this.updateDiagnostics({
        firstPcmDelayMs:
          this.diagnostics.firstPcmDelayMs ??
          (this.diagnostics.micRequestedAtMs === null
            ? null
            : receivedAtMs - this.diagnostics.micRequestedAtMs),
        firstPcmAtMs: this.diagnostics.firstPcmAtMs ?? receivedAtMs,
        lastPcmAtMs: receivedAtMs,
        lastPcmSize: byteLength,
        micStage: "Receiving PCM",
      })
    }

    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
      this.stats = {
        ...nextBase,
        droppedChunks: nextBase.droppedChunks + 1,
      }
      if (nextBase.frames === 1 || nextBase.frames % 10 === 0) {
        this.pushSnapshot()
      }
      return
    }

    try {
      websocket.send(JSON.stringify({user_audio_chunk: base64Pcm}))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.updateDiagnostics({lastSendError: message})
      this.appendLog(`failed to send PCM chunk: ${message}`)
      this.stats = {
        ...nextBase,
        droppedChunks: nextBase.droppedChunks + 1,
      }
      return
    }

    this.stats = {
      ...nextBase,
      sentBytes: nextBase.sentBytes + byteLength,
      sentChunks: nextBase.sentChunks + 1,
    }

    if (this.stats.sentChunks % 10 === 0) {
      this.pushSnapshot()
    }
  }

  private handleElevenLabsMessage(websocket: WebSocket, rawData: unknown): void {
    if (typeof rawData !== "string") {
      // Some polyfills deliver ArrayBuffer — decode if possible.
      if (rawData instanceof ArrayBuffer) {
        rawData = new TextDecoder().decode(rawData)
      } else {
        this.appendLog("received non-string WebSocket message")
        return
      }
    }

    const text = rawData as string
    let event: ElevenLabsEvent
    try {
      event = JSON.parse(text) as ElevenLabsEvent
    } catch {
      this.appendLog(`received non-JSON WebSocket message: ${text.slice(0, 80)}`)
      return
    }

    this.updateDiagnostics({
      elevenLabsEventCount: this.diagnostics.elevenLabsEventCount + 1,
      lastElevenLabsEvent: event.type ?? "unknown",
    })

    switch (event.type) {
      case "conversation_initiation_metadata": {
        const data = event.conversation_initiation_metadata_event as {
          conversation_id?: string
          user_input_audio_format?: string
          agent_output_audio_format?: string
        }
        this.appendLog(`conversation ${data.conversation_id}`)
        if (data.agent_output_audio_format) {
          this.applyAgentOutputFormat(data.agent_output_audio_format)
        }
        if (data.user_input_audio_format || data.agent_output_audio_format) {
          this.metadata = [
            this.metadata,
            `11labs input=${data.user_input_audio_format ?? "?"}`,
            `11labs output=${data.agent_output_audio_format ?? "?"}`,
            `speaker=${this.speakerSampleRate}`,
          ]
            .filter(Boolean)
            .join(" | ")
          this.pushSnapshot()
        }
        break
      }
      case "ping": {
        const pingEvent = event.ping_event as {ping_ms?: number; event_id?: string}
        const delayMs = pingEvent.ping_ms ?? 0
        setTimeout(() => {
          sendJson(websocket, {
            type: "pong",
            event_id: pingEvent.event_id,
          })
        }, delayMs)
        this.pushSnapshot()
        break
      }
      case "user_transcript": {
        const data = event.user_transcription_event as {user_transcript?: string}
        const transcript = (data.user_transcript ?? "").trim()
        // ElevenLabs STT often emits "..." for silence/noise — ignore it.
        if (!transcript || transcript === "..." || /^\.+$/.test(transcript)) {
          break
        }
        this.lastTranscript = transcript
        this.appendLog(`transcript: ${this.lastTranscript}`)
        break
      }
      case "agent_response": {
        const data = event.agent_response_event as {agent_response?: string}
        this.lastAgentResponse = data.agent_response ?? ""
        this.appendLog(`agent: ${this.lastAgentResponse}`)
        break
      }
      case "audio": {
        const data = event.audio_event as {event_id?: number | string; audio_base_64?: string}
        if (!data.audio_base_64) {
          this.appendLog(`agent audio chunk ${data.event_id} missing audio_base_64`)
          break
        }
        this.enqueueAgentAudio(data.audio_base_64, data.event_id)
        break
      }
      case "vad_score": {
        const data = event.vad_score_event as {vad_score?: number}
        this.vadScore = typeof data.vad_score === "number" ? data.vad_score : null
        this.pushSnapshot()
        break
      }
      case "interruption": {
        const data = event.interruption_event as {reason?: string} | undefined
        this.appendLog(`interruption: ${data?.reason ?? "unknown"} — aborting speaker`)
        void this.interruptSpeaker()
        break
      }
      default:
        this.appendLog(`event: ${event.type}`)
        break
    }
  }

  private applyAgentOutputFormat(format: string): void {
    this.agentOutputFormat = format
    if (format.startsWith("ulaw_")) {
      this.appendLog(`unsupported agent output format ${format} (need PCM for createStream)`)
      return
    }
    const rate = parsePcmSampleRate(format)
    if (rate === null) {
      this.appendLog(`unknown agent output format ${format}; assuming pcm_16000`)
      this.agentSampleRate = 16000
      this.speakerSampleRate = 16000
      return
    }
    this.agentSampleRate = rate
    this.speakerSampleRate = mapSpeakerSampleRate(rate)
    if (this.agentSampleRate !== this.speakerSampleRate) {
      this.appendLog(
        `agent PCM ${this.agentSampleRate}Hz → speaker ${this.speakerSampleRate}Hz (resample)`,
      )
    }
  }

  private enqueueAgentAudio(audioBase64: string, eventId?: number | string): void {
    this.speakerWriteChain = this.speakerWriteChain
      .then(async () => {
        const writer = await this.ensureSpeaker()
        if (!writer) return

        if (this.agentSampleRate === this.speakerSampleRate) {
          await writer.writeBase64(audioBase64)
        } else {
          const pcm = base64ToBytes(audioBase64)
          const resampled = resamplePcm16Le(pcm, this.agentSampleRate, this.speakerSampleRate)
          if (resampled.byteLength >= 2) {
            await writer.write(resampled)
          }
        }

        this.agentAudioChunksPlayed += 1
        if (this.agentAudioChunksPlayed === 1 || this.agentAudioChunksPlayed % 25 === 0) {
          this.appendLog(
            `playing agent audio chunk ${eventId ?? "?"} (#${this.agentAudioChunksPlayed})`,
          )
        }
      })
      .catch((error) => {
        this.appendLog(`speaker write failed (${eventId ?? "?"}): ${getErrorMessage(error)}`)
      })
  }

  private async ensureSpeaker(): Promise<SpeakerWriter | null> {
    if (this.speakerWriter) {
      return this.speakerWriter
    }
    if (this.speakerOpenPromise) {
      return this.speakerOpenPromise
    }

    this.speakerOpenPromise = (async () => {
      try {
        const writer = (await this.session.speaker.createStream({
          sampleRate: this.speakerSampleRate,
          stopOtherAudio: true,
        })) as SpeakerWriter
        this.speakerWriter = writer
        this.appendLog(`speaker stream open @ ${this.speakerSampleRate}Hz for ${this.agentOutputFormat ?? "pcm"}`)
        return writer
      } catch (error) {
        this.appendLog(`speaker.createStream failed: ${getErrorMessage(error)}`)
        return null
      } finally {
        this.speakerOpenPromise = null
      }
    })()

    return this.speakerOpenPromise
  }

  private async interruptSpeaker(): Promise<void> {
    const writer = this.speakerWriter
    this.speakerWriter = null
    this.speakerOpenPromise = null
    this.speakerWriteChain = Promise.resolve()
    if (!writer) return
    try {
      await writer.abort()
    } catch {
      /* ignore */
    }
  }

  private async closeSpeaker(): Promise<void> {
    const writer = this.speakerWriter
    this.speakerWriter = null
    this.speakerOpenPromise = null
    // Wait for in-flight writes, then abort (don't wait for full drain on stop).
    const pending = this.speakerWriteChain
    this.speakerWriteChain = Promise.resolve()
    try {
      await pending
    } catch {
      /* ignore */
    }
    if (!writer) return
    try {
      await writer.abort()
    } catch {
      try {
        await writer.close()
      } catch {
        /* ignore */
      }
    }
  }
}

async function fetchSignedUrlFromLocalServer(endpoint: string, agentId: string): Promise<string> {
  // Miniapp JSContext has no URL / URLSearchParams globals — build the query by hand.
  const requestUrl = appendQueryParam(endpoint, "agent_id", agentId)

  let response: Response
  try {
    response = await fetch(requestUrl)
  } catch (error) {
    throw new Error(`signed-url fetch failed at ${describeUrl(requestUrl)}: ${getErrorMessage(error)}`)
  }

  if (!response.ok) {
    throw new Error(`signed-url server failed (${response.status}): ${await response.text().catch(() => "")}`)
  }
  const data = (await response.json()) as {signed_url?: string}
  if (!data.signed_url) {
    throw new Error("signed-url server response missing signed_url")
  }
  return data.signed_url
}

/** Append ?key= / &key= without relying on the URL constructor. */
function appendQueryParam(endpoint: string, key: string, value: string): string {
  const encoded = `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
  const hashIndex = endpoint.indexOf("#")
  const withoutHash = hashIndex >= 0 ? endpoint.slice(0, hashIndex) : endpoint
  const hash = hashIndex >= 0 ? endpoint.slice(hashIndex) : ""
  const sep = withoutHash.includes("?") ? "&" : "?"
  return `${withoutHash}${sep}${encoded}${hash}`
}

/** Strip query/hash for log-friendly display (no URL global). */
function describeUrl(rawUrl: string): string {
  const noHash = rawUrl.split("#")[0] ?? rawUrl
  const noQuery = noHash.split("?")[0] ?? noHash
  return noQuery || rawUrl
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || "Error"
  }
  if (typeof error === "string") {
    return error
  }
  if (error && typeof error === "object") {
    const record = error as {message?: unknown; error?: unknown; code?: unknown}
    if (typeof record.message === "string" && record.message) {
      return record.message
    }
    if (typeof record.error === "string" && record.error) {
      return record.error
    }
    try {
      return JSON.stringify(error)
    } catch {
      return Object.prototype.toString.call(error)
    }
  }
  return String(error)
}

function sendJson(websocket: WebSocket, message: object): void {
  if (websocket.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify(message))
  }
}

/** Approximate decoded byte length of a base64 payload (padding-aware). */
function approxBase64ByteLength(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding)
}

function parsePcmSampleRate(format: string): number | null {
  const match = /^pcm_(\d+)$/.exec(format)
  if (!match) return null
  const rate = Number(match[1])
  return Number.isFinite(rate) && rate > 0 ? rate : null
}

function mapSpeakerSampleRate(rate: number): SpeakerSampleRate {
  if (rate <= 16000) return 16000
  if (rate <= 24000) return 24000
  return 48000
}

/** Linear resample 16-bit LE mono PCM between sample rates. */
function resamplePcm16Le(input: Uint8Array, fromRate: number, toRate: number): Uint8Array {
  if (fromRate === toRate || input.byteLength < 2) {
    return input
  }
  const inSamples = input.byteLength >> 1
  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate))
  const out = new Uint8Array(outSamples * 2)
  const inView = new DataView(input.buffer, input.byteOffset, input.byteLength)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < outSamples; i++) {
    const src = (i * fromRate) / toRate
    const i0 = Math.floor(src)
    const i1 = Math.min(i0 + 1, inSamples - 1)
    const frac = src - i0
    const s0 = inView.getInt16(i0 * 2, true)
    const s1 = inView.getInt16(i1 * 2, true)
    outView.setInt16(i * 2, Math.round(s0 + (s1 - s0) * frac), true)
  }
  return out
}
