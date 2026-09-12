/**
 * GlassesMicProbe — on-device level meter for the Bluetooth LC3 microphone.
 *
 * Pins the SDK to the glasses microphone exactly the way a Mentra Call does, then reports the
 * decoded PCM level once a second as `[MIC_PROBE]` log lines, so a soak can tell "the glasses
 * mic is analog-quiet" apart from "the uplink dropped it". Optionally keeps an A2DP PCM stream
 * open to the glasses at the same time (silence or a tone), which is the duplex condition a
 * Teams call puts the BES in: far-end audio playing while the LC3 mic is live.
 *
 * Dev tooling. Reachable from `com.mentra://test/mic-probe`.
 */
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"

import audioPlaybackService from "./AudioPlaybackService"
import micStateCoordinator from "./MicStateCoordinator"
import {SETTINGS, useSettingsStore} from "../stores/settings"
import {summarizePcm16} from "../utils/pcm16"
import {BgTimer} from "../utils/timers"

export type MicProbeA2dpMode = "none" | "silence" | "tone"

/**
 * Which microphone to meter. `glasses` is the call path (pinned, LC3 over BLE). `phone` is a
 * control: same meter on the phone's own microphone, so a flat glasses trace can be told apart
 * from a quiet room.
 */
export type MicProbeSource = "glasses" | "phone"

export type MicProbeOptions = {
  /** How long to run before stopping on its own. */
  durationMs: number
  /** What to play to the glasses over A2DP while the mic is live. */
  a2dp: MicProbeA2dpMode
  /** Peak amplitude of the tone as a fraction of full scale (0..1). */
  toneLevel?: number
  /** Microphone under test. Defaults to `glasses`. */
  source?: MicProbeSource
}

const A2DP_MODES: MicProbeA2dpMode[] = ["none", "silence", "tone"]
const SOURCES: MicProbeSource[] = ["glasses", "phone"]

/**
 * Parse `com.mentra://test/mic-probe?seconds=&a2dp=&level=` query values.
 *
 * adb/shell often backslash-escapes `&`, so `seconds=15\&a2dp=none` arrives as
 * `seconds=15\`. Digits-only parsing is what keeps that from falling back to 20s.
 */
export function parseMicProbeParams(params: Record<string, string | undefined | string[]>): MicProbeOptions {
  const raw = (key: string) => {
    const value = params[key]
    return String(Array.isArray(value) ? value[0] : (value ?? ""))
  }
  const seconds = Number.parseInt(raw("seconds").replace(/[^\d]/g, ""), 10)
  const durationMs = (Number.isFinite(seconds) && seconds > 0 ? Math.min(600, seconds) : 20) * 1000
  const a2dpRaw = raw("a2dp")
  const a2dp = (A2DP_MODES.includes(a2dpRaw as MicProbeA2dpMode) ? a2dpRaw : "none") as MicProbeA2dpMode
  const toneLevel = Number.parseFloat(raw("level").replace(/[^\d.]/g, ""))
  const sourceRaw = raw("mic")
  const source = (SOURCES.includes(sourceRaw as MicProbeSource) ? sourceRaw : "glasses") as MicProbeSource
  return {
    durationMs,
    a2dp,
    toneLevel: Number.isFinite(toneLevel) && toneLevel > 0 ? Math.min(1, toneLevel) : 0.2,
    source,
  }
}

export type MicProbeSample = {
  /** Seconds since the probe started. */
  t: number
  /** Mean absolute sample value over the last second (16-bit scale). */
  meanAbs: number
  /** Largest absolute sample over the last second. */
  peak: number
  /** PCM frames received in the last second. */
  frames: number
  /** Microphone source reported by the SDK for the last frame. */
  source: string
  /** Frames dropped because the SDK reported a non-glasses source. */
  nonGlasses: number
  a2dp: MicProbeA2dpMode
}

type Listener = (sample: MicProbeSample) => void

