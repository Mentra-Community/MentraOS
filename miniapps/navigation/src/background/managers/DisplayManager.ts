/**
 * DisplayManager
 *
 * Thin imperative wrapper over `session.display.*`. Mirrors the SDK
 * module shape — short verbs that delegate to the underlying
 * DisplayManager. Callers decide when to push.
 */

import type {MiniappSession, RenderElement} from "@mentra/miniapp"
import {borderTestImageBase64} from "../lib/bmp"

export class DisplayManager {
  constructor(private readonly session: MiniappSession) {}

  // ── Navigation HUD layout ────────────────────────────────────────────
  // Boxes on the 500×220 Mentra canvas, from the nav HUD mockup: a map bitmap
  // on the right, a turn-arrow bitmap on the left, trip stats along the top,
  // and the maneuver instruction below the arrow. The firmware draws the outer
  // rounded frame itself, so we only send these content slots. `message` shares
  // the arrow's left x and spans the content area (staying clear of the map).
  static readonly HUD = {
    // Map dropped below the top row so the top-right stats slot clears it
    // (the mockup stacks time+ETA across the top with the map underneath).
    map: {x: 330, y: 70, w: 150, h: 150},
    arrow: {x: 0, y: 182, w: 38, h: 38},
    // Wall-clock current time, top-LEFT (the phone's clock, sent each refresh).
    // The widest 24-hour clock is 52px in the G2 font, and native adds 4px of
    // padding on each side. Keep a little extra headroom so it never wraps into
    // a clipped second line.
    clock: {x: 0, y: 0, w: 64, h: 26},
    // Trip stats (distance remaining + ETA), top-RIGHT — mirrors the clock.
    // No text alignment primitive exists, so the box is positioned right and
    // the (short) text left-aligns within it. One firmware text line tall — the
    // fw font line is ~30px+, so a 28px box always overflowed (suspected trigger
    // of the firmware's scroll-indicator tick). 40px fits one line with headroom.
    stats: {x: 359, y: 0, w: 121, h: 28},
    // Two full 40px G2 lines (lineHeightPx calibration clips to floor(h/40)
    // lines — 64px was silently clipping the street name to one line).
    maneuver: {x: 40, y: 168, w: 270, h: 52},
    message: {x: 12, y: 54, w: 310, h: 156},
  }

  // ── HUD frame state ──────────────────────────────────────────────────
  // render() replaces the whole frame, so this class caches the CONTENT of
  // each slot (the arrow/map bitmaps are expensive to produce, not to resend —
  // the host diffs frames and unchanged elements never re-cross BLE) and
  // composes the full scene on every push. No element lifecycle, no removes:
  // what's on screen is exactly what buildFrame() returns.
  private mode: "hud" | "message" | null = null
  private arrowBmp: string | null = null
  private mapBmp: string | null = null
  private clock: string | null = null
  private stats: string | null = null
  private maneuver: string | null = null
  private message: string | null = null

  private buildFrame(): RenderElement[] {
    const els: RenderElement[] = []
    if (this.mode === "hud") {
      if (this.arrowBmp) els.push({type: "image", id: "arrow", box: DisplayManager.HUD.arrow, data: this.arrowBmp})
      if (this.maneuver != null)
        els.push({type: "text", id: "maneuver", box: DisplayManager.HUD.maneuver, text: this.maneuver})
      if (this.stats != null) els.push({type: "text", id: "stats", box: DisplayManager.HUD.stats, text: this.stats})
    } else if (this.mode === "message" && this.message != null) {
      els.push({type: "text", id: "message", box: DisplayManager.HUD.message, text: this.message})
    }
    // The clock (top-left) and minimap ride along in both modes.
    if (this.clock != null) els.push({type: "text", id: "clock", box: DisplayManager.HUD.clock, text: this.clock})
    if (this.mapBmp) els.push({type: "image", id: "map", box: DisplayManager.HUD.map, data: this.mapBmp})
    return els
  }

  private pushFrame(): void {
    this.safeCall(() => void this.session.display.render(this.buildFrame()))
  }

  /**
   * Turn-by-turn HUD frame: arrow bitmap (left), maneuver text (bottom), trip
   * stats (top) — plus the cached minimap. Fields set to a value (including
   * null) overwrite that slot; omitted fields keep their cached content, so the
   * caller only re-encodes the arrow BMP when the direction changes.
   */
  showNavHud(frame: {arrowBmp?: string; stats?: string | null; maneuver?: string | null; clock?: string | null}): void {
    this.mode = "hud"
    if (frame.arrowBmp !== undefined) this.arrowBmp = frame.arrowBmp
    if (frame.stats !== undefined) this.stats = frame.stats
    if (frame.maneuver !== undefined) this.maneuver = frame.maneuver
    if (frame.clock !== undefined) this.clock = frame.clock
    this.pushFrame()
  }

