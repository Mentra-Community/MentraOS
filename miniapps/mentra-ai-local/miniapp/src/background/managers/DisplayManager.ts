/**
 * DisplayManager — thin wrapper over session.display for the glasses HUD.
 *
 * Replaces the cloud app's session.layouts.showTextWall calls. No-ops when the
 * connected glasses have no display (capabilities.hasDisplay === false).
 */

import type {MiniappSession} from "@mentra/miniapp/background"
import {wrapText} from "../lib/text-wrapper"
import {SPINNER_FRAMES, SPINNER_SIZE} from "../lib/spinner"

/** 576×288 glasses canvas — pin the spinner to the bottom-right corner. */
const CANVAS_WIDTH = 576
const CANVAS_HEIGHT = 288
const SPINNER_X = CANVAS_WIDTH - SPINNER_SIZE // 546
const SPINNER_Y = CANVAS_HEIGHT - SPINNER_SIZE // 258
const SPINNER_FRAME_MS = 60 // ~16 fps → one full rotation every ~1.8s

export class DisplayManager {
  private spinnerTimer: ReturnType<typeof setInterval> | null = null
  private spinnerFrame = 0

  constructor(private readonly session: MiniappSession) {}

  private get hasDisplay(): boolean {
    return Boolean(this.session.capabilities?.hasDisplay)
  }

  /** Show a transient status line (e.g. "Processing...", "Listening..."). */
  showStatus(text: string, durationMs = 5000): void {
    if (!this.hasDisplay) return
    try {
      this.session.display.showTextWall(text, {durationMs})
    } catch (error) {
      console.warn("Display showStatus failed:", error)
    }
  }

  /** Show a response on the HUD, wrapped to the display width. */
  showResponse(text: string, durationMs = 8000): void {
    if (!this.hasDisplay) return
    try {
      this.session.display.showTextWall(wrapText(text, 30), {durationMs})
    } catch (error) {
      console.warn("Display showResponse failed:", error)
    }
  }

  /** Welcome card shown once at session start. */
  showWelcome(): void {
    if (!this.hasDisplay) return
    try {
      this.session.display.showTextWall(
        'Mentra AI\n\nSay "Hey Mentra" followed by your question.',
        {durationMs: 3000},
      )
    } catch (error) {
      console.warn("Display showWelcome failed:", error)
    }
  }

  clear(): void {
    if (!this.hasDisplay) return
    try {
      this.session.display.clear()
    } catch {
      /* ignore */
    }
  }

  /** Whether the bottom-right spinner is currently animating. */
  get spinnerRunning(): boolean {
    return this.spinnerTimer !== null
  }

  /**
   * Start (or restart) the 30×30 spinner animation in the bottom-right of the
   * HUD, cycling the pre-encoded BMP frames. No-op without a display.
   * Returns true if the spinner is now running.
   */
  startSpinner(): boolean {
    if (!this.hasDisplay) return false
    if (this.spinnerTimer) return true
    this.spinnerFrame = 0
    const tick = () => {
      const frame = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length]!
      this.spinnerFrame++
      try {
        this.session.display.showBitmapView(frame, {
          x: SPINNER_X,
          y: SPINNER_Y,
          width: SPINNER_SIZE,
          height: SPINNER_SIZE,
        })
      } catch (error) {
        console.warn("Display spinner frame failed:", error)
      }
    }
    tick() // paint the first frame immediately
    this.spinnerTimer = setInterval(tick, SPINNER_FRAME_MS)
    return true
  }

  /** Stop the spinner animation and clear its tile. */
  stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer)
      this.spinnerTimer = null
    }
    if (!this.hasDisplay) return
    try {
      this.session.display.clear()
    } catch {
      /* ignore */
    }
  }
}
