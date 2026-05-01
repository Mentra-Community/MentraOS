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

  /** Single line filling the glasses display. */
  showText(text: string): void {
    this.safeCall(() => this.session.display.showTextWall(text))
  }

  // showTwoLines(top: string, bottom: string): void {
  //   this.showText(`${top} / ${bottom}`)
  // }

  // /** Title + body card. */
  // showCard(title: string, body: string): void {
  //   this.showText(`${title} — ${body}`)
  // }

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
