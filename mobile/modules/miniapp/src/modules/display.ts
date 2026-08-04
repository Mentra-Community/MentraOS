/**
 * @fileoverview DisplayManager — the glasses display, via `render()`.
 *
 * render(elements) is replace-the-frame scene rendering: each call describes
 * everything that should be on screen, the host diffs it against the previous
 * frame per device, and `render([])` clears. The legacy one-shot `show*`
 * layout methods were removed once nothing first-party or known-external
 * called them; hosts still accept the historical `miniapp_display` wire shape
 * from bundles packed with older SDKs.
 */

import {MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"

export type ViewType = "main" | "dashboard"

export type DisplayBreakMode = "character" | "character-no-hyphen" | "word" | "strict-word"

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

export class DisplayManager {
  constructor(private readonly session: MiniappSession) {}

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
