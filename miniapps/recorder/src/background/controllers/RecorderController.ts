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
 *     `session.blob.share` (OS share sheet).
 *
 * Alongside the audio, a live Soniox transcript is captured via
 * `session.transcription` while recording (pushed to the UI in real time and
 * persisted into the blob's metadata on stop). Pause suspends both the mic feed
 * and transcription so the saved audio and transcript stay aligned.
 *
 * The captured PCM is what the audio system produces AFTER LC3 decode (the same
 * stream that feeds transcription) — i.e. a debugging view of "what audio did we
 * actually get".
 */

import {base64ToBytes, bytesToBase64} from "@mentra/miniapp/background"
import type {AudioChunkData, BlobMeta, BlobWriter, MiniappSession, UnsubscribeFn} from "@mentra/miniapp/background"

import type {Channels} from "../../shared/channels"
import type {RecorderStatus, RecordingItem, Usage} from "../../shared/types"
import {buildInfoChunk, buildWavHeader, pcmDurationMs, pcmPeakLevel, WAV_HEADER_BYTES} from "../wav"

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void
type On = <C extends keyof Channels & string>(channel: C, cb: (payload: Channels[C]) => void) => () => void

const EMPTY_USAGE: Usage = {bytes: 0, count: 0, quotaBytes: 0}
const DEFAULT_SAMPLE_RATE = 16000
/** WAV IART (artist) tag — the source, so players don't show "Unknown Artist". */
const WAV_ARTIST = "Mentra"
/** WAV ISFT (software) tag. */
const WAV_SOFTWARE = "Mentra Recorder"
/** Flush the PCM buffer to the blob once it reaches ~1.5s of 16kHz mono audio. */
const FLUSH_BYTES = 48 * 1024
/** Throttle UI status pushes to ~5/sec (keyed off captured audio ms, not a timer). */
const PROGRESS_MS = 200
/**
 * Keep accepting PCM briefly after the user taps stop. Glasses audio crosses
 * BLE and two JS/native bridges, so the newest frames can still be in flight
 * when the UI command reaches this controller. Unsubscribing immediately drops
 * that tail even though it was spoken before the tap.
 */
const STOP_TAIL_DRAIN_MS = 1500

export class RecorderController {
  private started = false
  private readonly unsubs: Array<() => void> = []

  private ui!: {send: Send; on: On; onOpen: (cb: () => void) => () => void}

  // Capture state
  private recordingId: string | null = null
  private writer: BlobWriter | null = null
  private micUnsub: UnsubscribeFn | null = null
  private transcriptUnsub: UnsubscribeFn | null = null
  private chunks: Uint8Array[] = []
  private bufBytes = 0
  private pcmBytes = 0
  private sampleRate = DEFAULT_SAMPLE_RATE
  private lastLevel = 0
  private lastEmitMs = 0
  private writeErrored = false
  /** Epoch ms the current capture began — stable across pause + WebView reopen. */
  private captureStartedAt = 0
  /** Human-friendly display title for the current capture (also stored in meta.title). */
  private captureTitle = ""
  /** True while the capture is paused (mic + transcription feed suspended). */
  private paused = false
  /** Committed transcript text (final results), accumulated across the capture. */
  private finalTranscript = ""
  /** In-progress transcript tail (interim result), replaced as it firms up. */
  private interimTranscript = ""
  /** Detected/active transcription language tag (e.g. "en-US"). */
  private lang = ""
  /** Shared start promise so duplicate UI/action starts create one writer. */
  private startPromise: Promise<void> | null = null
  /** True while a stop/cancel is finalizing the blob — blocks a new start from racing its state. */
  private finalizing = false
  /** Shared stop promise so duplicate UI/action stops await one finalization. */
  private stopPromise: Promise<void> | null = null
  /** Capture being finalized after recordingId is cleared, for concurrent action responses. */
  private finalizingRecordingId: string | null = null
  /** Serializes blob writes so chunks land in order, one at a time. */
  private drainChain: Promise<void> = Promise.resolve()

  // Mirrored UI state
  private lastStatus: RecorderStatus | null = null
  private playingId: string | null = null
  /** Monotonic playback token — only the latest play() owns the UI playing state. */
  private playSeq = 0
  private recordings: RecordingItem[] = []
  private usage: Usage = EMPTY_USAGE

  constructor(
    private readonly session: MiniappSession,
    private readonly stopTailDrainMs = STOP_TAIL_DRAIN_MS,
  ) {}

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
    this.registerActions()

    // Playback UI state is driven entirely by play()'s own request lifecycle
    // (see play()), NOT by speaker.onStateChange. The speaker state is global to
    // the miniapp with no per-clip correlation, so a "stopped" from interrupting
    // the previous clip (which is exactly what starting the next clip does, via
    // stopOtherAudio) would clobber the new clip's "playing" state — the UI would
    // flicker pause→play and the row would look stuck. play()'s promise resolves
    // per-request, so it's the authoritative signal for which row is playing.

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
    // Best-effort: stop the mic feed, transcription, and playback. An in-flight
    // capture is left for the host to clean up (it aborts the partial blob on
    // app teardown).
    try {
      this.micUnsub?.()
    } catch {
      /* ignore */
    }
    this.unsubscribeTranscription()
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
    this.unsubs.push(this.ui.on("rec:pause", () => this.pauseRecording()))
    this.unsubs.push(this.ui.on("rec:resume", () => this.resumeRecording()))

    this.unsubs.push(this.ui.on("rec:play", ({id}) => void this.play(id)))
    this.unsubs.push(this.ui.on("rec:stop-play", () => this.stopPlay()))
    this.unsubs.push(this.ui.on("rec:export", ({id}) => void this.exportRecording(id)))
    this.unsubs.push(this.ui.on("rec:export-transcript", ({id}) => void this.exportTranscript(id)))
    this.unsubs.push(this.ui.on("rec:delete", ({id}) => void this.remove(id)))
    this.unsubs.push(this.ui.on("rec:clear", () => void this.clearAll()))
  }

  private registerActions(): void {
    try {
      this.unsubs.push(this.session.actions.handle("start_recording", () => this.startRecordingAction()))
      this.unsubs.push(this.session.actions.handle("stop_recording", () => this.stopRecordingAction()))
    } catch (err) {
      console.log("Recorder: failed to register actions", err)
    }
  }

  private sendSnapshot(): void {
    this.ui.send("rec:snapshot", {
      recording: this.lastStatus,
      stopping: this.finalizing,
      recordings: this.recordings,
      usage: this.usage,
      playingId: this.playingId,
      hasMic: this.session.mic.hasPermission,
      // Restore the in-progress transcript so a WebView reopened mid-capture
      // shows what's been transcribed so far (not just text from new speech).
      transcript: this.recordingId ? [this.finalTranscript, this.interimTranscript].filter(Boolean).join(" ") : "",
      transcriptLang: this.recordingId ? this.lang : "",
    })
  }

  // ── Recording (capture in the miniapp) ─────────────────────────────────────

  private async startRecordingAction(): Promise<{
    status: "recording"
    recordingId: string
    startedAt: number
    paused: boolean
  }> {
    if (!this.session.mic.hasPermission) {
      throw new Error("Microphone permission is required to start a recording")
    }
    if (this.finalizing) {
      throw new Error("The previous recording is still being saved")
    }

    await this.startRecording()
    if (!this.recordingId || !this.lastStatus) {
      throw new Error("Failed to start recording")
    }
    return {
      status: "recording",
      recordingId: this.recordingId,
      startedAt: this.lastStatus.startedAt,
      paused: this.lastStatus.paused === true,
    }
  }

  private async stopRecordingAction(): Promise<{
    status: "stopped" | "idle"
    recording: RecordingItem | null
  }> {
    const recordingId = this.recordingId ?? this.finalizingRecordingId
    if (!recordingId) return {status: "idle", recording: null}

    await this.stopRecording()
    return {
      status: "stopped",
      recording: this.recordings.find((recording) => recording.id === recordingId) ?? null,
    }
  }

  private startRecording(): Promise<void> {
    if (this.startPromise) return this.startPromise
    if (this.recordingId || this.finalizing) return Promise.resolve()

    const start = this.beginRecording()
    this.startPromise = start.finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async beginRecording(): Promise<void> {
    // Recording and playback are mutually exclusive. Stop synchronously before
    // opening the writer so no old clip keeps playing over the new capture.
    this.stopPlay()
    try {
      // One timestamp drives the filename, the display title, and the WAV's
      // ICRD date tag so they all agree.
      const startedAt = new Date()
      const fileName = makeName(startedAt)
      const title = makeTitle(startedAt)
      const writer = await this.session.blob.createWriteStream(makeKey(), {
        mimeType: "audio/wav",
        name: fileName,
        meta: {title},
      })
      // Placeholder header — patched with real sizes on stop.
      await writer.write(new Uint8Array(WAV_HEADER_BYTES))

      this.writer = writer
      this.recordingId = writer.key
      this.chunks = []
      this.bufBytes = 0
      this.pcmBytes = 0
      this.sampleRate = DEFAULT_SAMPLE_RATE
      this.lastLevel = 0
      this.lastEmitMs = 0
      this.writeErrored = false
      this.captureStartedAt = startedAt.getTime()
      this.captureTitle = title
      this.paused = false
      this.finalTranscript = ""
      this.interimTranscript = ""
      this.lang = ""
      this.drainChain = Promise.resolve()

      this.micUnsub = this.session.mic.onAudioChunk((d) => this.onChunk(d))
      this.unsubs.push(() => this.micUnsub?.())
      this.subscribeTranscription()

      this.lastStatus = {
        recordingId: writer.key,
        startedAt: this.captureStartedAt,
        ms: 0,
        bytes: WAV_HEADER_BYTES,
        level: 0,
        paused: false,
      }
      this.ui.send("rec:status", this.lastStatus)
      this.renderHud()
    } catch (err) {
      console.log("Recorder: start failed", err)
      await this.resetCapture(true)
      this.ui.send("rec:stopped", {})
    }
  }

  private onChunk(d: AudioChunkData): void {
    // `paused` is authoritative: a frame already in flight on the bridge can
    // still land here after pauseRecording() tore down the subscription, so
    // drop it here too — otherwise it would extend the WAV and flip the UI out
    // of the paused state via maybeEmitProgress.
    if (!this.recordingId || this.writeErrored || this.paused) return
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
      startedAt: this.captureStartedAt,
      ms,
      bytes: WAV_HEADER_BYTES + captured,
      level: this.lastLevel,
      paused: false,
    }
    this.ui.send("rec:status", this.lastStatus)
    this.renderHud()
  }

  // ── Pause / resume ─────────────────────────────────────────────────────────

  /** Suspend the mic + transcription feeds; the partial blob stays open. */
  private pauseRecording(): void {
    if (!this.recordingId || this.paused) return
    // Set paused first so any mic/transcription event that fires during the
    // teardown window below is dropped (onChunk + onTranscript both bail on
    // paused) — no audio-less words or trailing PCM after the pause edge.
    this.paused = true
    try {
      this.micUnsub?.()
    } catch {
      /* ignore */
    }
    this.micUnsub = null
    // Tearing down transcription means the pending interim words will never be
    // finalized — commit them now so they survive into the saved transcript.
    this.commitInterim()
    this.unsubscribeTranscription()
    this.lastLevel = 0
    this.emitStatus()
  }

  /** Fold the in-progress interim transcript into the committed text. */
  private commitInterim(): void {
    const t = this.interimTranscript.trim()
    if (!t) return
    this.finalTranscript = this.finalTranscript ? `${this.finalTranscript} ${t}` : t
    this.interimTranscript = ""
  }

  /** Re-arm the mic + transcription feeds and continue appending. */
  private resumeRecording(): void {
    if (!this.recordingId || !this.paused) return
    this.paused = false
    this.micUnsub = this.session.mic.onAudioChunk((d) => this.onChunk(d))
    this.subscribeTranscription()
    this.emitStatus()
  }

  /** Push the current capture state to the UI (used on pause/resume edges). */
  private emitStatus(): void {
    if (!this.recordingId) return
    const captured = this.pcmBytes + this.bufBytes
    this.lastStatus = {
      recordingId: this.recordingId,
      startedAt: this.captureStartedAt,
      ms: pcmDurationMs(captured, this.sampleRate),
      bytes: WAV_HEADER_BYTES + captured,
      level: this.paused ? 0 : this.lastLevel,
      paused: this.paused,
    }
    this.ui.send("rec:status", this.lastStatus)
    this.renderHud()
  }

  // ── Live transcription ──────────────────────────────────────────────────────

  private subscribeTranscription(): void {
    try {
      this.transcriptUnsub = this.session.transcription.on((d) => this.onTranscript(d))
    } catch {
      // Transcription unavailable on this host — capture audio only.
      this.transcriptUnsub = null
    }
  }

  private unsubscribeTranscription(): void {
    try {
      this.transcriptUnsub?.()
    } catch {
      /* ignore */
    }
    this.transcriptUnsub = null
  }

  private onTranscript(d: {text: string; isFinal: boolean; language?: string}): void {
    // Drop events that land during/after pause (mirrors onChunk) so the
    // transcript can't gain words with no matching recorded audio.
    if (!this.recordingId || this.paused) return
    if (d.language) this.lang = d.language
    if (d.isFinal) {
      const t = d.text.trim()
      if (t) this.finalTranscript = this.finalTranscript ? `${this.finalTranscript} ${t}` : t
      this.interimTranscript = ""
    } else {
      this.interimTranscript = d.text
    }
    this.ui.send("rec:transcript", {
      final: this.finalTranscript,
      interim: this.interimTranscript,
      lang: this.lang || undefined,
    })
  }

  private stopRecording(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    if (!this.recordingId || !this.writer) return Promise.resolve()

    this.finalizingRecordingId = this.recordingId
    // Acknowledge the tap before the tail-drain/save work begins so the UI can
    // stop animating immediately without sacrificing in-flight audio frames.
    this.ui.send("rec:stopping", {})
    const stop = this.finalizeRecording()
    this.stopPromise = stop.finally(() => {
      this.stopPromise = null
      this.finalizingRecordingId = null
    })
    return this.stopPromise
  }

  private async finalizeRecording(): Promise<void> {
    const writer = this.writer
    if (!this.recordingId || !writer) return
    // `finalizing` blocks a new start from racing this recording's capture state
    // (pcmBytes/sampleRate/buffers) while we flush + write the header.
    this.finalizing = true
    try {
      // Audio spoken just before the tap may still be crossing BLE/native
      // bridges. Keep the subscriptions alive for a short tail-drain window so
      // those frames land before we freeze and finalize the WAV.
      await delay(this.stopTailDrainMs)
      try {
        this.micUnsub?.()
      } catch {
        /* ignore */
      }
      this.micUnsub = null
      this.unsubscribeTranscription()
      const transcript = `${this.finalTranscript} ${this.interimTranscript}`.trim()
      // Snapshot title/date before resetCapture() clears them below.
      const title = this.captureTitle
      const startedAt = this.captureStartedAt
      this.recordingId = null
      this.lastStatus = null
      this.ui.send("rec:stopped", {})

      try {
        await this.drainChain // queued writes
        await this.drainOnce() // anything still buffered
        // Tag the file so players show a real title/artist instead of
        // "Unknown Artist". This LIST/INFO chunk goes AFTER the data chunk —
        // a normal append (writeAt(0) can't grow the blob, only patch the
        // header in place) — so we size the RIFF header to include it.
        const info = buildInfoChunk({
          title: title || undefined,
          artist: WAV_ARTIST,
          software: WAV_SOFTWARE,
          date: startedAt ? new Date(startedAt).toISOString().slice(0, 10) : undefined,
          comment: transcript ? transcript.slice(0, 256) : undefined,
        })
        if (info.length > 0) await writer.write(info)
        // Patch the real WAV header now that the sizes are known (data size is
        // pcmBytes; RIFF size also covers the appended INFO trailer).
        await writer.writeAt(0, buildWavHeader(this.sampleRate, this.pcmBytes, 1, 16, info.length))
        const meta: Record<string, string | number | boolean> = {
          durationMs: pcmDurationMs(this.pcmBytes, this.sampleRate),
          sampleRate: this.sampleRate,
          channels: 1,
          bitsPerSample: 16,
        }
        if (title) meta.title = title
        // A failed append means we ran into the storage quota — flag it so the
        // UI can show a "capped" badge.
        if (this.writeErrored) meta.truncated = true
        if (transcript) meta.transcript = transcript
        await writer.close(meta)
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
    } finally {
      this.finalizing = false
    }
  }

  private async cancelRecording(): Promise<void> {
    const writer = this.writer
    if (!this.recordingId || !writer) return
    this.finalizing = true
    try {
      try {
        this.micUnsub?.()
      } catch {
        /* ignore */
      }
      this.micUnsub = null
      this.unsubscribeTranscription()
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
    } finally {
      this.finalizing = false
    }
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
    // Tear down any still-live feeds before dropping their handles. The
    // stop/cancel paths already unsubscribed; the start-failure path has not, so
    // do it here too — otherwise a handler could fire after the capture is gone.
    try {
      this.micUnsub?.()
    } catch {
      /* ignore */
    }
    this.unsubscribeTranscription()
    this.writer = null
    this.recordingId = null
    this.micUnsub = null
    this.chunks = []
    this.bufBytes = 0
    this.pcmBytes = 0
    this.writeErrored = false
    this.captureStartedAt = 0
    this.captureTitle = ""
    this.paused = false
    this.finalTranscript = ""
    this.interimTranscript = ""
    this.lang = ""
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
    // Stop an active capture first — clear() deletes the blob dir, so a writer
    // left open would keep writing to a now-deleted .part file.
    if (this.recordingId) await this.cancelRecording()
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
    if (!meta) {
      // Stored audio is gone/unreadable — tell the UI instead of a dead tap.
      this.ui.send("rec:audio-missing", {id})
      return
    }
    const seq = ++this.playSeq
    this.setPlaying(id)
    try {
      await this.session.speaker.play({audioUrl: meta.uri, stopOtherAudio: true})
    } catch (err) {
      console.log("Recorder: playback failed", err)
    } finally {
      // Switching to another recording interrupts this one on the host, which
      // resolves THIS promise — but the UI should now reflect the new playback,
      // so only fall back to idle when no newer play() has superseded us.
      if (this.playSeq === seq) this.setPlaying(null)
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
      const result = await this.session.blob.share(id)
      if (!result.success && !result.cancelled) this.ui.send("rec:share-failed", {id})
    } catch (err) {
      console.log("Recorder: export failed", err)
      this.ui.send("rec:share-failed", {id})
    }
  }

  /**
   * Share a recording's transcript via the OS share sheet — as an explicit
   * `.txt` FILE, not a bare message string.
   *
   * Sharing it as a base64 text/plain file (vs `system.share({text})`) makes the
   * transcript the unambiguous share item. A plain-string share lets iOS surface
   * "recent"/suggested items in the sheet — including a recently-shared .wav from
   * this same recording — which reads as "Share transcript shared the audio".
   * An explicit text file can never be confused with the audio.
   */
  private async exportTranscript(id: string): Promise<void> {
    let meta: BlobMeta | null = null
    try {
      meta = await this.session.blob.get(id)
    } catch {
      meta = null
    }
    const transcript = typeof meta?.meta?.transcript === "string" ? meta.meta.transcript : ""
    if (!transcript.trim()) return
    const title = typeof meta?.meta?.title === "string" ? meta.meta.title : (meta?.name ?? id)
    const durationMs = Number(meta?.meta?.durationMs ?? 0)
    const createdAt = meta?.createdAt ?? Date.now()
    const body = `${title}\n${fmtClock(durationMs)} · ${new Date(createdAt).toLocaleString()}\n\n${transcript}\n`
    try {
      await this.session.system.share({
        base64: bytesToBase64(utf8Bytes(body)),
        mimeType: "text/plain",
        filename: `${sanitizeFileName(title)}.txt`,
        title,
      })
    } catch (err) {
      console.log("Recorder: export transcript failed", err)
    }
  }

  // ── Glasses HUD ──────────────────────────────────────────────────────────

  private renderHud(): void {
    const text =
      this.recordingId && this.lastStatus
        ? `${this.lastStatus.paused ? "❚❚ PAUSED" : "● REC"}   ${fmtClock(this.lastStatus.ms)}`
        : "Recorder ready"
    // Full-canvas text element with a stable id — the ticking clock updates in
    // place on the glasses. render() never throws; on a displayless device it
    // just resolves {status: "blocked"}.
    const d = this.session.capabilities?.display
    void this.session.display.render([
      {type: "text", id: "hud", box: {x: 0, y: 0, w: d?.width ?? 576, h: d?.height ?? 288}, text},
    ])
  }
}

function toItem(m: BlobMeta): RecordingItem {
  return {
    id: m.key,
    name: m.name ?? m.key,
    title: typeof m.meta?.title === "string" ? m.meta.title : undefined,
    createdAt: m.createdAt,
    bytes: m.bytes,
    durationMs: Number(m.meta?.durationMs ?? 0),
    sampleRate: Number(m.meta?.sampleRate ?? 0),
    truncated: m.meta?.truncated === true,
    transcript: typeof m.meta?.transcript === "string" ? m.meta.transcript : undefined,
  }
}

/** A stable storage key for one recording. */
function makeKey(): string {
  return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * A filesystem-friendly file name, e.g. "Mentra Recording 2026-06-24 153012.wav".
 * Only spaces + hyphens (no colons/slashes), so it survives as the shared file's
 * name verbatim. This is the blob's `name` (and thus the shared filename).
 */
function makeName(d: Date): string {
  const p = (n: number) => n.toString().padStart(2, "0")
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `Mentra Recording ${date} ${time}.wav`
}

/**
 * A human-friendly display title, e.g. "Recording — Jun 24, 3:30 PM". Shown in
 * the UI and written as the WAV's INAM title tag. Kept separate from the
 * filename so it can use nice punctuation a filename shouldn't.
 */
function makeTitle(d: Date): string {
  const date = d.toLocaleDateString(undefined, {month: "short", day: "numeric"})
  const time = d.toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"})
  return `Recording — ${date}, ${time}`
}

/**
 * UTF-8 encode a string to bytes. The background JSContext (JSC/QuickJS) doesn't
 * guarantee `TextEncoder`, so encode by hand (same reason base64.ts is hand-rolled).
 */
function utf8Bytes(s: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i)
    // Combine surrogate pairs into a single code point.
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1)
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00)
        i++
      }
    }
    if (cp < 0x80) {
      out.push(cp)
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    } else {
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    }
  }
  return new Uint8Array(out)
}

/** Reduce a display title to a safe filename basis across iOS/Android/desktop. */
function sanitizeFileName(name: string): string {
  // Whitelist: keep letters/digits/space/._()- ; turn everything else (colons,
  // commas, em-dashes, slashes, etc.) into a space, then collapse runs.
  return (
    name
      .replace(/[^\p{L}\p{N} ._()-]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim() || "transcript"
  )
}

/** ms → m:ss. */
function fmtClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, "0")}`
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}
