/**
 * @fileoverview DisplayManager — glasses display layouts.
 *
 * Mirrors cloud SDK v3's DisplayManager naming. Was called `LayoutManager` /
 * `session.layouts` before the v3-alignment round.
 *
 * Wire shape matches the cloud SDK's DisplayRequest:
 *
 *   { type: "DISPLAY",
 *     view: "main" | "dashboard",
 *     layout: { layoutType: "text_wall", text: "..." },
 *     durationMs?: number }
 *
 * The phone's LocalMiniappRuntime forwards this to BluetoothSdk.displayEvent,
 * which reads event.view and event.layout.layoutType.
 */

import {MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"

export type ViewType = "main" | "dashboard"

export type LayoutType =
  | "text_wall"
  | "double_text_wall"
  | "reference_card"
  | "dashboard_card"
  | "bitmap_view"
  | "positioned_text"
  | "clear_view"

export type DisplayBreakMode = "character" | "character-no-hyphen" | "word" | "strict-word"

export interface TextWall {
  layoutType: "text_wall"
  text: string
  breakMode?: DisplayBreakMode
}

export interface DoubleTextWall {
  layoutType: "double_text_wall"
  topText: string
  bottomText: string
  breakMode?: DisplayBreakMode
}

export interface ReferenceCard {
  layoutType: "reference_card"
  title: string
  text: string
  breakMode?: DisplayBreakMode
}

export interface DashboardCard {
  layoutType: "dashboard_card"
  leftText: string
  rightText: string
}

export interface BitmapView {
  layoutType: "bitmap_view"
  /** Base64-encoded PNG/JPEG. Phone SGC converts to glasses-native format. */
  data: string
  /** Top-left x of the target container on the 576×288 canvas. Omit for default placement. */
  x?: number
  /** Top-left y of the target container on the 576×288 canvas. Omit for default placement. */
  y?: number
  /** Target container width. On G2, width>200 (or height>100) renders in quad mode; otherwise a single positioned tile. */
  width?: number
  /** Target container height. */
  height?: number
}

export interface PositionedText {
  layoutType: "positioned_text"
  text: string
  /** Top-left x of the text container on the 576×288 canvas. Omit for default placement. */
  x?: number
  /** Top-left y of the text container on the 576×288 canvas. */
  y?: number
  /** Container width. */
  width?: number
  /** Container height. */
  height?: number
  /** Border stroke width (px). 0 = no border. */
  borderWidth?: number
  /** Border corner radius (px). */
  borderRadius?: number
}

export interface ClearView {
  layoutType: "clear_view"
}

export type Layout = TextWall | DoubleTextWall | ReferenceCard | DashboardCard | BitmapView | PositionedText | ClearView

// ============================================================================
// render() — the scene API
// ============================================================================

/** Pixel-space bounding box on the device's drawable canvas (see `capabilities.display`). */
export interface RenderBox {
  x: number
  y: number
  w: number
  h: number
}

export interface RenderTextStyle {
  /** Border width in px (0/absent = none). */
  border?: number
  /** Border corner radius in px. */
  radius?: number
  /** What happens to text that doesn't fit the box after wrapping. Default "clip". */
  overflow?: "clip" | "ellipsis"
  /** Line-break policy for wrapping (host wraps; the box carries pre-wrapped text). */
  breakMode?: DisplayBreakMode
}

export interface RenderRectStyle {
  border?: number
  radius?: number
}

/**
 * One element of a rendered scene. `id` is optional but recommended for
 * anything that updates over time: elements with a stable id update in place on
 * the glasses (no flicker); the host matches unnamed elements by geometry.
 */
export type RenderElement =
  | {type: "text"; id?: string; box: RenderBox; text: string; style?: RenderTextStyle}
  | {type: "image"; id?: string; box: RenderBox; data: string}
  | {type: "rect"; id?: string; box: RenderBox; style?: RenderRectStyle}

export interface RenderOptions {
  view?: ViewType
  /** Auto-clear after this many ms (same semantics as legacy display options). */
  durationMs?: number
}

/**
 * Outcome of a render request, resolved when the host's display arbitration
 * settles it. "displayed" = accepted and sent to the device — NOT a
 * render confirmation. "blocked" = another app owns the display (or the
 * request failed); `reason` says why.
 */
export interface RenderResult {
  status: "displayed" | "blocked"
  /** True when the host adjusted the scene (clamped boxes, dropped elements, degraded for the device). */
  degraded?: boolean
  /** Ids of elements the host dropped (budget/bounds/device limits) — dropped is never silent. */
  dropped?: string[]
  reason?: string
}

export interface DisplayOptions {
  view?: ViewType
  durationMs?: number
  breakMode?: DisplayBreakMode
}

export interface BitmapOptions extends DisplayOptions {
  /** Top-left x of the target container on the 576×288 canvas. */
  x?: number
  /** Top-left y of the target container on the 576×288 canvas. */
  y?: number
  /** Target container width. On G2, width>200 (or height>100) renders in quad mode; otherwise a single positioned tile. */
  width?: number
  /** Target container height. */
  height?: number
}

export interface TextAtOptions extends DisplayOptions {
  /** Top-left x of the text container on the 576×288 canvas. */
  x?: number
  /** Top-left y of the text container on the 576×288 canvas. */
  y?: number
  /** Container width. */
  width?: number
  /** Container height. */
  height?: number
  /** Border stroke width (px). 0 = no border. */
  borderWidth?: number
  /** Border corner radius (px). */
  borderRadius?: number
}

export class DisplayManager {
  constructor(private readonly session: MiniappSession) {}

  private send(layout: Layout, options: DisplayOptions = {}): void {
    const payloadLayout =
      options.breakMode && supportsBreakMode(layout) ? {...layout, breakMode: options.breakMode} : layout
    this.session.sendOneShot({
      type: MiniappRequestType.DISPLAY,
      view: options.view ?? "main",
      layout: payloadLayout,
      durationMs: options.durationMs,
    })
  }

  /** Show a single block of text filling the glasses display. */
  showTextWall(text: string, options: DisplayOptions = {}): void {
    this.send({layoutType: "text_wall", text}, options)
  }

  /** Two stacked text rows — top and bottom. */
  showDoubleTextWall(topText: string, bottomText: string, options: DisplayOptions = {}): void {
    this.send({layoutType: "double_text_wall", topText, bottomText}, options)
  }

  /** Reference card — title plus body text. */
  showReferenceCard(title: string, text: string, options: DisplayOptions = {}): void {
    this.send({layoutType: "reference_card", title, text}, options)
  }

  /** Dashboard card — two-column layout for sections that appear in the OS dashboard. */
  showDashboardCard(leftText: string, rightText: string): void {
    this.send({layoutType: "dashboard_card", leftText, rightText}, {view: "dashboard"})
  }

  /**
   * Show a bitmap. Phone SGC handles conversion to glasses-native format.
   *
   * Optional `x`/`y`/`width`/`height` position and size the bitmap's container.
   * Omit them for default placement
   *
   * @example
   * // 100×100 image pinned to the bottom-right of the 576×288 canvas
   * display.showBitmapView(base64Png, {x: 476, y: 188, width: 100, height: 100})
   */
  showBitmapView(data: string, options: BitmapOptions = {}): void {
    const {x, y, width, height, ...display} = options
    this.send({layoutType: "bitmap_view", data, x, y, width, height}, display)
  }

  /**
   * Show text inside a positioned container (G2 only). Unlike `showTextWall`,
   * which fills the whole view, this places the text at an arbitrary x/y with an
   * optional rounded border — e.g. a label next to a bitmap.
   *
   * @example
   * // Label pinned to the bottom-left of the 576×288 canvas, with a rounded border
   * display.showTextAt("TEST", {x: 0, y: 201, width: 120, height: 87, borderWidth: 2, borderRadius: 6})
   */
  showTextAt(text: string, options: TextAtOptions = {}): void {
    const {x, y, width, height, borderWidth, borderRadius, ...display} = options
    this.send({layoutType: "positioned_text", text, x, y, width, height, borderWidth, borderRadius}, display)
  }

  /** Clear the specified view. */
  clear(view: ViewType = "main"): void {
    this.send({layoutType: "clear_view"}, {view})
  }

  /**
   * Render a whole scene of positioned elements — replace-the-frame.
   *
   * Each call describes everything that should be on screen; the host diffs it
   * against the previous frame per device (elements with a stable `id` update
   * in place; elements you stop sending are removed). There is no lifecycle to
   * manage and no remove calls — `render([])` clears.
   *
   * Coordinates are raw pixels on the device's drawable canvas — read
   * `session.capabilities.display` (populated on the "ready" event) for the
   * real width/height and element budgets. Out-of-bounds boxes are clamped and
   * over-budget elements are dropped tail-first; both are reported via the
   * result, never silently.
   *
   * Awaiting is OPT-IN — a plain fire-and-forget call is fine. The returned
   * promise never rejects.
   *
   * @example
   * const result = await session.display.render([
   *   {type: "text",  id: "stats", box: {x: 12, y: 9, w: 200, h: 28}, text: "863 m  11 min"},
   *   {type: "image", id: "map",   box: {x: 335, y: 14, w: 150, h: 150}, data: mapPng},
   *   {type: "rect",  box: {x: 0, y: 0, w: 500, h: 220}, style: {radius: 4}},
   * ])
   * if (result.degraded) console.warn("dropped:", result.dropped)
   */
  render(elements: RenderElement[], options: RenderOptions = {}): Promise<RenderResult> {
    return this.session
      .sendRequest<RenderResult>({
        type: MiniappRequestType.RENDER,
        view: options.view ?? "main",
        elements,
        durationMs: options.durationMs,
      })
      .catch((err) => ({
        status: "blocked" as const,
        reason:
          typeof err === "object" && err !== null && "message" in err
            ? String((err as {message: unknown}).message)
            : String(err),
      }))
  }
}

function supportsBreakMode(layout: Layout): layout is TextWall | DoubleTextWall | ReferenceCard {
  return (
    layout.layoutType === "text_wall" ||
    layout.layoutType === "double_text_wall" ||
    layout.layoutType === "reference_card"
  )
}
