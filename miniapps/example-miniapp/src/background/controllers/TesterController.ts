import type {MiniappSession} from "@mentra/miniapp/background"

import type {Channels} from "../../shared/channels"

/**
 * TesterController — the SDK Tester surface's background half.
 *
 * The UI tester pages can't call `session.*` directly (they're inside a
 * WebView, no native access). Two patterns:
 *
 *   1. **Subscribe-based testers** (Storage / Transcription / IMU /
 *      Location / Microphone / System / Glasses / Phone).
 *      UI sends `tester:start` → we open a subscription that pipes events
 *      back as streamed `tester:event` with `{iface, kind, payload}`.
 *      UI sends `tester:stop` to release.
 *
 *   2. **Imperative testers** (Display / Led / Speaker / Phone fire /
 *      Storage gets). UI calls `await mentra.request("tester:invoke", ...)`
 *      and we dispatch to `session[iface][method](...args)` via the new
 *      `session.ui.handle` API. The return value flows back through the
 *      SDK's RPC reply; errors throw on the UI side automatically.
 */

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void

export class TesterController {
  private subscriptions: Map<string, () => void> = new Map()
  private unsubs: Array<() => void> = []
  private subscribed = false

  constructor(private readonly session: MiniappSession) {}

  /** Idempotent — safe to call multiple times. */
  start(): void {
    if (this.subscribed) return
    this.subscribed = true

    const ui = this.session.ui as unknown as {
      send: Send
      on: <C extends keyof Channels & string>(channel: C, cb: (p: Channels[C]) => void) => () => void
      handle: <C extends keyof Channels & string>(
        channel: C,
        handler: (payload: unknown, ctx?: {signal: AbortSignal}) => Promise<unknown> | unknown,
      ) => () => void
    }

    // Track every UI listener (including the broadcast tester:start/stop
    // ones) in `unsubs` so stop() detaches them and a restart can't stack
    // duplicate handlers or leak the previous tester:invoke handle.
    this.unsubs.push(
      ui.on("tester:start", ({iface}) => {
        if (this.subscriptions.has(iface)) return
        const unsub = this.openSubscription(iface, ui.send)
        if (unsub) this.subscriptions.set(iface, unsub)
      }),
    )

    this.unsubs.push(
      ui.on("tester:stop", ({iface}) => {
        const unsub = this.subscriptions.get(iface)
        if (!unsub) return
        try {
          unsub()
        } catch {
          /* ignore */
        }
        this.subscriptions.delete(iface)
      }),
    )

    // The single imperative-dispatch handler. Used by every fire-style
    // tester page. Replaces the old `tester:fire` + `tester:event{kind:result}`
    // muxed-into-stream pattern.
    this.unsubs.push(
      ui.handle("tester:invoke", async (payload) => {
        const {iface, method, args} = payload as {iface: string; method: string; args?: unknown[]}
        const module = (this.session as unknown as Record<string, unknown>)[iface] as
          | Record<string, unknown>
          | undefined
        if (!module) throw new Error(`unknown iface "${iface}"`)
        const fn = module[method] as ((...a: unknown[]) => unknown) | undefined
        if (typeof fn !== "function") throw new Error(`unknown method "${iface}.${method}"`)
        return await Promise.resolve(fn.apply(module, args ?? []))
      }),
    )

    this.unsubs.push(
      ui.handle("tester:calendar-list", async (payload) => {
        const {startsAt, endsAt, limit} = payload as {startsAt: string; endsAt: string; limit?: number}
        return await this.session.phone.calendar.listEvents({startsAt, endsAt, limit})
      }),
    )

    // speaker.createStream E2E: generate a sine tone background-side and pump
    // it through the live PCM stream. Runs here (not tester:invoke) because
    // the SpeakerStreamWriter can't cross the bridge — only a summary returns.
    // Writes are awaited, so the host's backpressure ceiling paces the loop.
    this.unsubs.push(
      ui.handle("tester:speaker-stream-tone", async (payload) => {
        const {
          seconds = 5,
          freqHz = 440,
          sampleRate = 16000,
        } = (payload ?? {}) as {seconds?: number; freqHz?: number; sampleRate?: 16000 | 24000 | 48000}

        const writer = await this.session.speaker.createStream({sampleRate})
        try {
          // 100ms chunks of 16-bit LE mono sine.
          const chunkFrames = Math.floor(sampleRate / 10)
          const totalChunks = Math.max(1, Math.round(seconds * 10))
          let phase = 0
          const phaseStep = (2 * Math.PI * freqHz) / sampleRate
          let last = {bufferedMs: 0}
          for (let i = 0; i < totalChunks; i++) {
            const buf = new Uint8Array(chunkFrames * 2)
            const view = new DataView(buf.buffer)
            for (let f = 0; f < chunkFrames; f++) {
              // 0.25 amplitude so it isn't ear-splitting through the glasses.
              view.setInt16(f * 2, Math.round(Math.sin(phase) * 0x2000), true)
              phase += phaseStep
            }
            last = await writer.write(buf)
          }
          const {durationMs} = await writer.close()
          return {streamId: writer.streamId, durationMs, chunks: totalChunks, lastBufferedMs: last.bufferedMs}
        } catch (err) {
          await writer.abort().catch(() => {})
          throw err
        }
      }),
    )
  }

