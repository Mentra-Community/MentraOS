/**
 * DisplayManager
 *
 * Thin imperative wrapper over `session.display.*`. Mirrors the SDK
 * module shape — short verbs that delegate to the underlying
 * DisplayManager. Callers decide when to push.
 */

import type {MiniappSession} from "@mentra/miniapp"
import {borderTestImageBase64, encodeBmpBase64} from "../lib/bmp"

// A solid-white 100×100 bitmap — pushed to the minimap rect to ERASE the
// minimap in place (the G2 reuses the same-rect container, overwriting it)
// instead of a full-view clear(). White blends into the map background.
const BLANK_MINIMAP_BMP = encodeBmpBase64(new Uint8Array(100 * 100).fill(255), 100, 100)

export class DisplayManager {
  constructor(private readonly session: MiniappSession) {}

  // ── Display sends ────────────────────────────────────────────────────
  // Sends are INSTANT — each show fires immediately, no spacing/throttle.
  // (We previously serialized text through a 200ms queue, but that's removed:
  // `enqueue` now just fires the thunk right away. The `box` key is kept in
  // the signature only so call sites read clearly and so a future throttle
  // could be reintroduced without touching them.)
  private enqueue(_box: string, fn: () => void): void {
    this.safeCall(fn)
  }

  /**
   * Single line filling the glasses display.
   * `durationMs` is forwarded to the SDK; if set, the message auto-clears
   * after that long. Omit for a sticky message that persists until replaced.
   */
  showText(text: string, durationMs?: number): void {
    this.enqueue("wall", () =>
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
    // Minimap goes through the SAME queue as the text boxes, keyed "minimap".
    // refreshHUD enqueues minimap → maneuver → stats in that order, so the G2
    // receives them in a fixed sequence ≥200ms apart (no cross-pipeline race).
    this.enqueue("minimap", () =>
      this.session.display.showBitmapView(base64Bmp, {x: 576 - 100, y: 0, width: 100, height: 100}),
    )
  }

  /**
   * Erase the minimap bitmap IN PLACE by overwriting its rect with a blank
   * white tile — same container the live minimap uses, so the G2 reuses it
   * (no full-view clear(), no async teardown race). Used when switching to the
   * large map: the large map is a different rect, so it wouldn't otherwise
   * overwrite the top-right minimap, which would linger.
   */
  clearMinimap(): void {
    this.safeCall(() =>
      this.session.display.showBitmapView(BLANK_MINIMAP_BMP, {x: 576 - 100, y: 0, width: 100, height: 100}),
    )
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
  // SINGLE-CONTAINER HUD: the whole frame (maneuver block + trip stats) is now
  // crammed into THIS one container, spanning the full canvas so all the lines
  // fit. There is no longer a separate stats box below it.
  private static readonly MANEUVER_REGION = {x: 0, y: 0, width: 576, height: 288}
  // Kept only so showTripStats()/showManeuver() signatures still resolve; the
  // single-container HUD routes everything through showManeuver now. Same rect
  // as MANEUVER_REGION so a stray stats push can't land in a different spot.
  private static readonly STATS_REGION = {x: 0, y: 0, width: 576, height: 288}

  /**
   * Maneuver / direction text in the TOP region of the canvas (its own G2 text
   * container), leaving the bottom region free for the stats container.
   */
  showManeuver(text: string): void {
    // Queued under "maneuver" — drains after "minimap", before "stats".
    this.enqueue("maneuver", () =>
      this.session.display.showTextAt(text, {...DisplayManager.MANEUVER_REGION}),
    )
  }

  /**
   * Transition status text in the TOP-LEFT maneuver region, shown IMMEDIATELY
   * (bypasses the 200ms text queue) — used for "Loading large map" / "Loading
   * main menu" while a swipe transition settles, so the user sees feedback in
   * the gap rather than a blank/stale screen. Bypasses the queue because it
   * must appear right at the swipe, before any HUD text, and the transition
   * clear() has just purged the queue anyway.
   */
  showLoadingMessage(text: string): void {
    this.safeCall(() => this.session.display.showTextAt(text, {...DisplayManager.MANEUVER_REGION}))
  }

  /** Blank the top-left loading message (overwrite its region with empty text). */
  clearLoadingMessage(): void {
    this.safeCall(() => this.session.display.showTextAt("", {...DisplayManager.MANEUVER_REGION}))
  }

  /**
   * Live trip-stats (distance + ETA) in the BOTTOM region, in its own G2 text
   * container stacked under the maneuver box.
   */
  showTripStats(text: string): void {
    // Queued under "stats" — drains last, after "minimap" and "maneuver".
    this.enqueue("stats", () =>
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
