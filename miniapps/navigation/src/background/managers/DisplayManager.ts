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
    this.safeCall(() => this.session.display.showBitmapView(base64Bmp, {x: 576-87, y: 0, width: 87, height: 87}))
  }


  /**
   * Live trip-stats label in the very bottom-left of the 576×288 canvas:
   * distance remaining + ETA, which decrement as the user nears the
   * destination. Rendered in a rounded-border positioned text container (G2).
   */
  showTripStats(text: string): void {
    // Very bottom-left edge of the 576×288 canvas: a 160×87 container at (0, 201).
    const w = 160
    const h = 87
    this.safeCall(() =>
      this.session.display.showTextAt(text, {
        x: 0,
        y: 288 - h,
        width: w,
        height: h,
        borderWidth: 2,
        borderRadius: 6,
      }),
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
    // Clamp width to ≤200: a single G2 image container maxes out ~200px wide
    // (defaultImgWidth in G2.kt). Containers wider than that need quad-mode
    // tiling, which isn't implemented — they silently render nothing.
    const w = Math.max(8, Math.min(size, 200))
    const h = Math.max(8, Math.min(height ?? size, 288))
    if (size > 200) {
      console.log(`[NAV-MINI] bitmap width ${size} clamped to 200 (G2 single-container limit)`)
    }
    const base64Bmp = borderTestImageBase64(w, h)
    const x = Math.round((576 - w) / 2)
    const y = Math.round((288 - h) / 2)
    this.safeCall(() => {
      this.session.display.clear()
      this.session.display.showBitmapView(base64Bmp, {x, y, width: w, height: h})
    })
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