const GLASSES = "glasses"
const A2DP_RATE = 16000
const A2DP_CHUNK_MS = 60
const TONE_HZ = 440

// Same meter the call uplink logs with, so probe and call numbers are comparable.
export {pcmDataView, summarizePcm16} from "../utils/pcm16"

/** `chunkMs` of 16 kHz mono PCM16, either digital silence or a sine at `level` full scale. */
export function makeA2dpChunk(mode: Exclude<MicProbeA2dpMode, "none">, chunkMs: number, phase: number, level = 0.2) {
  const samples = Math.round((A2DP_RATE * chunkMs) / 1000)
  const bytes = new Uint8Array(samples * 2)
  const view = new DataView(bytes.buffer)
  const amp = Math.max(0, Math.min(1, level)) * 32767
  const step = (2 * Math.PI * TONE_HZ) / A2DP_RATE
  for (let i = 0; i < samples; i++) {
    const v = mode === "tone" ? Math.round(Math.sin(phase + i * step) * amp) : 0
    view.setInt16(i * 2, v, true)
  }
  return {bytes, phase: (phase + samples * step) % (2 * Math.PI)}
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

class GlassesMicProbe {
  private running = false
  private stopping: Promise<void> | null = null
  /** Bumped on every start/stop so an await that loses the race cannot re-arm the probe. */
  private generation = 0
  private options: MicProbeOptions | null = null
  private startedAt = 0
  private micSub: {remove: () => void} | null = null
  private tick: number | null = null
  private stopTimer: number | null = null
  private a2dpTimer: number | null = null
  private a2dpStreamId: string | null = null
  private a2dpPhase = 0
  private window: unknown[] = []
  private lastSource = ""
  private nonGlasses = 0
  /** `preferred_mic` before a `source=phone` control run changed it. */
  private savedPreferredMic: string | null = null
  private listeners = new Set<Listener>()
  private lastSample: MicProbeSample | null = null

  isRunning(): boolean {
    return this.running
  }

  last(): MicProbeSample | null {
    return this.lastSample
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(options: MicProbeOptions): Promise<void> {
    // A stop still unpinning the mic must finish before we pin again, or its unpin lands on us.
    if (this.running) await this.stop()
    else if (this.stopping) await this.stopping
    const generation = ++this.generation
    this.running = true
    this.options = options
    this.startedAt = Date.now()
    this.window = []
    this.nonGlasses = 0
    this.lastSource = ""
    this.lastSample = null
    const source = options.source ?? GLASSES
    console.log("[MIC_PROBE] start", options)

    if (source === GLASSES) {
      // Same order as AcsMeetingService.startGlassesMicUplink: pin first so the first frame the
      // requirement produces is already from the glasses and the phone mic is never opened.
      await Promise.resolve(BluetoothSdk.setMicSourcePin?.(GLASSES)).catch((error) => {
        console.warn("[MIC_PROBE] pin failed", error)
      })
    } else {
      // Control run: no pin (only the glasses can be pinned); steer the ranking with the
      // user preference and put it back on stop.
      const settings = useSettingsStore.getState()
      this.savedPreferredMic = settings.getSetting(SETTINGS.preferred_mic.key) ?? "auto"
      await settings.setSetting(SETTINGS.preferred_mic.key, source, false)
    }
    if (this.generation !== generation) return
    micStateCoordinator.setCallRequirement(true)
    this.micSub = BluetoothSdk.addListener("mic_pcm", (event: {pcm?: unknown; source?: string}) => {
      this.lastSource = event.source ?? ""
      if (event.source !== source) {
        this.nonGlasses += 1
        return
      }
      if (event.pcm) this.window.push(event.pcm)
    })

    if (options.a2dp !== "none") await this.startA2dp(options.a2dp, options.toneLevel ?? 0.2)
    if (this.generation !== generation) return

    this.tick = BgTimer.setInterval(() => this.report(), 1000)
    this.stopTimer = BgTimer.setTimeout(() => void this.stop(), options.durationMs)
  }

  async stop(): Promise<void> {
    this.generation += 1
    if (!this.running) return this.stopping ?? undefined
    this.running = false
    if (this.tick !== null) BgTimer.clearInterval(this.tick)
    if (this.stopTimer !== null) BgTimer.clearTimeout(this.stopTimer)
    this.tick = null
    this.stopTimer = null
    this.report()
    this.micSub?.remove()
    this.micSub = null
    micStateCoordinator.setCallRequirement(false)
    this.stopping = (async () => {
      if ((this.options?.source ?? GLASSES) === GLASSES) {
        await Promise.resolve(BluetoothSdk.setMicSourcePin?.(null)).catch((error) => {
          console.warn("[MIC_PROBE] unpin failed", error)
        })
      } else if (this.savedPreferredMic !== null) {
        const restore = this.savedPreferredMic
        this.savedPreferredMic = null
        await useSettingsStore.getState().setSetting(SETTINGS.preferred_mic.key, restore, false)
      }
      await this.stopA2dp()
      console.log("[MIC_PROBE] stop")
    })().finally(() => {
      this.stopping = null
    })
    return this.stopping
  }

  private report(): void {
    const frames = this.window
    this.window = []
    let stats = {meanAbs: 0, peak: 0}
    try {
      stats = summarizePcm16(frames)
    } catch (error) {
      const first = frames[0]
      console.warn("[MIC_PROBE] pcm summarize failed", {
        frames: frames.length,
        type: first == null ? "empty" : Object.prototype.toString.call(first),
        byteLength: (first as {byteLength?: number} | undefined)?.byteLength,
        error,
      })
    }
    const sample: MicProbeSample = {
      t: Math.round((Date.now() - this.startedAt) / 1000),
      meanAbs: stats.meanAbs,
      peak: stats.peak,
      frames: frames.length,
      source: this.lastSource,
      nonGlasses: this.nonGlasses,
      a2dp: this.options?.a2dp ?? "none",
    }
    this.lastSample = sample
    console.log(
      `[MIC_PROBE] t=${sample.t} meanAbs=${sample.meanAbs} peak=${sample.peak} frames=${frames.length} ` +
        `source=${sample.source || "-"} nonGlasses=${sample.nonGlasses} a2dp=${sample.a2dp}`,
    )
    for (const listener of this.listeners) listener(sample)
  }

  private async startA2dp(mode: Exclude<MicProbeA2dpMode, "none">, level: number): Promise<void> {
    const streamId = `mic-probe-${Date.now()}`
    await audioPlaybackService.openStream({
      streamId,
      appId: "mic-probe",
      sampleRate: A2DP_RATE,
      channels: 1,
      stopOtherAudio: true,
      jitterMs: 120,
      onEnded: () => {
        if (this.a2dpStreamId === streamId) this.a2dpStreamId = null
      },
    })
    this.a2dpStreamId = streamId
    this.a2dpPhase = 0
    let inFlight = false
    this.a2dpTimer = BgTimer.setInterval(() => {
      if (inFlight || this.a2dpStreamId !== streamId) return
      inFlight = true
      const chunk = makeA2dpChunk(mode, A2DP_CHUNK_MS, this.a2dpPhase, level)
      this.a2dpPhase = chunk.phase
      audioPlaybackService
        .writeStreamChunk(streamId, bytesToBase64(chunk.bytes))
        .catch((error) => console.warn("[MIC_PROBE] a2dp write failed", error))
        .finally(() => {
          inFlight = false
        })
    }, A2DP_CHUNK_MS)
  }

  private async stopA2dp(): Promise<void> {
    if (this.a2dpTimer !== null) BgTimer.clearInterval(this.a2dpTimer)
    this.a2dpTimer = null
    const streamId = this.a2dpStreamId
    this.a2dpStreamId = null
    if (streamId) await audioPlaybackService.abortStream(streamId).catch(() => undefined)
  }
}

const glassesMicProbe = new GlassesMicProbe()
export default glassesMicProbe
