/**
 * DisplayManager
 *
 * Thin imperative wrapper over `session.display.*`. Mirrors the SDK
 * module shape — short verbs that delegate to the underlying
 * DisplayManager. Callers decide when to push.
 */

import type {MiniappSession, RenderElement} from "@mentra/miniapp"
import {borderTestImageBase64} from "../lib/bmp"
import {readGlassesCapabilities} from "../lib/capabilities"

export class DisplayManager {
  constructor(private readonly session: MiniappSession) {}

  private get bitmapLimits() {
    const display = this.session.capabilities?.display
    const dimension = (value: unknown, fallback: number) =>
      typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback
    const width = dimension(display?.width, 576)
    const height = dimension(display?.height, 288)
    return {
      width,
      height,
      maxWidth: display?.maxImageElements === 0 ? 0 : Math.min(width, dimension(display?.maxImagePx?.width, width)),
      maxHeight: display?.maxImageElements === 0 ? 0 : Math.min(height, dimension(display?.maxImagePx?.height, height)),
    }
  }

  /** Whether the selected display can show a positioned bitmap. */
  get supportsBitmaps(): boolean {
    const {maxWidth, maxHeight} = this.bitmapLimits
    return this.session.capabilities?.display?.canPosition !== false && maxWidth > 0 && maxHeight > 0
  }

  /** Choose raster dimensions before encoding, using the same limits as placement. */
  getBitmapSize(width = 288, height = 140): {w: number; h: number} {
    const {maxWidth, maxHeight} = this.bitmapLimits
    const w = Math.min(width, maxWidth)
    const h = Math.min(height, maxHeight)
    this.bitmapBox(w, h)
    return {w, h}
  }

  private bitmapBox(w: number, h: number): {x: number; y: number; w: number; h: number} {
    const {width, height, maxWidth, maxHeight} = this.bitmapLimits
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 || w > maxWidth || h > maxHeight) {
      throw new RangeError(`Bitmap ${w}x${h} is unsupported; maximum image size is ${maxWidth}x${maxHeight}`)
    }
    return {x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h}
  }

  // ── Navigation HUD layout ────────────────────────────────────────────
  // Boxes on the 500×220 Mentra canvas, from the nav HUD mockup: a map bitmap
  // on the right, a turn-arrow bitmap on the left, trip stats along the top,
  // and the maneuver instruction below the arrow. The firmware draws the outer
  // rounded frame itself, so we only send these content slots. `message` shares
  // the arrow's left x and spans the content area (staying clear of the map).
  static readonly HUD = {
    // Keep the map below the two-line stats region. Both regions meet at y=80
    // without overlapping and still fit the 220px-tall HUD canvas exactly.
    map: {x: 340, y: 80, w: 140, h: 140},
    arrow: {x: 0, y: 182, w: 38, h: 38},
    // Wall-clock current time, top-LEFT (the phone's clock, sent each refresh).
    // The widest 24-hour clock is 52px in the G2 font, and native adds 4px of
    // padding on each side. Keep a little extra headroom so it never wraps into
    // a clipped second line.
    clock: {x: 0, y: 0, w: 64, h: 40},
    // Long distance + ETA strings can wrap. Give the top-right stats region
    // two full calibrated G2 lines instead of letting a second line overflow a
    // 28px box. The wider box also keeps the common case on one line.
    stats: {x: 280, y: 0, w: 200, h: 80},
    // The body contains a distance line plus an instruction that may itself
    // wrap (for example, "Turn right onto Gough Street"). G2 clips by
    // floor(height / 40px), so reserve three complete lines; the old 52px box
    // admitted only the distance and silently removed the instruction.
    maneuver: {x: 40, y: 100, w: 270, h: 120},
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
      els.push({
        type: "text",
        id: "message",
        box: DisplayManager.HUD.message,
        text: this.message,
        ...(readGlassesCapabilities(this.session.capabilities).canPosition
          ? {style: {breakMode: "word" as const}}
          : {}),
      })
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

  /**
   * Navigation frame for non-positioning displays such as Even Realities G1.
   * Keep the maneuver first and emit one text element: host-side scene
   * degradation otherwise inserts blank lines between the positioned clock,
   * stats, and maneuver elements, pushing the instruction past G1's five-line
   * limit. Images and clock are deliberately cleared because these displays
   * cannot render them through the scene API.
   */
  showCompactNavHud(maneuver: string, stats: string | null): void {
    this.mode = "message"
    this.message = [maneuver, stats].filter(Boolean).join("\n\n")
    this.clock = null
    this.mapBmp = null
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
    const {width: w, height: h} = this.bitmapLimits
    this.enqueue(
      "wall",
      () =>
        void this.session.display.render(
          [{type: "text", id: "wall", box: {x: 0, y: 0, w, h}, text}],
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
   * Swipe test box centered on the advertised canvas. Reject unsupported
   * sizes before clearing, so a diagnostic cannot silently blank the display.
   */
  showTestBox(width: number, height: number): void {
    const {w, h} = this.bitmapBox(width, height)
    const base64Bmp = borderTestImageBase64(w, h)
    // Clear first, wait 1s so old containers tear down, THEN draw the box.
    this.safeCall(() => void this.session.display.render([]))
    setTimeout(() => {
      this.renderCenteredBitmap(base64Bmp, w, h)
    }, 1000)
  }

  /** One centered image element as the whole frame (test/large-map paths). */
  private renderCenteredBitmap(data: string, w: number, h: number): void {
    const box = this.bitmapBox(w, h)
    this.safeCall(() => void this.session.display.render([{type: "image", id: "bmp", box, data}]))
  }

  /**
   * Large map shown on swipe-up. Call getBitmapSize before rasterizing;
   * silently clamping only the box would disagree with the encoded image.
   */
  showLargeBitmap(base64Bmp: string, width = 288, height = 140): void {
    this.renderCenteredBitmap(base64Bmp, width, height)
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
   * Fixed 288x288 diagnostic asset. Reports an unsupported size on displays
   * whose image or canvas limits cannot accommodate it; it is not resized.
   */
  showBitmapTest(base64Bmp: string): void {
    // render() replaces the whole frame — no separate clear needed.
    this.renderCenteredBitmap(base64Bmp, 288, 288)
  }

  /**
   * Test-only: render a bordered bitmap at the exact requested size, centered
   * on the device canvas. Unsupported probes fail before clearing the frame.
   */
  showBitmapSize(size: number, height?: number): void {
    const {w, h} = this.bitmapBox(size, height ?? size)
    const base64Bmp = borderTestImageBase64(w, h)
    // Clear first, wait 3s so the old container fully tears down, THEN draw the
    // new bitmap — avoids the G2 reusing/overlapping a stale image container.
    this.safeCall(() => void this.session.display.render([]))
    setTimeout(() => {
      this.renderCenteredBitmap(base64Bmp, w, h)
    }, 3000)
  }

  /**
   * Test-only: show a pre-rendered base64 BMP at a given container size,
   * centered within device limits. Used by the OSM line-map PoC.
   */
  showRawBitmap(base64Bmp: string, width: number, height: number): void {
    // Stable id + unchanged rect ⇒ the differ marks this a content-only update
    // and the G2 swaps the bitmap into the existing container in place — the
    // same no-flicker behavior the old rect-keyed container reuse gave.
    this.renderCenteredBitmap(base64Bmp, width, height)
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
