import type {ButtonPressData, MiniappSession, TranscriptionData} from "@mentra/miniapp/background"

import type {Channels} from "../../shared/channels"

/**
 * GlassesController — the always-on logic for this miniapp.
 *
 * Lives inside the per-miniapp JSContext (NOT the WebView). Owns every
 * subscription to the `MiniappSession`. Subscriptions are bound to the
 * session lifetime, not to any React component lifecycle on the UI side
 * — closing the WebView does NOT stop transcription. The controller
 * survives WebView open/close cycles because the JSContext does.
 *
 * State is held in plain TypeScript fields. The controller pushes
 * updates to the UI WebView (when one is mounted) via the typed
 * `session.ui.send` channels declared in `shared/channels.ts`. If no
 * WebView is bound, `session.ui.send` silently drops — the controller
 * keeps the canonical state, and the next `session.ui.onOpen` fires
 * "captions:snapshot" to hydrate the UI.
 *
 * Imperative actions the UI requests (clear, speak summary, mirror
 * toggle) come back as `session.ui.on(channel, handler)` subscriptions
 * registered in `start()`.
 */

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void

export class GlassesController {
  private unsubs: Array<() => void> = []
  private subscribed = false

  // Canonical state — lives here, mirrored to UI via session.ui.send.
  private liveTranscript = ""
  private history: string[] = []
  private lastButton = ""
  private mirrorToGlasses = false
  // Tracked glasses-link state. Starts unknown (false); the
  // glasses.onConnection subscription sets it on initial bind and on every
  // flip, keeping the snapshot and the live `captions:connection-update`
  // channel in agreement. Deliberately NOT seeded from session.ready —
  // that's host-session readiness (CONNECT_ACK), not the glasses link, and
  // would falsely read "connected" until the first onConnection arrives.
  private connected = false

  constructor(private readonly session: MiniappSession) {}

  /** Idempotent — safe to call multiple times. */
  start(): void {
    if (this.subscribed) return
    this.subscribed = true

    const ui = this.session.ui as unknown as {
      send: Send
      onOpen: (cb: () => void) => () => void
      on: <C extends keyof Channels & string>(channel: C, cb: (p: Channels[C]) => void) => () => void
    }

    // Glasses subscriptions — always on while the session lives.
    this.unsubs.push(
      this.session.transcription.on((data: TranscriptionData) => {
        this.liveTranscript = data.text
        if (this.mirrorToGlasses) {
          // display.render() replaces the whole frame: one full-canvas text
          // element whose stable id makes successive transcripts update in
          // place. Box coordinates are raw device px from capabilities
          // (host-clamped, so the fallback is safe before "ready").
          const d = this.session.capabilities?.display
          void this.session.display.render([
            {type: "text", id: "mirror", box: {x: 0, y: 0, w: d?.width ?? 576, h: d?.height ?? 288}, text: data.text},
          ])
        }
        if (data.isFinal && data.text.trim()) {
          this.history.push(data.text.trim())
          this.liveTranscript = ""
          ui.send("captions:history-update", {history: [...this.history]})
        }
        ui.send("captions:live-transcript", {text: this.liveTranscript})
      }),
    )

    this.unsubs.push(
      this.session.input.onButtonPress((data: ButtonPressData) => {
        this.lastButton = `${data.buttonId} (${data.pressType})`
        ui.send("captions:last-button", {label: this.lastButton})
      }),
    )

    // Glasses connection — push to the UI on every flip so the status dot
    // stays accurate after a disconnect/reconnect while the page is open.
    this.unsubs.push(
      this.session.glasses.onConnection((data) => {
        this.connected = data.connected
        ui.send("captions:connection-update", {connected: data.connected})
      }),
    )

    // UI lifecycle — push a full snapshot every time a fresh WebView opens.
    // Tracked in `unsubs` so stop() tears it down and a restart doesn't
    // register a duplicate handler.
    this.unsubs.push(
      ui.onOpen(() => {
        const caps = this.session.capabilities
        ui.send("captions:snapshot", {
          capabilities: {
            hasCamera: !!(caps && (caps as Record<string, unknown>).hasCamera),
            hasMicrophone: !!(caps && (caps as Record<string, unknown>).hasMicrophone),
            hasDisplay: !!(caps && (caps as Record<string, unknown>).hasDisplay),
            hasSpeaker: !!(caps && (caps as Record<string, unknown>).hasSpeaker),
            hasWifi: !!(caps && (caps as Record<string, unknown>).hasWifi),
            modelName: (caps as Record<string, unknown>)?.modelName as string | undefined,
          },
          connection: {connected: this.connected},
          settings: {mirrorToGlasses: this.mirrorToGlasses},
          liveTranscript: this.liveTranscript,
          history: [...this.history],
          lastButton: this.lastButton,
        })
      }),
    )

    // UI → background imperative channels. Tracked in `unsubs` so stop()
    // detaches them and a restart can't stack duplicate handlers.
    this.unsubs.push(
      ui.on("captions:clear", () => {
        this.history = []
        this.liveTranscript = ""
        void this.session.display.render([])
        ui.send("captions:history-update", {history: []})
        ui.send("captions:live-transcript", {text: ""})
      }),
    )

    this.unsubs.push(
      ui.on("captions:speak-summary", async () => {
        const last3 = this.history.slice(-3).join(". ")
        const phrase = last3 ? `Here's what was said: ${last3}` : "Nothing to summarize yet."
        try {
          await this.session.speaker.speak(phrase)
        } catch {
          /* swallow — UI can poll session.speaker.state via background if needed */
        }
      }),
    )

    this.unsubs.push(
      ui.on("captions:set-mirror", ({mirrorToGlasses}) => {
        this.mirrorToGlasses = mirrorToGlasses
        ui.send("captions:settings-update", {mirrorToGlasses})
      }),
    )
  }

  stop(): void {
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
}
