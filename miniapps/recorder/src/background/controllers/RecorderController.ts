/**
 * RecorderController — the always-on Recorder logic for this miniapp.
 *
 * Lives in the per-miniapp JSContext (NOT the WebView). Survives WebView
 * open/close so a capture keeps running with the phone pocketed.
 *
 * Capture is done entirely in the miniapp — the host stays a generic byte store:
 *   - `session.mic.onAudioChunk` delivers base64 PCM16 frames over the bridge.
 *   - We decode + buffer them, then stream the bytes into a `session.blob` writer
 *     in ~1.5s chunks (BLOB_WRITE). A 44-byte placeholder WAV header is written
 *     first; on stop we know the size and patch the real header in at offset 0
 *     (writeAt), then commit.
 *   - Playback uses `session.speaker.play` on the blob's file:// uri; export uses
 *     `session.blob.export` (OS share sheet).
 *
 * The captured PCM is what the audio system produces AFTER LC3 decode (the same
 * stream that feeds transcription) — i.e. a debugging view of "what audio did we
 * actually get".
 */

import {base64ToBytes} from "@mentra/miniapp/background"
import type {AudioChunkData, BlobMeta, BlobWriter, MiniappSession, UnsubscribeFn} from "@mentra/miniapp/background"

import type {Channels} from "../../shared/channels"
import type {RecorderStatus, RecordingItem, Usage} from "../../shared/types"
import {buildWavHeader, pcmDurationMs, pcmPeakLevel, WAV_HEADER_BYTES} from "../wav"

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void
type On = <C extends keyof Channels & string>(channel: C, cb: (payload: Channels[C]) => void) => () => void

const EMPTY_USAGE: Usage = {bytes: 0, count: 0, quotaBytes: 0}
const DEFAULT_SAMPLE_RATE = 16000
/** Flush the PCM buffer to the blob once it reaches ~1.5s of 16kHz mono audio. */
const FLUSH_BYTES = 48 * 1024
/** Throttle UI status pushes to ~5/sec (keyed off captured audio ms, not a timer). */
const PROGRESS_MS = 200

export class RecorderController {
  private started = false
  private readonly unsubs: Array<() => void> = []

  private ui!: {send: Send; on: On; onOpen: (cb: () => void) => () => void}

  // Capture state
  private recordingId: string | null = null
  private writer: BlobWriter | null = null
  private micUnsub: UnsubscribeFn | null = null
  private chunks: Uint8Array[] = []
  private bufBytes = 0
  private pcmBytes = 0
  private sampleRate = DEFAULT_SAMPLE_RATE
  private lastLevel = 0
  private lastEmitMs = 0
  private writeErrored = false
  /** Serializes blob writes so chunks land in order, one at a time. */
  private drainChain: Promise<void> = Promise.resolve()

  // Mirrored UI state
  private lastStatus: RecorderStatus | null = null
  private playingId: string | null = null
  private recordings: RecordingItem[] = []
  private usage: Usage = EMPTY_USAGE

  constructor(private readonly session: MiniappSession) {}

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    this.ui = this.session.ui as unknown as {
      send: Send
      on: On
      onOpen: (cb: () => void) => () => void
    }

    this.registerUiHandlers()

    try {
      this.unsubs.push(
        this.session.speaker.onStateChange((e) => {
          if (e.state === "stopped" || e.state === "error") this.setPlaying(null)
        }),
      )
    } catch {
      /* speaker state not available — ignore */
    }

    try {
      this.unsubs.push(this.session.onBeforeDisconnect(() => this.onTeardown()))
    } catch {
      /* not available — ignore */
    }

    try {
      this.unsubs.push(
        this.session.onVisibilityChange((v) => {
          if (v === "foreground") this.renderHud()
        }),
      )
    } catch {
      /* not available — ignore */
    }

