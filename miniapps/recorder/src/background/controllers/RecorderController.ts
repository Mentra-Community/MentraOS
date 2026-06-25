/**
 * RecorderController — always-on Recorder logic, living in the per-miniapp
 * JSContext (not the WebView), so a capture survives WebView open/close.
 *
 * Storage note: this build persists to `session.storage` (the key-value store
 * every host supports) rather than `session.blob` (newer, host >= 1.42.0). The
 * captured WAV is base64-encoded and split across small keys so no single value
 * is large:
 *   rec:index            -> JSON array of recording metadata (newest first)
 *   rec:a:<id>:<n>        -> base64 chunk n of the WAV bytes
 *
 * Capture: `session.mic.onAudioChunk` delivers base64 PCM16 frames; we buffer
 * them in memory, then on stop build the WAV (header + PCM), chunk it, and write
 * it out. Playback streams the reassembled bytes to the UI as a data: URL (the
 * UI plays it via <audio>); export uses `session.system.share`.
 */

import {base64ToBytes, bytesToBase64} from "@mentra/miniapp/background"
import type {AudioChunkData, MiniappSession, UnsubscribeFn} from "@mentra/miniapp/background"

import type {Channels} from "../../shared/channels"
import type {RecorderStatus, RecordingItem, Usage} from "../../shared/types"
import {buildWavHeader, pcmDurationMs, pcmPeakLevel, WAV_HEADER_BYTES} from "../wav"

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void
type On = <C extends keyof Channels & string>(channel: C, cb: (payload: Channels[C]) => void) => () => void

const INDEX_KEY = "rec:index"
const chunkKey = (id: string, n: number) => `rec:a:${id}:${n}`

const DEFAULT_SAMPLE_RATE = 16000
/** Cap a single capture's PCM so memory + storage stay bounded (~4 min @ 16kHz mono). */
const MAX_PCM_BYTES = 8 * 1024 * 1024
/**
 * Raw WAV bytes per stored chunk. base64 inflates this ~4/3, and the host's
 * key-value store silently drops values past a few hundred KB — so keep each
 * stored value small (96 KB → ~128 KB base64) to stay safely under that ceiling.
 * (A 512 KB chunk became ~683 KB base64 and was dropped, making multi-chunk
 * recordings unreadable.)
 */
const STORE_CHUNK_BYTES = 96 * 1024
const QUOTA_BYTES = 64 * 1024 * 1024
/** Throttle UI status pushes to ~5/sec, keyed off captured audio ms. */
const PROGRESS_MS = 200

/** Index entry — RecordingItem plus how many storage chunks hold its audio. */
interface StoredRec extends RecordingItem {
  chunks: number
}

const EMPTY_USAGE: Usage = {bytes: 0, count: 0, quotaBytes: QUOTA_BYTES}

export class RecorderController {
  private started = false
  private readonly unsubs: Array<() => void> = []
  private ui!: {send: Send; on: On; onOpen: (cb: () => void) => () => void}

  // Capture state
  private recordingId: string | null = null
  private micUnsub: UnsubscribeFn | null = null
  private transcriptUnsub: UnsubscribeFn | null = null
  private pcm: Uint8Array[] = []
  private pcmBytes = 0
  private sampleRate = DEFAULT_SAMPLE_RATE
  private lastLevel = 0
  private lastEmitMs = 0
  private truncated = false
  private paused = false
  private finalTranscript = ""
  private interimTranscript = ""
  private lang = ""
  private startedAt = 0
  private finalizing = false

  // Mirrored UI state
  private lastStatus: RecorderStatus | null = null
  private playingId: string | null = null
  private index: StoredRec[] = []
  private usage: Usage = EMPTY_USAGE

  constructor(private readonly session: MiniappSession) {}

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    this.ui = this.session.ui as unknown as {send: Send; on: On; onOpen: (cb: () => void) => () => void}
    this.registerUiHandlers()

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

