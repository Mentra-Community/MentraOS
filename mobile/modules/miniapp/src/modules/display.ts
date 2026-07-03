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
  | "remove_element"

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
  /** Retained-mode element id. Re-sending the same id updates that element in place;
   * a new id creates one. Set automatically by `drawLayout`. */
  id?: string
  /** Layout/scene id this element belongs to. Set automatically by `drawLayout`. */
  layoutId?: string
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
  /** Retained-mode element id. Re-sending the same id updates that element in place;
   * a new id creates one. Set automatically by `drawLayout`. */
  id?: string
  /** Layout/scene id this element belongs to. Set automatically by `drawLayout`. */
  layoutId?: string
}

export interface ClearView {
  layoutType: "clear_view"
}

/**
 * Remove a single retained element (by id) from the current layout. Emitted on
 * the wire by `drawLayout` (from a `{op: "remove", id}` entry) and by
 * `removeElement`. The SGC deletes the element's canvas component; other
 * elements are untouched.
 */
export interface RemoveElement {
  layoutType: "remove_element"
  /** id of the element to remove. */
  id: string
  /** Layout/scene id the element belongs to (optional; SGC falls back to the active layout). */
  layoutId?: string
}

export type Layout =
  | TextWall
  | DoubleTextWall
  | ReferenceCard
  | DashboardCard
  | BitmapView
  | PositionedText
  | ClearView
  | RemoveElement

/** A drawable element inside a {@link LayoutSpec}, tagged with a stable retained-mode id. */
export type LayoutElement = (BitmapView | PositionedText) & {id: string}

/** An in-array remove instruction for {@link LayoutSpec.elements}. */
export interface RemoveOp {
  op: "remove"
  id: string
}

/**
 * A whole layout / scene: a stable `id` plus its elements. Sending a layout
 * with a NEW id clears the previously-shown layout first; re-sending the SAME
 * id diffs by element id (create / update in place). Elements you omit are left
 * untouched — remove them explicitly with a `{op: "remove", id}` entry.
 */
export interface LayoutSpec {
  id: string
  elements: (LayoutElement | RemoveOp)[]
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
    this.send(
      {layoutType: "positioned_text", text, x, y, width, height, borderWidth, borderRadius},
      display,
    )
  }

  /** Clear the specified view. */
  clear(view: ViewType = "main"): void {
    this.send({layoutType: "clear_view"}, {view})
  }

  /**
   * Draw a whole layout / scene in one call — retained-mode with element ids.
   *
   * `layout.id` names the scene; each element carries a stable `id`. The SGC
   * diffs against what's on the glasses:
   *   • a NEW `layout.id` clears the previously-shown layout first;
   *   • same `layout.id`, same element `id` → update that element in place;
   *   • same `layout.id`, new element `id` → create it;
   *   • an omitted element is left untouched — remove it explicitly with a
   *     `{op: "remove", id}` entry (or {@link removeElement}).
   *
   * All the create/update/remove/clear logic runs on the SGC; this just sends
   * each element tagged with the layout + element ids.
   *
   * @example
   * display.drawLayout({
   *   id: "nav-hud",
   *   elements: [
   *     {id: "map",   layoutType: "bitmap_view",     data: mapPng,   x: 335, y: 14,  width: 150, height: 150},
   *     {id: "arrow", layoutType: "bitmap_view",     data: arrowPng, x: 12,  y: 116, width: 38,  height: 38},
   *     {id: "stats", layoutType: "positioned_text", text: "863 m  11 min", x: 12, y: 9, width: 200, height: 28},
   *     {op: "remove", id: "maneuver"},
   *   ],
   * })
   */
  drawLayout(layout: LayoutSpec, options: DisplayOptions = {}): void {
    for (const el of layout.elements) {
      if ("op" in el && el.op === "remove") {
        this.send({layoutType: "remove_element", id: el.id, layoutId: layout.id}, options)
      } else {
        // el is a BitmapView|PositionedText (both Layout members) with a required
        // id; adding the optional layoutId keeps it a valid Layout. The cast just
        // sidesteps TS's union-spread widening.
        this.send({...el, layoutId: layout.id} as Layout, options)
      }
    }
  }

  /**
   * Remove a single retained element by id from the current layout. Other
   * elements are untouched. `layoutId` is optional — the SGC falls back to the
   * active layout.
   */
  removeElement(id: string, layoutId?: string, options: DisplayOptions = {}): void {
    this.send({layoutType: "remove_element", id, layoutId}, options)
  }
}

function supportsBreakMode(layout: Layout): layout is TextWall | DoubleTextWall | ReferenceCard {
  return layout.layoutType === "text_wall" || layout.layoutType === "double_text_wall" || layout.layoutType === "reference_card"
}
