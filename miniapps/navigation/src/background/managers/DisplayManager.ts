/**
 * DisplayManager
 *
 * Thin imperative wrapper over `session.display.*`. Mirrors the SDK
 * module shape — short verbs that delegate to the underlying
 * DisplayManager. Callers decide when to push.
 */

import type {MiniappSession} from "@mentra/miniapp"
import {borderTestImageBase64} from "../lib/bmp"

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

  showTextTest(): void {
    this.safeCall(() =>
      this.session.display.showTextWall(
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Donec venenatis vulputate lorem. Maecenas vestibulum mollis diam. Pellentesque ut neque. Sed lectus. Donec sodales sagittis magna.",
      ),
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
   * Show a bitmap on the glasses. `base64Bmp` is a base64-encoded 1-bit
   * BMP (see MinimapRenderer/bmp.ts). `width`/`height` size the target
   * container on the glasses canvas.
   */
  showBitmap(base64Bmp: string): void {
    this.safeCall(() => this.session.display.showBitmapView(base64Bmp, {x: 576-100, y: 0, width: 100, height: 100}))
  }

  /**
   * Swipe test box: a plain bordered W×H bitmap centered on the 576×288 canvas.
   * Clears EVERYTHING first, then draws the box immediately.
   * Note widths >200 may not render on the G2 (single-container limit).
   */
  showTestBox(width: number, height: number): void {
    const w = Math.max(8, Math.min(width, 576))
    const h = Math.max(8, Math.min(height, 288))
    const base64Bmp = borderTestImageBase64(w, h)
    const x = Math.round((576 - w) / 2)
    const y = Math.round((288 - h) / 2)
    // Clear first, wait 2s so old containers tear down, THEN draw the box.
    this.safeCall(() => this.session.display.clear())
    setTimeout(() => {
      this.safeCall(() => this.session.display.showBitmapView(base64Bmp, {x, y, width: w, height: h}))
    }, 1000)
  }

  /**
   * Large map shown on swipe-up: a W×H bitmap centered on the 576×288 canvas.
   * Bounded only to the canvas (not the ~200px container limit) so the requested
   * size — e.g. 288×140 — passes through as-is.
   */
  showLargeBitmap(base64Bmp: string, width = 288, height = 140): void {
    const w = Math.max(8, Math.min(width, 576))
    const h = Math.max(8, Math.min(height, 288))
    const x = Math.round((576 - w) / 2)
    const y = Math.round((288 - h) / 2)
    this.safeCall(() => this.session.display.showBitmapView(base64Bmp, {x, y, width: w, height: h}))
  }


  // ── Two stacked text containers ──────────────────────────────────────
  // The G2's single full-screen (576×288) text wall only fits ~5 lines. To get
  // more usable vertical text we split into two stacked positioned-text
  // containers: maneuver/directions on top, trip stats below.
  private static readonly MANEUVER_REGION = {x: 0, y: 0, width: 576, height: 190}
  private static readonly STATS_REGION = {x: 0, y: 195, width: 576, height: 93}

  /**
   * Maneuver / direction text in the TOP region of the canvas (its own G2 text
   * container), leaving the bottom region free for the stats container.
   */
  showManeuver(text: string): void {
    this.safeCall(() =>
      this.session.display.showTextAt(text, {...DisplayManager.MANEUVER_REGION}),
    )
  }

  /**
   * Live trip-stats (distance + ETA) in the BOTTOM region, in its own G2 text
   * container stacked under the maneuver box.
   */
  showTripStats(text: string): void {
    this.safeCall(() =>
      this.session.display.showTextAt(text, {...DisplayManager.STATS_REGION}),
    )
  }

  /**
   * Test-only: clear the view, then render a 288x288 bitmap centered on the
   * 576x288 canvas (x=144). Used by the dev panel's "Send test bitmap" button
   * to verify the bitmap pipeline in isolation — no maneuver text competing.
   */
  showBitmapTest(base64Bmp: string): void {
    this.safeCall(() => {
      this.session.display.clear()
      this.session.display.showBitmapView(base64Bmp, {x: 144, y: 0, width: 288, height: 288})
    })
  }

  /**
   * Test-only: render a square gradient bitmap at `size`×`size` pixels, shown
   * in a same-size container centered on the 576×288 canvas. Lets the dev panel
   * compare how different bitmap sizes render — note the glasses flip into
   * "quad mode" once width>200 or height>100 (see miniapp SDK display.ts).
   */
  showBitmapSize(size: number, height?: number): void {
    // Pass the requested size through UNCLAMPED (only bounded to the 576×288
    // canvas) so the dev panel can probe what the G2 actually renders past the
    // ~200px single-container limit. >200 wide may render nothing (quad mode).
    const w = Math.max(8, Math.min(size, 576))
    const h = Math.max(8, Math.min(height ?? size, 288))
    if (size > 200) {
      console.log(`[NAV-MINI] bitmap width ${size} > 200 — may not render (G2 quad-mode limit)`)
    }
    const base64Bmp = borderTestImageBase64(w, h)
    const x = Math.round((576 - w) / 2)
    const y = Math.round((288 - h) / 2)
    // Clear first, wait 3s so the old container fully tears down, THEN draw the
    // new bitmap — avoids the G2 reusing/overlapping a stale image container.
    this.safeCall(() => this.session.display.clear())
    setTimeout(() => {
      this.safeCall(() => this.session.display.showBitmapView(base64Bmp, {x, y, width: w, height: h}))
    }, 3000)
  }

  /**
   * Test-only: show a pre-rendered base64 BMP at a given container size,
   * centered and within the G2 ≤200px width limit. Used by the OSM line-map PoC.
   */
  showRawBitmap(base64Bmp: string, width: number, height: number): void {
    const w = Math.max(8, Math.min(width, 200))
    const h = Math.max(8, Math.min(height, 288))
    const x = Math.round((576 - w) / 2)
    const y = Math.round((288 - h) / 2)
    // No clear() first: the rect is always the same, so G2 reuses the existing
    // image container and swaps the bitmap in place (see G2.displayBitmap's
    // "reuse container if rect matches"). Clearing would destroy the container
    // and force a full add+rebuild every redraw — that's the off→on flicker.
    this.safeCall(() => {
      this.session.display.showBitmapView(base64Bmp, {x, y, width: w, height: h})
    })
  }

  /** Wipe whatever's on the glasses. */
  clear(): void {
    this.safeCall(() => this.session.display.clear())
  }

  private safeCall(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      console.log("[NAV-MINI] display call ignored:", err)
    }
  }
}