    await this.refreshList()
    this.renderHud()
    console.log(`Recorder: started (${this.recordings.length} recordings, hasMic=${this.session.mic.hasPermission})`)
  }

  private onTeardown(): void {
    // Best-effort: stop the mic feed and playback. An in-flight capture is left
    // for the host to clean up (it aborts the partial blob on app teardown).
    try {
      this.micUnsub?.()
    } catch {
      /* ignore */
    }
    try {
      this.session.speaker.stop()
    } catch {
      /* ignore */
    }
  }

  // ── UI bus ───────────────────────────────────────────────────────────────

  private registerUiHandlers(): void {
    this.unsubs.push(this.ui.onOpen(() => this.sendSnapshot()))
    this.unsubs.push(this.ui.on("rec:request-snapshot", () => this.sendSnapshot()))

    this.unsubs.push(this.ui.on("rec:start", () => void this.startRecording()))
    this.unsubs.push(this.ui.on("rec:stop", () => void this.stopRecording()))
    this.unsubs.push(this.ui.on("rec:cancel", () => void this.cancelRecording()))

    this.unsubs.push(this.ui.on("rec:play", ({id}) => void this.play(id)))
    this.unsubs.push(this.ui.on("rec:stop-play", () => this.stopPlay()))
    this.unsubs.push(this.ui.on("rec:export", ({id}) => void this.exportRecording(id)))
    this.unsubs.push(this.ui.on("rec:delete", ({id}) => void this.remove(id)))
    this.unsubs.push(this.ui.on("rec:clear", () => void this.clearAll()))
  }

  private sendSnapshot(): void {
    this.ui.send("rec:snapshot", {
      recording: this.lastStatus,
      recordings: this.recordings,
      usage: this.usage,
      playingId: this.playingId,
      hasMic: this.session.mic.hasPermission,
    })
  }

  // ── Recording (capture in the miniapp) ─────────────────────────────────────

  private async startRecording(): Promise<void> {
    if (this.recordingId) return
    try {
      const writer = await this.session.blob.create({mimeType: "audio/wav", name: makeName()})
      // Placeholder header — patched with real sizes on stop.
      await writer.write(new Uint8Array(WAV_HEADER_BYTES))

      this.writer = writer
      this.recordingId = writer.id
      this.chunks = []
      this.bufBytes = 0
      this.pcmBytes = 0
      this.sampleRate = DEFAULT_SAMPLE_RATE
      this.lastLevel = 0
      this.lastEmitMs = 0
      this.writeErrored = false
      this.drainChain = Promise.resolve()

      this.micUnsub = this.session.mic.onAudioChunk((d) => this.onChunk(d))
      this.unsubs.push(() => this.micUnsub?.())

      this.lastStatus = {recordingId: writer.id, ms: 0, bytes: WAV_HEADER_BYTES, level: 0}
      this.ui.send("rec:status", this.lastStatus)
      this.renderHud()
    } catch (err) {
      console.log("Recorder: start failed", err)
      await this.resetCapture(true)
      this.ui.send("rec:stopped", {})
    }
  }

  private onChunk(d: AudioChunkData): void {
    if (!this.recordingId || this.writeErrored) return
    if (d.sampleRate && d.sampleRate > 0) this.sampleRate = d.sampleRate
    const bytes = base64ToBytes(d.data || "")
    if (bytes.length === 0) return
    this.chunks.push(bytes)
    this.bufBytes += bytes.length
    this.lastLevel = pcmPeakLevel(bytes)
    this.maybeEmitProgress()
    if (this.bufBytes >= FLUSH_BYTES) this.scheduleDrain()
  }

  /** Queue a drain after any in-flight one — keeps writes ordered + single-flight. */
  private scheduleDrain(): void {
    this.drainChain = this.drainChain.then(() => this.drainOnce()).catch(() => {})
  }

  private async drainOnce(): Promise<void> {
    if (!this.writer || this.writeErrored) return
    while (this.chunks.length > 0) {
      const buf = this.takeBuffer()
      try {
        await this.writer.write(buf)
        this.pcmBytes += buf.length
      } catch (err) {
        console.log("Recorder: blob write failed; stopping append", err)
        this.writeErrored = true
        break
      }
    }
  }

  private takeBuffer(): Uint8Array {
    if (this.chunks.length === 1) {
      const only = this.chunks[0]
      this.chunks = []
      this.bufBytes = 0
      return only
    }
    const out = new Uint8Array(this.bufBytes)
    let at = 0
    for (const c of this.chunks) {
      out.set(c, at)
      at += c.length
    }
    this.chunks = []
    this.bufBytes = 0
    return out
  }

  private maybeEmitProgress(): void {
    const captured = this.pcmBytes + this.bufBytes
    const ms = pcmDurationMs(captured, this.sampleRate)
    if (ms - this.lastEmitMs < PROGRESS_MS) return
    this.lastEmitMs = ms
    this.lastStatus = {
      recordingId: this.recordingId!,
      ms,
      bytes: WAV_HEADER_BYTES + captured,
      level: this.lastLevel,
    }
    this.ui.send("rec:status", this.lastStatus)
    this.renderHud()
  }

  private async stopRecording(): Promise<void> {
    const writer = this.writer
    if (!this.recordingId || !writer) return
    // Stop the feed first so no more chunks arrive, then flush + finalize.
    try {
      this.micUnsub?.()
    } catch {
      /* ignore */
    }
    this.micUnsub = null
    this.recordingId = null
    this.lastStatus = null
    this.ui.send("rec:stopped", {})

    try {
      await this.drainChain // queued writes
      await this.drainOnce() // anything still buffered
      // Patch the real WAV header now that the size is known.
      await writer.writeAt(0, buildWavHeader(this.sampleRate, this.pcmBytes))
      await writer.commit({
        durationMs: pcmDurationMs(this.pcmBytes, this.sampleRate),
        sampleRate: this.sampleRate,
        channels: 1,
        bitsPerSample: 16,
      })
    } catch (err) {
      console.log("Recorder: finalize failed", err)
      try {
        await writer.abort()
      } catch {
        /* ignore */
      }
    }
    await this.resetCapture(false)
    await this.refreshList()
    this.renderHud()
  }

  private async cancelRecording(): Promise<void> {
    const writer = this.writer
    if (!this.recordingId || !writer) return
    try {
      this.micUnsub?.()
    } catch {
      /* ignore */
    }
    this.micUnsub = null
    this.recordingId = null
    this.lastStatus = null
    this.ui.send("rec:stopped", {})
    try {
      await this.drainChain
      await writer.abort()
    } catch {
      /* ignore */
    }
    await this.resetCapture(false)
    this.renderHud()
  }

  /** Drop capture state. When `abortWriter`, also abort the open blob writer. */
  private async resetCapture(abortWriter: boolean): Promise<void> {
    if (abortWriter && this.writer) {
      try {
        await this.writer.abort()
      } catch {
        /* ignore */
      }
    }
    this.writer = null
    this.recordingId = null
    this.micUnsub = null
    this.chunks = []
    this.bufBytes = 0
    this.pcmBytes = 0
    this.writeErrored = false
    this.lastStatus = null
  }

  // ── Library ──────────────────────────────────────────────────────────────

  private async refreshList(): Promise<void> {
    try {
      const [blobs, usage] = await Promise.all([this.session.blob.list(), this.session.blob.usage()])
      this.recordings = blobs.map(toItem)
      this.usage = usage
    } catch (err) {
      console.log("Recorder: list failed", err)
    }
    this.ui.send("rec:list", {recordings: this.recordings, usage: this.usage})
  }

  private async remove(id: string): Promise<void> {
    if (this.playingId === id) this.stopPlay()
    try {
      await this.session.blob.delete(id)
    } catch (err) {
      console.log("Recorder: delete failed", err)
    }
    await this.refreshList()
  }

  private async clearAll(): Promise<void> {
    this.stopPlay()
    try {
      await this.session.blob.clear()
    } catch (err) {
      console.log("Recorder: clear failed", err)
    }
    await this.refreshList()
  }

  // ── Playback ─────────────────────────────────────────────────────────────

  private async play(id: string): Promise<void> {
    let meta: BlobMeta | null = null
    try {
      meta = await this.session.blob.get(id)
    } catch {
      meta = null
    }
    if (!meta) return
    this.setPlaying(id)
    try {
      await this.session.speaker.play({audioUrl: meta.uri, stopOtherAudio: true})
    } catch (err) {
      console.log("Recorder: playback failed", err)
    } finally {
      if (this.playingId === id) this.setPlaying(null)
    }
  }

  private stopPlay(): void {
    try {
      this.session.speaker.stop()
    } catch {
      /* ignore */
    }
    this.setPlaying(null)
  }

  private setPlaying(id: string | null): void {
    if (this.playingId === id) return
    this.playingId = id
    this.ui.send("rec:playback", {playingId: id})
  }

  // ── Export ───────────────────────────────────────────────────────────────

  private async exportRecording(id: string): Promise<void> {
    try {
      await this.session.blob.export(id)
    } catch (err) {
      console.log("Recorder: export failed", err)
    }
  }

  // ── Glasses HUD ──────────────────────────────────────────────────────────

  private renderHud(): void {
    try {
      if (this.recordingId && this.lastStatus) {
        this.session.display.showTextWall(`● REC   ${fmtClock(this.lastStatus.ms)}`, {view: "main"})
      } else {
        this.session.display.showTextWall("Recorder ready", {view: "main"})
      }
    } catch {
      /* no display attached — fine */
    }
  }
}

function toItem(m: BlobMeta): RecordingItem {
  return {
    id: m.id,
    name: m.name ?? m.id,
    createdAt: m.createdAt,
    bytes: m.bytes,
    durationMs: Number(m.meta?.durationMs ?? 0),
    sampleRate: Number(m.meta?.sampleRate ?? 0),
    truncated: m.meta?.truncated === true,
  }
}

/** A filesystem-friendly default name, e.g. "recording-20260624-153012.wav". */
function makeName(): string {
  const d = new Date()
  const p = (n: number) => n.toString().padStart(2, "0")
  return `recording-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}.wav`
}

/** ms → m:ss. */
function fmtClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, "0")}`
}
