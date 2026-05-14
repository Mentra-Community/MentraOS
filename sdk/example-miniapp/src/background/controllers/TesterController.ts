import type {MiniappSession} from "@mentra/miniapp/background"

import type {Channels} from "../../shared/channels"

/**
 * TesterController — the SDK Tester surface's background half.
 *
 * The UI tester pages can't call `session.*` directly (they're inside a
 * WebView, no native access). Instead each page sends one of two
 * channels and the controller dispatches:
 *
 *   - `tester:start` — open a subscription for an iface (Permissions,
 *     Storage, Transcription, IMU, Location, Microphone, System,
 *     Glasses). Forwards each event back to the UI as
 *     `tester:event` with `{iface, kind, payload}`. Idempotent —
 *     repeat starts share one underlying subscription.
 *   - `tester:stop` — release the subscription.
 *   - `tester:fire` — fire-and-forget action (Display, Led, Speaker,
 *     Phone, Glasses). Background dispatches to
 *     `session[iface][method](...args)`.
 *
 * Per Appendix A's tester taxonomy:
 *   read-only (a):  Permissions, Storage, Transcription, IMU,
 *                   Location, Microphone, System
 *   fire-only (b):  Display, Led, Speaker, Phone, Glasses
 *   pure-UI  (c):   TesterMenu, _TesterRow, ComingSoon
 *                   (don't talk to background at all)
 */

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void

export class TesterController {
  private subscriptions: Map<string, () => void> = new Map()

  constructor(private readonly session: MiniappSession) {}

  start(): void {
    const ui = this.session.ui as unknown as {
      send: Send
      on: <C extends keyof Channels & string>(
        channel: C,
        cb: (p: Channels[C]) => void,
      ) => () => void
    }

    ui.on("tester:start", ({iface}) => {
      if (this.subscriptions.has(iface)) return
      const unsub = this.openSubscription(iface, ui.send)
      if (unsub) this.subscriptions.set(iface, unsub)
    })

    ui.on("tester:stop", ({iface}) => {
      const unsub = this.subscriptions.get(iface)
      if (!unsub) return
      try {
        unsub()
      } catch {
        /* ignore */
      }
      this.subscriptions.delete(iface)
    })

    ui.on("tester:fire", ({iface, method, args}) => {
      this.dispatchAction(iface, method, args ?? [], ui.send)
    })
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
  }

  /**
   * Open a per-iface subscription that pipes every event back to the UI
   * as `tester:event`. The `kind` field tells the UI which sub-channel
   * fired (transcription:final, location:update, etc.) so a single
   * tester page can render a typed timeline.
   */
  private openSubscription(iface: string, send: Send): (() => void) | null {
    const emit = (kind: string, payload: unknown) => {
      send("tester:event", {iface, kind, payload})
    }
    switch (iface) {
      case "transcription":
        return this.session.transcription.on((data) => emit(data.isFinal ? "final" : "partial", data))
      case "translation":
        // Default to en-US → es-ES; UI can re-issue tester:fire with
        // forLanguagePair if it wants something else.
        return this.session.translation.forLanguagePair("en-US", "es-ES", (data) =>
          emit("event", data),
        )
      case "input":
        return this.session.input.onButtonPress((data) => emit("button", data))
      case "imu":
        return this.session.imu.onHeadPosition((data) => emit("head", data))
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
      case "permissions":
        return this.session.permissions.onUpdate((data) => emit("update", data))
      case "storage":
        // No event surface on the storage module — UI does ad-hoc gets via
        // `tester:fire`. Keep the start handler around as a no-op so the
        // UI's "is the subscription open?" toggle remains consistent.
        return () => {}
      case "system":
        // The system module has no event surface today; surface a one-off
        // "subscription opened" event so the UI's "is the subscription
        // open?" toggle stays consistent without sending periodic noise.
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

  /**
   * Generic fire-and-forget dispatcher. The UI passes the iface +
   * method + args; we look up `session[iface][method]` and invoke
   * with the provided args. Result (if any) is sent back via the
   * tester:event channel with kind="result". Errors fire kind="error".
   */
  private async dispatchAction(
    iface: string,
    method: string,
    args: unknown[],
    send: Send,
  ): Promise<void> {
    const module = (this.session as unknown as Record<string, unknown>)[iface] as
      | Record<string, unknown>
      | undefined
    if (!module) {
      send("tester:event", {iface, kind: "error", payload: {message: `unknown iface "${iface}"`}})
      return
    }
    const fn = module[method] as ((...a: unknown[]) => unknown) | undefined
    if (typeof fn !== "function") {
      send("tester:event", {
        iface,
        kind: "error",
        payload: {message: `unknown method "${iface}.${method}"`},
      })
      return
    }
    try {
      const result = await Promise.resolve(fn.apply(module, args))
      send("tester:event", {iface, kind: "result", payload: {method, result}})
    } catch (e) {
      send("tester:event", {
        iface,
        kind: "error",
        payload: {method, message: e instanceof Error ? e.message : String(e)},
      })
    }
  }
}
