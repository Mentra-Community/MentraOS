import type {ButtonPressData, MiniappSession, TranscriptionData} from "@mentra/miniapp"
import {useAppStore} from "../store/appStore"

/**
 * GlassesController — the always-on logic for this miniapp.
 *
 * Owns every subscription to the MiniappSession. Subscriptions are bound
 * to the session lifetime, NOT to any React component lifecycle. The
 * controller is instantiated once at module init in main.tsx and never
 * unmounts.
 *
 * React pages read from the appStore and call imperative methods on the
 * controller — they never subscribe to session events directly.
 *
 * Tester pages (src/pages/tester/) are an explicit exception — they're
 * diagnostic surfaces, ephemeral by design, and may inline-subscribe to
 * `session.*` for display purposes only.
 *
 * If your miniapp grows beyond ~5 distinct concerns, consider splitting
 * the controller into per-concern manager classes (Mentra-AI's pattern).
 * For 1-3 concerns, keeping everything inline here is clearer.
 */
export class GlassesController {
  private unsubs: Array<() => void> = []
  private subscribed = false

  constructor(private readonly session: MiniappSession) {}

  /**
   * Wire subscriptions. Idempotent: noop if already wired. Subscriptions
   * stay alive for the entire session — they are NOT bound to any React
   * component's lifecycle.
   */
  start(): void {
    if (this.subscribed) return
    this.subscribed = true

    // The session queues outbound calls until CONNECT_ACK
    // (queue-before-ACK behavior in MiniappSession), so this works
    // regardless of whether the session is connected yet.

    this.unsubs.push(
      this.session.transcription.on((data: TranscriptionData) => {
        const store = useAppStore.getState()
        store.setLiveTranscript(data.text)
        if (store.mirrorToGlasses) {
          this.session.display.showTextWall(data.text)
        }
        if (data.isFinal && data.text.trim()) {
          store.appendHistory(data.text.trim())
          store.setLiveTranscript("")
        }
      }),
    )

    this.unsubs.push(
      this.session.input.onButtonPress((data: ButtonPressData) => {
        useAppStore.getState().setLastButton(`${data.buttonId} (${data.pressType})`)
      }),
    )
  }

  // ─── Imperative actions exposed to React UI ─────────────────────────────

  clearGlasses(): void {
    useAppStore.getState().clearHistory()
    this.session.display.clearView()
  }

  async speakSummary(): Promise<void> {
    const history = useAppStore.getState().history
    const last3 = history.slice(-3).join(". ")
    const phrase = last3 ? `Here's what was said: ${last3}` : "Nothing to summarize yet."
    try {
      await this.session.speaker.speak(phrase)
    } catch {
      /* swallow TTS error; UI can read session.speaker.state if it cares */
    }
  }

  /** Called only on full app teardown (rare in practice). */
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

// Module-level singleton — accessed by main.tsx and any UI that needs to
// dispatch imperative actions.
let instance: GlassesController | null = null

export function getGlassesController(): GlassesController {
  if (!instance) {
    throw new Error(
      "GlassesController not yet initialized — call initGlassesController(session) first",
    )
  }
  return instance
}

export function initGlassesController(session: MiniappSession): GlassesController {
  if (instance) return instance
  instance = new GlassesController(session)
  instance.start()
  return instance
}
