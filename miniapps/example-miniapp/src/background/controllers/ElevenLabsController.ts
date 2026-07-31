/**
 * ElevenLabsController — ConvAI mic → WebSocket + agent audio playback.
 *
 * Ports Mentra-Bluetooth-SDK-Starter-Kit/examples/react-native-elevenlabs-audio/App.tsx
 * conversation logic into the always-on background JSContext:
 *   signed URL → WebSocket → session.mic.onAudioChunk as { user_audio_chunk }
 *   agent audio_event (PCM base64) → session.speaker.createStream
 *
 * Mic capture (same feed as the Recorder miniapp): session.mic.onAudioChunk
 * delivers post-LC3-decode PCM16; we stream that into a fixed phone blob WAV
 * for playback after Stop.
 *
 * Do not run the session.mic tester and this conversation at the same time.
 */

import {base64ToBytes} from "@mentra/miniapp/background"
import type {BlobWriter, MiniappSession, UnsubscribeFn} from "@mentra/miniapp/background"

import type {Channels} from "../../shared/channels"
import {getElevenLabsConfig} from "../../shared/elevenlabsConfig"
import type {
  ElevenLabsCloseSource,
  ElevenLabsConversationState,
  ElevenLabsDiagnostics,
  ElevenLabsLogEntry,
  ElevenLabsRecording,
  ElevenLabsSnapshot,
  ElevenLabsStreamStats,
} from "../../shared/types"
import {
  appendQueryParam,
  approxBase64ByteLength,
  buildWavHeader,
  ELEVENLABS_RECORDING_BLOB_KEY,
  parsePcmSampleRate,
  pcmDurationMs,
  resamplePcm16Le,
  WAV_HEADER_BYTES,
} from "../elevenLabsHelpers"

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

const emptyRecording = (): ElevenLabsRecording => ({
  status: "none",
  blobKey: ELEVENLABS_RECORDING_BLOB_KEY,
  uri: null,
  bytes: 0,
  durationMs: 0,
  sampleRate: null,
  error: null,
  isPlaying: false,
})

/** Flush capture PCM to the blob once ~1.5s of 16kHz mono has buffered. */
const CAPTURE_FLUSH_BYTES = 48 * 1024
/**
 * Keep accepting mic PCM briefly after Stop (same idea as Recorder). Glasses
 * audio can still be in flight across BLE/bridges when the UI stop lands.
 */