    await this.loadIndex()
    this.renderHud()
    console.log(`Recorder: started (${this.index.length} recordings, hasMic=${this.session.mic.hasPermission})`)
  }

  private onTeardown(): void {
    try {
      this.micUnsub?.()
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
    this.unsubs.push(this.ui.on("rec:pause", () => this.pauseRecording()))
    this.unsubs.push(this.ui.on("rec:resume", () => this.resumeRecording()))

    this.unsubs.push(this.ui.on("rec:play", ({id}) => void this.play(id)))
    this.unsubs.push(this.ui.on("rec:stop-play", () => this.setPlaying(null)))
    this.unsubs.push(this.ui.on("rec:export", ({id}) => void this.exportRecording(id)))
    this.unsubs.push(this.ui.on("rec:export-transcript", ({id}) => void this.exportTranscript(id)))
    this.unsubs.push(this.ui.on("rec:delete", ({id}) => void this.remove(id)))
    this.unsubs.push(this.ui.on("rec:clear", () => void this.clearAll()))
  }

  private sendSnapshot(): void {
    this.ui.send("rec:snapshot", {
      recording: this.lastStatus,
      recordings: this.toItems(),
      usage: this.usage,
      playingId: this.playingId,
      hasMic: this.session.mic.hasPermission,
    })
  }

  private sendList(): void {
    this.ui.send("rec:list", {recordings: this.toItems(), usage: this.usage})
  }

  // ── Recording ──────────────────────────────────────────────────────────────

  private async startRecording(): Promise<void> {
    if (this.recordingId || this.finalizing) return

    this.recordingId = makeKey()
    this.pcm = []
    this.pcmBytes = 0
    this.sampleRate = DEFAULT_SAMPLE_RATE
    this.lastLevel = 0
    this.lastEmitMs = 0
    this.truncated = false
    this.paused = false
    this.finalTranscript = ""
    this.interimTranscript = ""
    this.lang = ""
    this.startedAt = Date.now()

    this.micUnsub = this.session.mic.onAudioChunk((d) => this.onChunk(d))
    // Live transcription (cloud-side; the host routes audio to Soniox).
    try {
      this.transcriptUnsub = this.session.transcription.on((d) => this.onTranscript(d))
    } catch {
      this.transcriptUnsub = null
    }

    this.lastStatus = {recordingId: this.recordingId, ms: 0, bytes: WAV_HEADER_BYTES, level: 0, paused: false}
    this.ui.send("rec:status", this.lastStatus)
    this.renderHud()
  }

  private pauseRecording(): void {
    if (!this.recordingId || this.paused) return
    try {
      this.micUnsub?.()
    } catch {
      /* ignore */
    }
    this.micUnsub = null
    this.paused = true
    this.lastLevel = 0
    this.emitStatus()
  }

  private resumeRecording(): void {
    if (!this.recordingId || !this.paused) return
    this.paused = false
    this.micUnsub = this.session.mic.onAudioChunk((d) => this.onChunk(d))
    this.emitStatus()
  }

  private emitStatus(): void {
    if (!this.recordingId) return
    this.lastStatus = {
      recordingId: this.recordingId,
      ms: pcmDurationMs(this.pcmBytes, this.sampleRate),
      bytes: WAV_HEADER_BYTES + this.pcmBytes,
      level: this.paused ? 0 : this.lastLevel,
      paused: this.paused,
    }
    this.ui.send("rec:status", this.lastStatus)
    this.renderHud()
  }

  private onChunk(d: AudioChunkData): void {
    if (!this.recordingId || this.truncated) return
    if (d.sampleRate && d.sampleRate > 0) this.sampleRate = d.sampleRate
    const bytes = base64ToBytes(d.data || "")
    if (bytes.length === 0) return

    if (this.pcmBytes + bytes.length > MAX_PCM_BYTES) {
      // Hit the cap — keep what we have, stop appending, finalize on next stop.
      this.truncated = true
      return
    }
    this.pcm.push(bytes)
    this.pcmBytes += bytes.length
    this.lastLevel = pcmPeakLevel(bytes)
    this.maybeEmitProgress()
  }

  private maybeEmitProgress(): void {
    const ms = pcmDurationMs(this.pcmBytes, this.sampleRate)
    if (ms - this.lastEmitMs < PROGRESS_MS) return
    this.lastEmitMs = ms
    this.lastStatus = {
      recordingId: this.recordingId!,
      ms,
      bytes: WAV_HEADER_BYTES + this.pcmBytes,
      level: this.lastLevel,
      paused: false,
    }
    this.ui.send("rec:status", this.lastStatus)
    this.renderHud()
  }

  private onTranscript(d: {text: string; isFinal: boolean; language?: string}): void {
    if (!this.recordingId) return
    if (d.language) this.lang = d.language
    if (d.isFinal) {
      const t = d.text.trim()
      if (t) this.finalTranscript = this.finalTranscript ? `${this.finalTranscript} ${t}` : t
      this.interimTranscript = ""
    } else {
      this.interimTranscript = d.text
    }
    this.ui.send("rec:transcript", {final: this.finalTranscript, interim: this.interimTranscript, lang: this.lang || undefined})
  }

  private async stopRecording(): Promise<void> {
    const id = this.recordingId
    if (!id) return
    this.finalizing = true
    try {
      try {
        this.micUnsub?.()
      } catch {
        /* ignore */
      }
      this.micUnsub = null
      try {
        this.transcriptUnsub?.()
      } catch {
        /* ignore */
      }
      this.transcriptUnsub = null
      this.recordingId = null
      this.lastStatus = null
      this.ui.send("rec:stopped", {})

      const sampleRate = this.sampleRate
      const pcmBytes = this.pcmBytes
      const pcm = this.pcm
      const truncated = this.truncated
      const transcript = `${this.finalTranscript} ${this.interimTranscript}`.trim()
      this.pcm = []
      this.pcmBytes = 0

      if (pcmBytes > 0) {
        await this.persist(id, sampleRate, pcm, pcmBytes, truncated, transcript)
        await this.loadIndex()
      }
      this.sendList()
      this.renderHud()
    } catch (err) {
      console.log("Recorder: stop/persist failed", err)
    } finally {
      this.finalizing = false
    }
  }

  private async cancelRecording(): Promise<void> {
    if (!this.recordingId) return
    try {
      this.micUnsub?.()
    } catch {
      /* ignore */
    }
    this.micUnsub = null
    try {
      this.transcriptUnsub?.()
    } catch {
      /* ignore */
    }
    this.transcriptUnsub = null
    this.recordingId = null
    this.lastStatus = null
    this.pcm = []
    this.pcmBytes = 0
    this.ui.send("rec:stopped", {})
    this.renderHud()
  }

  /** Assemble the WAV, split it into base64 chunks, and write everything out. */
  private async persist(
    id: string,
    sampleRate: number,
    pcm: Uint8Array[],
    pcmBytes: number,
    truncated: boolean,
    transcript: string,
  ): Promise<void> {
    const wav = new Uint8Array(WAV_HEADER_BYTES + pcmBytes)
    wav.set(buildWavHeader(sampleRate, pcmBytes), 0)
    let at = WAV_HEADER_BYTES
    for (const c of pcm) {
      wav.set(c, at)
      at += c.length
    }

    let n = 0
    for (let off = 0; off < wav.length; off += STORE_CHUNK_BYTES) {
      const slice = wav.subarray(off, Math.min(off + STORE_CHUNK_BYTES, wav.length))
      await this.session.storage.set(chunkKey(id, n), bytesToBase64(slice))
      n++
    }

    const item: StoredRec = {
      id,
      name: titleFromTranscript(transcript, this.startedAt),
      createdAt: this.startedAt || Date.now(),
      bytes: wav.length,
      durationMs: pcmDurationMs(pcmBytes, sampleRate),
      sampleRate,
      truncated,
      transcript: transcript || undefined,
      chunks: n,
    }
    const list = await this.readIndex()
    await this.writeIndex([item, ...list])
  }

  // ── Library / index ─────────────────────────────────────────────────────────

  private async readIndex(): Promise<StoredRec[]> {
    try {
      const raw = await this.session.storage.get(INDEX_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw) as StoredRec[]
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  private async writeIndex(list: StoredRec[]): Promise<void> {
    await this.session.storage.set(INDEX_KEY, JSON.stringify(list))
  }

  private async loadIndex(): Promise<void> {
    this.index = await this.readIndex()
    const bytes = this.index.reduce((s, r) => s + r.bytes, 0)
    this.usage = {bytes, count: this.index.length, quotaBytes: QUOTA_BYTES}
  }

  private toItems(): RecordingItem[] {
    return this.index.map(({chunks: _chunks, ...item}) => item)
  }

  private async readAudioBase64(rec: StoredRec): Promise<string | null> {
    const parts: string[] = []
    for (let n = 0; n < rec.chunks; n++) {
      // Some hosts hang on get() for keys whose oversized value was silently
      // dropped; cap the wait so a missing chunk resolves to "unavailable".
      const part = await withTimeout(this.session.storage.get(chunkKey(rec.id, n)), 1500)
      if (part == null) return null
      parts.push(part)
    }
    // Each chunk is whole-byte aligned (STORE_CHUNK_BYTES is a multiple of 3 isn't
    // required since we re-decode per chunk on the wire as one joined string only
    // when the byte boundaries align). We join the raw bytes instead to be safe.
    return joinBase64ByBytes(parts)
  }

  private async remove(id: string): Promise<void> {
    if (this.playingId === id) this.setPlaying(null)
    const rec = this.index.find((r) => r.id === id)
    if (rec) {
      for (let n = 0; n < rec.chunks; n++) {
        try {
          await this.session.storage.delete(chunkKey(id, n))
        } catch {
          /* ignore */
        }
      }
    }
    await this.writeIndex((await this.readIndex()).filter((r) => r.id !== id))
    await this.loadIndex()
    this.sendList()
  }

  private async clearAll(): Promise<void> {
    if (this.recordingId) await this.cancelRecording()
    this.setPlaying(null)
    try {
      await this.session.storage.clear()
    } catch (err) {
      console.log("Recorder: clear failed", err)
    }
    this.index = []
    this.usage = {...EMPTY_USAGE}
    this.sendList()
  }

  // ── Playback (UI-side via data: URL) ────────────────────────────────────────

  private async play(id: string): Promise<void> {
    const rec = this.index.find((r) => r.id === id)
    if (!rec) return
    const b64 = await this.readAudioBase64(rec)
    if (!b64) {
      // Stored audio is unreadable (legacy oversized chunks, etc.) — tell the UI
      // so it can surface it instead of a silent dead tap.
      this.ui.send("rec:audio-missing", {id})
      return
    }
    this.setPlaying(id)
    this.ui.send("rec:audio", {id, dataUrl: `data:audio/wav;base64,${b64}`})
  }

  private setPlaying(id: string | null): void {
    if (this.playingId === id) return
    this.playingId = id
    this.ui.send("rec:playback", {playingId: id})
  }

  // ── Export ───────────────────────────────────────────────────────────────

  private async exportRecording(id: string): Promise<void> {
    const rec = this.index.find((r) => r.id === id)
    if (!rec) return
    const b64 = await this.readAudioBase64(rec)
    if (!b64) return
    try {
      await this.session.system.share({base64: b64, mimeType: "audio/wav", filename: `${safeFilename(rec.name)}.wav`})
    } catch (err) {
      console.log("Recorder: export failed", err)
    }
  }

  private async exportTranscript(id: string): Promise<void> {
    const rec = this.index.find((r) => r.id === id)
    if (!rec?.transcript?.trim()) return
    try {
      await this.session.system.share({text: `${rec.name}\n${fmtClock(rec.durationMs)} · ${new Date(rec.createdAt).toLocaleString()}\n\n${rec.transcript}`})
    } catch (err) {
      console.log("Recorder: export transcript failed", err)
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

/** Resolve to `null` if a promise doesn't settle within `ms` (guards hung get()). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false
    const t = setTimeout(() => {
      if (!done) {
        done = true
        resolve(null)
      }
    }, ms)
    p.then(
      (v) => {
        if (!done) {
          done = true
          clearTimeout(t)
          resolve(v)
        }
      },
      () => {
        if (!done) {
          done = true
          clearTimeout(t)
          resolve(null)
        }
      },
    )
  })
}

/** Concatenate base64 strings by decoding to bytes and re-encoding once. */
function joinBase64ByBytes(parts: string[]): string {
  if (parts.length === 1) return parts[0]
  const buffers = parts.map((p) => base64ToBytes(p))
  const total = buffers.reduce((s, b) => s + b.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const b of buffers) {
    out.set(b, at)
    at += b.length
  }
  return bytesToBase64(out)
}

function makeKey(): string {
  return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** A display title from the transcript's opening words, or a dated fallback. */
function titleFromTranscript(transcript: string, startedAt: number): string {
  const t = transcript.trim()
  if (t) {
    const words = t.split(/\s+/).slice(0, 6).join(" ")
    const title = words.charAt(0).toUpperCase() + words.slice(1)
    return title.length > 48 ? `${title.slice(0, 47)}…` : title
  }
  const d = new Date(startedAt || Date.now())
  const date = d.toLocaleDateString(undefined, {month: "short", day: "numeric"})
  const time = d.toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"})
  return `Recording · ${date} ${time}`
}

/** Filesystem-safe base name for the exported WAV. */
function safeFilename(name: string): string {
  const base =
    name
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "recording"
  return base.slice(0, 48)
}

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, "0")}`
}
