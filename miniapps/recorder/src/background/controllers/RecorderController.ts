/**
 * RecorderController — the always-on Recorder logic for this miniapp.
 *
 * Lives in the per-miniapp JSContext (NOT the WebView). Survives WebView
 * open/close so a capture keeps running with the phone pocketed.
 *
 * Responsibilities:
 *   - Capture     — `session.recorder.start/stop` taps the glasses mic PCM
 *                   host-side and writes a WAV blob (bytes never cross the bridge).
 *   - Library     — lists / deletes / clears `session.blob` entries.
 *   - Playback    — plays a saved recording back through `session.speaker` (file:// uri).
 *   - Export      — hands a recording to the OS share sheet via `session.blob.export`.
 *   - Glasses HUD — shows a "● REC m:ss" line on the display while recording.
 *   - UI bus      — mirrors state to the WebView and takes its commands.
 */

import type {BlobMeta, BlobRecordProgressData, MiniappSession, UnsubscribeFn} from "@mentra/miniapp/background"

import type {Channels} from "../../shared/channels"
import type {RecorderStatus, RecordingItem, Usage} from "../../shared/types"

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void
type On = <C extends keyof Channels & string>(channel: C, cb: (payload: Channels[C]) => void) => () => void

const EMPTY_USAGE: Usage = {bytes: 0, count: 0, quotaBytes: 0}

export class RecorderController {
  private started = false
  private readonly unsubs: Array<() => void> = []

  private ui!: {send: Send; on: On; onOpen: (cb: () => void) => () => void}

  private recordingId: string | null = null
  private lastStatus: RecorderStatus | null = null
  private playingId: string | null = null
  private recordings: RecordingItem[] = []
  private usage: Usage = EMPTY_USAGE
  private progressUnsub: UnsubscribeFn | null = null

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

    // Live capture progress (host-side, ~every 250ms).
    this.progressUnsub = this.session.recorder.onProgress((p) => this.onProgress(p))
    this.unsubs.push(() => this.progressUnsub?.())

    // Playback finished / errored → clear the playing indicator.
    try {
      this.unsubs.push(
        this.session.speaker.onStateChange((e) => {
          if (e.state === "stopped" || e.state === "error") this.setPlaying(null)
        }),
      )
    } catch {
      /* speaker state not available — ignore */
    }

    // On teardown, stop playback. An active recording is finalized host-side.
    try {
      this.unsubs.push(this.session.onBeforeDisconnect(() => this.onTeardown()))
    } catch {
      /* not available — ignore */
    }

    // Reclaim the glasses HUD when we return to the foreground.
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
    console.log(
      `Recorder: started (${this.recordings.length} recordings, hasMic=${this.session.recorder.hasPermission})`,
    )
  }

  private onTeardown(): void {
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
      hasMic: this.session.recorder.hasPermission,
    })
  }

  // ── Recording ──────────────────────────────────────────────────────────--

  private async startRecording(): Promise<void> {
    if (this.recordingId) return
    try {
      const {recordingId} = await this.session.recorder.start({format: "wav"})
      this.recordingId = recordingId
      this.lastStatus = {recordingId, ms: 0, bytes: 0, level: 0}
      this.ui.send("rec:status", this.lastStatus)
      this.renderHud()
    } catch (err) {
      console.log("Recorder: start failed", err)
      this.recordingId = null
      this.lastStatus = null
      this.ui.send("rec:stopped", {})
    }
  }

  private onProgress(p: BlobRecordProgressData): void {
    if (!this.recordingId || p.recordingId !== this.recordingId) return
    this.lastStatus = {recordingId: p.recordingId, ms: p.ms, bytes: p.bytes, level: p.level ?? 0}
    this.ui.send("rec:status", this.lastStatus)
    this.renderHud()
  }

  private async stopRecording(): Promise<void> {
    const id = this.recordingId
    if (!id) return
    this.recordingId = null
    this.lastStatus = null
    this.ui.send("rec:stopped", {})
    try {
      await this.session.recorder.stop(id)
    } catch (err) {
      console.log("Recorder: stop failed", err)
    }
    await this.refreshList()
    this.renderHud()
  }

  private async cancelRecording(): Promise<void> {
    const id = this.recordingId
    if (!id) return
    this.recordingId = null
    this.lastStatus = null
    this.ui.send("rec:stopped", {})
    try {
      await this.session.recorder.cancel(id)
    } catch {
      /* ignore */
    }
    this.renderHud()
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
      // play() resolves when playback ends; the state listener may have cleared
      // this already, but make sure the indicator is reset.
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

/** ms → m:ss. */
function fmtClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, "0")}`
}