  /**
   * Single-message state (welcome / "Starting…" / rerouting / arrived): the
   * whole frame becomes the message (plus minimap). Turn-by-turn slots simply
   * stop being rendered — render() replaces the frame, nothing to remove.
   */
  showNavMessage(text: string, clock?: string | null): void {
    this.mode = "message"
    this.message = text
    if (clock !== undefined) this.clock = clock
    this.pushFrame()
  }

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
    this.enqueue(
      "wall",
      () =>
        void this.session.display.render(
          [{type: "text", id: "wall", box: {x: 0, y: 0, w: 576, h: 288}, text}],
          durationMs != null ? {durationMs} : undefined,
        ),
    )
  }

  showTextTest(): void {
    this.showText(
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Donec venenatis vulputate lorem. Maecenas vestibulum mollis diam. Pellentesque ut neque. Sed lectus. Donec sodales sagittis magna.",
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
    // The minimap is the "map" slot of the HUD frame — refreshMinimap runs on
    // its own async cadence, so it updates the cache and re-pushes whatever
    // frame is current (host diff keeps unchanged slots off BLE).
    this.mapBmp = base64Bmp
    this.pushFrame()
  }

  /**
   * Drop the minimap slot (e.g. when switching to the swipe-up large map, which
   * renders at a different rect).
   */
  clearMinimap(): void {
    this.mapBmp = null
    this.pushFrame()
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
    // Clear first, wait 1s so old containers tear down, THEN draw the box.
    this.safeCall(() => void this.session.display.render([]))
    setTimeout(() => {
      this.renderCenteredBitmap(base64Bmp, x, y, w, h)
    }, 1000)
  }

  /** One centered image element as the whole frame (test/large-map paths). */
  private renderCenteredBitmap(data: string, x: number, y: number, w: number, h: number): void {
    this.safeCall(() => void this.session.display.render([{type: "image", id: "bmp", box: {x, y, w, h}, data}]))
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
    this.renderCenteredBitmap(base64Bmp, x, y, w, h)
  }

  // ── Two stacked text containers ──────────────────────────────────────
  // The G2's single full-screen (576×288) text wall only fits ~5 lines. To get
  // more usable vertical text we split into two stacked positioned-text
  // containers: maneuver/directions on top, trip stats below.
  // SINGLE-CONTAINER HUD: the whole frame (maneuver block + trip stats) is now
  // crammed into THIS one container, spanning the full canvas so all the lines
  // fit. There is no longer a separate stats box below it.
  // Full 500×220 Mentra canvas — used by the single-container states
  // (welcome / rerouting / arrived / off-route), which don't use the 4-slot split.
  private static readonly MANEUVER_REGION = {x: 0, y: 0, width: 500, height: 220}

  /**
   * Single full-canvas message element shared by the single-container states
   * (maneuver text, loading messages, trip stats). One stable id + one
   * geometry means every push is a content-only update — the same last-wins
   * behavior as the positioned_text sends it replaces. Replaces the whole
   * frame; these states never coexist with the 4-slot HUD.
   */
  private renderRegionText(text: string): void {
    const r = DisplayManager.MANEUVER_REGION
    void this.session.display.render([{type: "text", id: "msg", box: {x: r.x, y: r.y, w: r.width, h: r.height}, text}])
  }

  /**
   * Maneuver / direction text in the TOP region of the canvas (its own G2 text
   * container), leaving the bottom region free for the stats container.
   */
  showManeuver(text: string): void {
    // Queued under "maneuver" — drains after "minimap", before "stats".
    this.enqueue("maneuver", () => this.renderRegionText(text))
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
    this.safeCall(() => this.renderRegionText(text))
  }

  /** Blank the top-left loading message (overwrite its region with empty text). */
  clearLoadingMessage(): void {
    this.safeCall(() => this.renderRegionText(""))
  }

  /**
   * Live trip-stats (distance + ETA) in the BOTTOM region, in its own G2 text
   * container stacked under the maneuver box.
   */
  showTripStats(text: string): void {
    // Queued under "stats" — drains last, after "minimap" and "maneuver".
    // STATS_REGION === MANEUVER_REGION (single-container HUD), so this rides
    // the same shared message element.
    this.enqueue("stats", () => this.renderRegionText(text))
  }

  /**
   * Test-only: clear the view, then render a 288x288 bitmap centered on the
   * 576x288 canvas (x=144). Used by the dev panel's "Send test bitmap" button
   * to verify the bitmap pipeline in isolation — no maneuver text competing.
   */
  showBitmapTest(base64Bmp: string): void {
    // render() replaces the whole frame — no separate clear needed.
    this.renderCenteredBitmap(base64Bmp, 144, 0, 288, 288)
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
      console.log(`[NAV-MINI] bitmap width ${size} > 200 — G2 SGC tiles it across multiple containers`)
    }
    const base64Bmp = borderTestImageBase64(w, h)
    const x = Math.round((576 - w) / 2)
    const y = Math.round((288 - h) / 2)
    // Clear first, wait 3s so the old container fully tears down, THEN draw the
    // new bitmap — avoids the G2 reusing/overlapping a stale image container.
    this.safeCall(() => void this.session.display.render([]))
    setTimeout(() => {
      this.renderCenteredBitmap(base64Bmp, x, y, w, h)
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
    // Stable id + unchanged rect ⇒ the differ marks this a content-only update
    // and the G2 swaps the bitmap into the existing container in place — the
    // same no-flicker behavior the old rect-keyed container reuse gave.
    this.renderCenteredBitmap(base64Bmp, x, y, w, h)
  }

  /** Wipe whatever's on the glasses (and forget the cached frame slots). */
  clear(): void {
    this.mode = null
    this.arrowBmp = null
    this.mapBmp = null
    this.clock = null
    this.stats = null
    this.maneuver = null
    this.message = null
    this.safeCall(() => void this.session.display.render([]))
  }

  private safeCall(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      console.log("[NAV-MINI] display call ignored:", err)
    }
  }
}