const STOP_TAIL_DRAIN_MS = 1500

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
  /** Bumped on each start/stop so an in-flight Signing start can be abandoned. */
  private startGeneration = 0

  /** Agent TTS format from conversation_initiation_metadata (e.g. pcm_16000). */
  private agentOutputFormat: string | null = null
  /** True when metadata reports a non-PCM format (e.g. ulaw_*) — drop audio events. */
  private agentOutputUnsupported = false
  private agentSampleRate = 16000
  private speakerSampleRate: SpeakerSampleRate = 16000
  private speakerWriter: SpeakerWriter | null = null
  private speakerOpenPromise: Promise<SpeakerWriter | null> | null = null
  private speakerWriteChain: Promise<void> = Promise.resolve()
  private agentAudioChunksPlayed = 0
  /** Bumped on close/interrupt so in-flight createStream cannot leak a writer. */
  private speakerEpoch = 0

  /** Mic PCM (post-LC3) — streamed into a fixed phone blob as WAV. */
  private recording = emptyRecording()
  private captureWriter: BlobWriter | null = null
  private captureChunks: Uint8Array[] = []
  private captureBufBytes = 0
  private capturePcmBytes = 0
  private captureSampleRate = 16000
  private captureDrainChain: Promise<void> = Promise.resolve()
  private captureWriteErrored = false
  private playSeq = 0

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
        void this.refreshRecordingMeta().finally(() => this.pushSnapshot())
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

    this.unsubs.push(
      ui.handle("elevenlabs:play-recording", async () => {
        await this.playRecording()
        return {ok: true as const}
      }),
    )

    this.unsubs.push(
      ui.handle("elevenlabs:stop-playback", async () => {
        this.stopPlayback()
        return {ok: true as const}
      }),
    )

    void this.refreshRecordingMeta()
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
      recording: {...this.recording},
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
    const generation = ++this.startGeneration
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
    this.agentOutputUnsupported = false
    this.agentSampleRate = 16000
    this.speakerSampleRate = 16000
    this.agentAudioChunksPlayed = 0
    this.stopPlayback()
    await this.closeSpeaker()
    // Drop the previous conversation recording so we always reuse one phone path.
    await this.resetCaptureForNewConversation()
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
      // Stop (or a newer Start) during Signing must not open a WebSocket.
      if (generation !== this.startGeneration || this.conversationState !== "Signing") {
        this.appendLog("start aborted before WebSocket open")
        return
      }
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
        if (generation !== this.startGeneration || this.websocket !== websocket) {
          websocket.close()
          return
        }
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
        if (this.websocket !== websocket) return
        this.handleElevenLabsMessage(websocket, event.data)
      }

      websocket.onerror = (event) => {
        if (this.websocket !== websocket) return
        this.lastError = "ElevenLabs WebSocket error"
        this.updateDiagnostics({websocketState: "Error"})
        this.appendLog(`ElevenLabs WebSocket error: ${JSON.stringify(event)}`)
      }

      websocket.onclose = (event) => {
        // Ignore closes from sockets that Stop already replaced/cleared.
        if (this.websocket !== websocket) {
          return
        }
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
        void (async () => {
          // Keep mic briefly so in-flight post-LC3 PCM lands in the recording.
          await delay(STOP_TAIL_DRAIN_MS)
          this.stopGlassesPcm()
          await this.closeSpeaker()
          await this.finalizeCapture()
          this.conversationState = "Idle"
          this.pushSnapshot()
        })()
      }
    } catch (error) {
      if (generation !== this.startGeneration) {
        return
      }
      this.conversationState = "Idle"
      this.clearFirstPcmTimeout()
      this.updateDiagnostics({
        micStage: "Not started",
        signedUrlStatus: "Failed",
        websocketState: "Not connected",
      })
      this.fail(error)
    } finally {
      if (generation === this.startGeneration) {
        this.startInFlight = false
      }
    }
  }

  private async stopConversation(reason: ElevenLabsCloseSource = "user_stop"): Promise<void> {
    // Invalidate any in-flight Signing start so it cannot open a WebSocket afterward,
    // and clear startInFlight so a subsequent Start is not blocked on the abandoned fetch.
    this.startGeneration += 1
    this.startInFlight = false
    this.closeSource = reason
    this.clearFirstPcmTimeout()
    this.updateDiagnostics({micStage: "Stopping"})
    this.websocket?.close()
    this.websocket = null
    // Same as Recorder: keep the mic subscription alive briefly so in-flight
    // post-LC3 frames still land in the WAV before we finalize.
    await delay(STOP_TAIL_DRAIN_MS)
    this.stopGlassesPcm()
    await this.closeSpeaker()
    await this.finalizeCapture()
    this.conversationState = "Idle"
    this.pushSnapshot()
  }

  private startGlassesPcm(): void {
    this.stopMicSubscription()
    this.appendLog("requesting continuous glasses PCM via session.mic.onAudioChunk")
    this.updateDiagnostics({micStage: "Enabling mic stream"})
    const micRequestedAtMs = Date.now()
    this.updateDiagnostics({micRequestedAtMs, micStage: "Mic requested; waiting for PCM"})
    // Open the capture blob before subscribing so the first PCM frames aren't dropped.
    void this.ensureCapture().then(() => {
      if (this.conversationState !== "Streaming") return
      this.micUnsub = this.session.mic.onAudioChunk((chunk) => {
        this.handlePcmFrame(chunk.data, chunk.sampleRate, chunk.format)
      })
      this.startFirstPcmWatchdog()
      this.pushSnapshot()
    })
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

    // Record what the mic delivers after LC3 decode — same session.mic.onAudioChunk
    // feed the Recorder miniapp uses.
    if (sampleRate && sampleRate > 0) {
      this.captureSampleRate = sampleRate
    }
    const pcm = base64ToBytes(base64Pcm)
    if (pcm.byteLength >= 2) {
      this.appendCapturePcm(pcm)
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
        if (this.agentOutputUnsupported) {
          break
        }
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
      this.agentOutputUnsupported = true
      this.appendLog(`unsupported agent output format ${format} (need PCM for createStream) — dropping audio`)
      return
    }
    this.agentOutputUnsupported = false
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
    if (this.agentOutputUnsupported) return
    this.speakerWriteChain = this.speakerWriteChain
      .then(async () => {
        if (this.agentOutputUnsupported) return
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

    const epoch = this.speakerEpoch
    this.speakerOpenPromise = (async () => {
      try {
        const writer = (await this.session.speaker.createStream({
          sampleRate: this.speakerSampleRate,
          stopOtherAudio: true,
        })) as SpeakerWriter
        // Stop/close may have raced the open — abort the orphaned stream.
        if (epoch !== this.speakerEpoch) {
          try {
            await writer.abort()
          } catch {
            /* ignore */
          }
          return null
        }
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
    this.speakerEpoch += 1
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
    this.speakerEpoch += 1
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
    // ensureSpeaker may have assigned after we cleared speakerWriter above.
    const lateWriter = this.speakerWriter
    this.speakerWriter = null
    const toAbort = lateWriter && lateWriter !== writer ? [writer, lateWriter] : [writer]
    for (const w of toAbort) {
      if (!w) continue
      try {
        await w.abort()
      } catch {
        try {
          await w.close()
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ── Agent-audio capture (fixed phone blob path) ──────────────────────────

  private async refreshRecordingMeta(): Promise<void> {
    if (this.captureWriter || this.recording.status === "capturing") return
    try {
      const meta = await this.session.blob.get(ELEVENLABS_RECORDING_BLOB_KEY)
      if (!meta) {
        this.recording = emptyRecording()
        return
      }
      const sampleRate =
        typeof meta.meta?.sampleRate === "number" ? meta.meta.sampleRate : this.recording.sampleRate
      const durationMs =
        typeof meta.meta?.durationMs === "number"
          ? meta.meta.durationMs
          : pcmDurationMs(Math.max(0, meta.bytes - WAV_HEADER_BYTES), sampleRate || 16000)
      this.recording = {
        status: "ready",
        blobKey: ELEVENLABS_RECORDING_BLOB_KEY,
        uri: meta.uri,
        bytes: meta.bytes,
        durationMs,
        sampleRate: sampleRate || null,
        error: null,
        isPlaying: this.recording.isPlaying,
      }
    } catch (error) {
      this.recording = {
        ...emptyRecording(),
        status: "error",
        error: getErrorMessage(error),
        isPlaying: this.recording.isPlaying,
      }
    }
  }

  /** Clear prior recording and prepare to overwrite the same blob key. */
  private async resetCaptureForNewConversation(): Promise<void> {
    await this.abortCapture()
    try {
      await this.session.blob.delete(ELEVENLABS_RECORDING_BLOB_KEY)
    } catch {
      /* ignore missing */
    }
    this.recording = emptyRecording()
    this.appendLog(`recording reset → ${ELEVENLABS_RECORDING_BLOB_KEY}`)
  }

  private async ensureCapture(): Promise<void> {
    if (this.captureWriter || this.captureWriteErrored) return
    try {
      const writer = await this.session.blob.createWriteStream(ELEVENLABS_RECORDING_BLOB_KEY, {
        mimeType: "audio/wav",
        name: "elevenlabs-conversation.wav",
        meta: {title: "ElevenLabs mic"},
      })
      // Placeholder header — patched with real sizes on finalize.
      await writer.write(new Uint8Array(WAV_HEADER_BYTES))
      this.captureWriter = writer
      this.captureChunks = []
      this.captureBufBytes = 0
      this.capturePcmBytes = 0
      this.captureSampleRate = 16000
      this.captureDrainChain = Promise.resolve()
      this.captureWriteErrored = false
      this.recording = {
        status: "capturing",
        blobKey: ELEVENLABS_RECORDING_BLOB_KEY,
        uri: null,
        bytes: WAV_HEADER_BYTES,
        durationMs: 0,
        sampleRate: this.captureSampleRate,
        error: null,
        isPlaying: false,
      }
      this.appendLog(`capturing mic PCM → ${ELEVENLABS_RECORDING_BLOB_KEY}`)
      this.pushSnapshot()
    } catch (error) {
      this.captureWriteErrored = true
      this.recording = {
        ...emptyRecording(),
        status: "error",
        error: getErrorMessage(error),
      }
      this.appendLog(`capture open failed: ${getErrorMessage(error)}`)
      this.pushSnapshot()
    }
  }

  private appendCapturePcm(pcm: Uint8Array): void {
    if (!this.captureWriter || this.captureWriteErrored || pcm.byteLength < 2) return
    this.captureChunks.push(pcm)
    this.captureBufBytes += pcm.byteLength
    this.recording = {
      ...this.recording,
      status: "capturing",
      bytes: WAV_HEADER_BYTES + this.capturePcmBytes + this.captureBufBytes,
      durationMs: pcmDurationMs(this.capturePcmBytes + this.captureBufBytes, this.captureSampleRate),
      sampleRate: this.captureSampleRate,
    }
    if (this.captureBufBytes >= CAPTURE_FLUSH_BYTES) {
      this.scheduleCaptureDrain()
    }
  }

  private scheduleCaptureDrain(): void {
    this.captureDrainChain = this.captureDrainChain.then(() => this.drainCaptureOnce()).catch(() => {})
  }

  private async drainCaptureOnce(): Promise<void> {
    if (!this.captureWriter || this.captureWriteErrored) return
    while (this.captureChunks.length > 0) {
      const buf = this.takeCaptureBuffer()
      try {
        await this.captureWriter.write(buf)
        this.capturePcmBytes += buf.length
      } catch (error) {
        this.captureWriteErrored = true
        this.recording = {
          ...this.recording,
          status: "error",
          error: getErrorMessage(error),
        }
        this.appendLog(`capture write failed: ${getErrorMessage(error)}`)
        this.pushSnapshot()
        break
      }
    }
  }

  private takeCaptureBuffer(): Uint8Array {
    if (this.captureChunks.length === 1) {
      const only = this.captureChunks[0]!
      this.captureChunks = []
      this.captureBufBytes = 0
      return only
    }
    const out = new Uint8Array(this.captureBufBytes)
    let at = 0
    for (const c of this.captureChunks) {
      out.set(c, at)
      at += c.length
    }
    this.captureChunks = []
    this.captureBufBytes = 0
    return out
  }

  private async finalizeCapture(): Promise<void> {
    const writer = this.captureWriter
    if (!writer) {
      if (this.recording.status === "capturing") {
        this.recording = emptyRecording()
      }
      return
    }
    this.captureWriter = null
    try {
      await this.captureDrainChain
      await this.drainCaptureOnce()
      if (this.capturePcmBytes < 2 || this.captureWriteErrored) {
        await writer.abort().catch(() => {})
        this.recording = this.captureWriteErrored
          ? {...emptyRecording(), status: "error", error: this.recording.error ?? "capture write failed"}
          : emptyRecording()
        this.appendLog("capture aborted (no mic audio)")
        return
      }
      await writer.writeAt(0, buildWavHeader(this.captureSampleRate, this.capturePcmBytes))
      const meta = await writer.close({
        durationMs: pcmDurationMs(this.capturePcmBytes, this.captureSampleRate),
        sampleRate: this.captureSampleRate,
        channels: 1,
        bitsPerSample: 16,
        title: "ElevenLabs mic",
      })
      this.recording = {
        status: "ready",
        blobKey: ELEVENLABS_RECORDING_BLOB_KEY,
        uri: meta.uri,
        bytes: meta.bytes,
        durationMs: pcmDurationMs(this.capturePcmBytes, this.captureSampleRate),
        sampleRate: this.captureSampleRate,
        error: null,
        isPlaying: false,
      }
      this.appendLog(
        `recording saved ${meta.uri} (${this.recording.durationMs}ms, ${meta.bytes} bytes)`,
      )
    } catch (error) {
      try {
        await writer.abort()
      } catch {
        /* ignore */
      }
      this.recording = {
        ...emptyRecording(),
        status: "error",
        error: getErrorMessage(error),
      }
      this.appendLog(`capture finalize failed: ${getErrorMessage(error)}`)
    } finally {
      this.captureChunks = []
      this.captureBufBytes = 0
      this.capturePcmBytes = 0
      this.captureWriteErrored = false
      this.captureDrainChain = Promise.resolve()
    }
  }

  private async abortCapture(): Promise<void> {
    const writer = this.captureWriter
    this.captureWriter = null
    this.captureChunks = []
    this.captureBufBytes = 0
    this.capturePcmBytes = 0
    this.captureWriteErrored = false
    this.captureDrainChain = Promise.resolve()
    if (!writer) return
    try {
      await writer.abort()
    } catch {
      /* ignore */
    }
  }

  private async playRecording(): Promise<void> {
    if (this.conversationState !== "Idle") {
      throw new Error("Stop the conversation before playing the recording")
    }
    await this.refreshRecordingMeta()
    const uri = this.recording.uri
    if (!uri || this.recording.status !== "ready") {
      throw new Error("No conversation recording saved yet")
    }
    const seq = ++this.playSeq
    this.recording = {...this.recording, isPlaying: true}
    this.pushSnapshot()
    this.appendLog(`playing recording ${uri}`)
    // Detach so the RPC returns immediately and the UI can Stop mid-play.
    void this.session.speaker
      .play({audioUrl: uri, stopOtherAudio: true})
      .catch((error) => {
        this.appendLog(`playback failed: ${getErrorMessage(error)}`)
        this.recording = {
          ...this.recording,
          error: getErrorMessage(error),
        }
      })
      .finally(() => {
        if (this.playSeq === seq) {
          this.recording = {...this.recording, isPlaying: false}
          this.pushSnapshot()
        }
      })
  }

  private stopPlayback(): void {
    this.playSeq += 1
    try {
      this.session.speaker.stop()
    } catch {
      /* ignore */
    }
    if (this.recording.isPlaying) {
      this.recording = {...this.recording, isPlaying: false}
      this.pushSnapshot()
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

function mapSpeakerSampleRate(rate: number): SpeakerSampleRate {
  if (rate <= 16000) return 16000
  if (rate <= 24000) return 24000
  return 48000
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
