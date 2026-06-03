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
 * The phone's LocalMiniappRuntime forwards this to CoreModule.displayEvent,
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
  | "clear_view"

export interface TextWall {
  layoutType: "text_wall"
  text: string
}

export interface DoubleTextWall {
  layoutType: "double_text_wall"
  topText: string
  bottomText: string
}

export interface ReferenceCard {
  layoutType: "reference_card"
  title: string
  text: string
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

export interface ClearView {
  layoutType: "clear_view"
}

export type Layout =
  | TextWall
  | DoubleTextWall
  | ReferenceCard
  | DashboardCard
  | BitmapView
  | ClearView

export interface DisplayOptions {
  view?: ViewType
  durationMs?: number
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

export class DisplayManager {
  constructor(private readonly session: MiniappSession) {}

  private send(layout: Layout, options: DisplayOptions = {}): void {
    this.session.sendOneShot({
      type: MiniappRequestType.DISPLAY,
      view: options.view ?? "main",
      layout,
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

  /** Clear the specified view. */
  clearView(view: ViewType = "main"): void {
    this.send({layoutType: "clear_view"}, {view})
  }
}
