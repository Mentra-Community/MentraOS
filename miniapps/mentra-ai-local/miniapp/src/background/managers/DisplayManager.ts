/**
 * DisplayManager — thin wrapper over session.display for the glasses HUD.
 *
 * Replaces the cloud app's session.layouts.showTextWall calls. No-ops when the
 * connected glasses have no display (capabilities.hasDisplay === false).
 */

import type {MiniappSession} from "@mentra/miniapp/background"
import {wrapText} from "../lib/text-wrapper"

export class DisplayManager {
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
}