  stop(): void {
    for (const [, unsub] of this.subscriptions) {
      try {
        unsub()
      } catch {
        /* ignore */
      }
    }
    this.subscriptions.clear()
    for (const u of this.unsubs) {
      try {
        u()
      } catch {
        /* ignore */
      }
    }
    this.unsubs = []
    this.subscribed = false
  }

  /**
   * Open a per-iface subscription that pipes every event back to the UI
   * as `tester:event`. The `kind` field tells the UI which sub-channel
   * fired (transcription:final, location:update, ...) so a single tester
   * page can render a typed timeline.
   */
  private openSubscription(iface: string, send: Send): (() => void) | null {
    const emit = (kind: string, payload: unknown) => {
      send("tester:event", {iface, kind, payload})
    }
    switch (iface) {
      case "transcription":
        return this.session.transcription.on((data) => emit(data.isFinal ? "final" : "partial", data))
      case "translation":
        return this.session.translation.to("es-ES", (data) => emit("event", data))
      case "input": {
        const b = this.session.input.onButtonPress((data) => emit("button", data))
        const t = this.session.input.onTouch((data) => emit("touch", data))
        return () => {
          b()
          t()
        }
      }
      case "stream": {
        // Stream status (lifecycle + Cloudflare + coordinator-emitted errors)
        // arrives as a generic `stream_status` event stream. The coordinator
        // emits everything keyed by streamId so the UI can render a unified
        // timeline regardless of source.
        const s = this.session.events.subscribe("stream_status", (data) => emit("status", data))
        return () => s()
      }
      case "camera": {
        // Camera has no event stream — takePhoto() resolves via `kind:"result"`
        // through the generic dispatchAction path. Return a no-op subscriber
        // so the UI's "subscription open?" toggle is consistent.
        return () => {}
      }
      case "imu": {
        const h = this.session.imu.onHeadPosition((data) => emit("head", data))
        const a = this.session.imu.onAccel((data) => emit("accel", data))
        return () => {
          h()
          a()
        }
      }
      case "location":
        return this.session.location.onUpdate((data) => emit("update", data))
      case "mic": {
        const a = this.session.mic.onAudioChunk((data) => emit("audio", {data}))
        const v = this.session.mic.onVoiceActivity((data) => emit("vad", data))
        return () => {
          a()
          v()
        }
      }
      case "storage":
        return () => {}
      case "system":
        emit("opened", {note: "session.system has no event surface yet"})
        return () => {}
      case "glasses": {
        const b = this.session.glasses.onBattery((data) => emit("battery", data))
        const c = this.session.glasses.onConnection((data) => emit("connection", data))
        return () => {
          b()
          c()
        }
      }
      case "phone": {
        const n = this.session.phone.notifications.on((data) => emit("notification", data))
        const b = this.session.phone.onBattery((data) => emit("battery", data))
        return () => {
          n()
          b()
        }
      }
      default:
        return null
    }
  }
}
