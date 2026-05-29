/**
 * DisplayManager
 *
 * Thin imperative wrapper over `session.display.*`. Mirrors the SDK
 * module shape — short verbs that delegate to the underlying
 * DisplayManager. Callers decide when to push.
 */

import type {MiniappSession} from "@mentra/miniapp"

export class DisplayManager {
  constructor(private readonly session: MiniappSession) {}

  /**
   * Single line filling the glasses display.
   * `durationMs` is forwarded to the SDK; if set, the message auto-clears
   * after that long. Omit for a sticky message that persists until replaced.
   */
  showText(text: string, durationMs?: number): void {
    this.safeCall(() =>
      this.session.display.showTextWall(text, durationMs != null ? {durationMs} : undefined),
    )
  }

  // showTwoLines(top: string, bottom: string): void {
  //   this.showText(`${top} / ${bottom}`)
  // }

  // /** Title + body card. */
  // showCard(title: string, body: string): void {
  //   this.showText(`${title} — ${body}`)
  // }

  /**
   * Show a bitmap on the glasses. `base64Png` is a base64-encoded PNG;
   * the phone decodes it and converts to the glasses' native 1-bit
   * format. `durationMs` auto-clears after that long; omit for sticky.
   */
  showBitmap(base64Png: string, durationMs?: number): void {
    this.safeCall(() =>
      this.session.display.showBitmapView(
        base64Png,
        {width: 100, height: 100}
      ),
    )
  }

  /** Wipe whatever's on the glasses. */
  clear(): void {
    this.safeCall(() => this.session.display.clearView())
  }

  private safeCall(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      console.log("[NAV-MINI] display call ignored:", err)
    }
  }
}
