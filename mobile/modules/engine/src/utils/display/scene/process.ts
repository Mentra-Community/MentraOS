/**
 * Scene processing — validate → clamp → budget → wrap. Everything here is
 * generic; device variation enters only through the capabilities block and the
 * display profile (data, not code). Spec §5.
 *
 * Never rejects a frame: offending elements are dropped per-element and
 * reported via `dropped` / `degraded` (design doc §3.4.6; spec §4 refines the
 * design doc's image "reject" to per-element drop).
 */

import {TextMeasurer} from "../measurer/TextMeasurer"
import {TextWrapper} from "../wrapper/TextWrapper"
import type {DisplayProfile} from "../profiles/types"
import type {DiffableElement} from "./differ"
import type {SceneBox, SceneDisplayCapabilities, SceneElementInput, SceneListStyle, SceneTextStyle} from "./types"
import {elementContentHash} from "./types"

/**
 * Longest row a native list renders (G2 clips longer rows in-box; the cap keeps
 * a runaway string from bloating the page-create packet). Device-independent:
 * a list row is a menu label, not a paragraph.
 */
const MAX_LIST_ITEM_CHARS = 64

/**
 * Rows for a native list: strings only, one line each, at most `maxItems`.
 * Returns the rows plus whether anything was dropped or clipped (⇒ degraded).
 */
export function normalizeListItems(items: unknown, maxItems: number): {rows: string[]; degraded: boolean} {
  if (!Array.isArray(items)) return {rows: [], degraded: true}
  let degraded = false
  const rows: string[] = []
  for (const raw of items) {
    if (rows.length >= maxItems) {
      degraded = true
      break
    }
    if (typeof raw !== "string") {
      degraded = true
      continue
    }
    // A row is one firmware line; an embedded newline would desync the wire
    // encoding's row count from what the glasses draw.
    let row = raw.replace(/[\r\n]+/g, " ")
    if (row.length > MAX_LIST_ITEM_CHARS) {
      row = row.slice(0, MAX_LIST_ITEM_CHARS)
      degraded = true
    }
    // The firmware treats an empty row string as "no row" — keep the slot visible.
    rows.push(row.length === 0 ? " " : row)
  }
  return {rows, degraded}
}

export interface ProcessedScene {
  elements: DiffableElement[]
  degraded: boolean
  dropped: string[]
}

/** Reporting id for an element the app may not have named. */
function reportId(el: SceneElementInput, index: number): string {
  return el.id ?? `${el.type}[${index}]`
}

function clampBox(box: SceneBox, width: number, height: number): SceneBox | null {
  const x1 = Math.max(0, Math.floor(box.x))
  const y1 = Math.max(0, Math.floor(box.y))
  const x2 = Math.min(width, Math.floor(box.x) + Math.max(0, Math.floor(box.w)))
  const y2 = Math.min(height, Math.floor(box.y) + Math.max(0, Math.floor(box.h)))
  if (x2 <= x1 || y2 <= y1) return null
  return {x: x1, y: y1, w: x2 - x1, h: y2 - y1}
}

function boxShrunk(orig: SceneBox, clamped: SceneBox): boolean {
  return (
    clamped.x !== Math.floor(orig.x) ||
    clamped.y !== Math.floor(orig.y) ||
    clamped.w !== Math.floor(orig.w) ||
    clamped.h !== Math.floor(orig.h)
  )
}

/**
 * Line height for box-height→line-count math — ONLY when the profile declares
 * a calibrated `lineHeightPx`. Deriving one from full-canvas numbers proved
 * wrong on hardware (288/8=36px clipped the G2 nav instruction to one line;
 * the real container line height is smaller). Without calibration we return
 * null and the wrap step skips host-side height clipping entirely — text wraps
 * to the box WIDTH and the firmware clips vertically in-box, which is exactly
 * the legacy behavior.
 */
export function profileLineHeightPx(profile: DisplayProfile, _canvasHeight: number): number | null {
  return profile.lineHeightPx ?? null
}

/**
 * Process a raw scene against a device's capabilities + profile. Output is
 * diff-ready (text pre-wrapped, boxes clamped, content hashed) and reflects
 * exactly what will be sent — the diff baseline is post-processed by design
 * (spec §4).
 */
export function processScene(
  input: readonly SceneElementInput[],
  caps: SceneDisplayCapabilities,
  profile: DisplayProfile,
): ProcessedScene {
  const dropped: string[] = []
  let degraded = false

  const measurer = new TextMeasurer(profile)
  const wrapper = new TextWrapper(measurer)
  const lineHeight = profileLineHeightPx(profile, caps.height)

  // Validate + dedupe explicit ids (first occurrence wins; dupes are dev error).
  const seenIds = new Set<string>()
  const valid: {el: SceneElementInput; index: number}[] = []
  input.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || !raw.box) {
      dropped.push(reportId(raw ?? ({type: "text"} as SceneElementInput), index))
      degraded = true
      return
    }
    // Non-finite box numbers (NaN/±Infinity/non-number) would survive the
    // Math.* clamp below and poison the frame all the way to native ints.
    const b = raw.box
    if (![b.x, b.y, b.w, b.h].every((n) => typeof n === "number" && Number.isFinite(n))) {
      dropped.push(reportId(raw, index))
      degraded = true
      return
    }
    // Leading "~" is the differ's synthetic-id namespace — an app id there
    // would never match across frames (re-created every push). Normalize by
    // stripping; the rewrite is deterministic, so diffing stays stable.
    const el = raw.id?.startsWith("~") ? {...raw, id: raw.id.replace(/^~+/, "") || undefined} : raw
    if (el.id) {
      const key = `${el.type}:${el.id}`
      if (seenIds.has(key)) {
        dropped.push(reportId(el, index))
        degraded = true
        return
      }
      seenIds.add(key)
    }
    valid.push({el, index})
  })

  // Clamp + per-type limits, then budget in array order.
  let textBudget = caps.maxTextElements
  let imageBudget = caps.maxImageElements
  let listBudget = caps.maxListElements
  const out: DiffableElement[] = []

  for (const {el: raw, index} of valid) {
    let el = raw
    const clamped = clampBox(el.box, caps.width, caps.height)
    if (!clamped) {
      dropped.push(reportId(el, index))
      degraded = true
      continue
    }
    const shrunk = boxShrunk(el.box, clamped)
    if (shrunk) degraded = true

    if (el.type === "image") {
      // Images: a shrunk box can't be honored (we don't crop pixels host-side)
      // and per-image device limits are box-level (the firmware allocates the
      // component from the box). SGCs scale pixels to the box (phone-side
      // scaling — never on glasses).
      if (shrunk) {
        dropped.push(reportId(el, index))
        continue
      }
      if (caps.maxImagePx && (clamped.w > caps.maxImagePx.width || clamped.h > caps.maxImagePx.height)) {
        dropped.push(reportId(el, index))
        degraded = true
        continue
      }
      if (imageBudget <= 0) {
        dropped.push(reportId(el, index))
        degraded = true
        continue
      }
      imageBudget--
      out.push({
        id: el.id,
        type: "image",
        box: clamped,
        data: el.data,
        contentHash: elementContentHash({type: "image", data: el.data}),
      })
      continue
    }

    if (el.type === "list") {
      // The row cap is a native-widget limit; an emulated list is bounded by
      // its text box instead (the wrap step clips it like any text element).
      const rowCap = caps.maxListElements > 0 ? Math.max(0, caps.maxListItems) : Number.POSITIVE_INFINITY
      const {rows, degraded: rowsDegraded} = normalizeListItems(el.items, rowCap)
      if (rowsDegraded) degraded = true
      if (rows.length === 0) {
        dropped.push(reportId(el, index))
        degraded = true
        continue
      }
      if (listBudget > 0) {
        listBudget--
        out.push({
          id: el.id,
          type: "list",
          box: clamped,
          items: rows,
          style: el.style,
          contentHash: elementContentHash({type: "list", items: rows, style: el.style}),
        })
        continue
      }
      // No native list slot (the device has none, or the frame already used
      // its budget): keep the content by rendering the rows as one text
      // element. Row selection is lost, so this is always reported.
      degraded = true
      const style: SceneListStyle = el.style ?? {}
      const textStyle: SceneTextStyle = {}
      if (style.border !== undefined) textStyle.border = style.border
      if (style.radius !== undefined) textStyle.radius = style.radius
      el = {
        type: "text",
        id: el.id,
        box: el.box,
        text: rows.join("\n"),
        ...(Object.keys(textStyle).length ? {style: textStyle} : {}),
      }
    }

    // text + rect share the text-container budget (design doc §3.4.6).
    if (textBudget <= 0) {
      dropped.push(reportId(el, index))
      degraded = true
      continue
    }
    textBudget--

    if (el.type === "rect") {
      out.push({
        id: el.id,
        type: "rect",
        box: clamped,
        style: el.style,
        contentHash: elementContentHash({type: "rect", style: el.style}),
      })
      continue
    }

    // Text: wrap on the phone into the (clamped) box. The box then carries
    // pre-wrapped text; firmware in-box wrap is a fallback, not the mechanism.
    // Height clipping only applies with a CALIBRATED line height — otherwise
    // the firmware clips vertically in-box (legacy behavior).
    const style: SceneTextStyle = el.style ?? {}
    const maxLines = lineHeight ? Math.max(1, Math.floor(clamped.h / lineHeight)) : profile.maxLines
    const result = wrapper.wrap(el.text ?? "", {
      maxWidthPx: clamped.w,
      maxLines,
      ...(style.breakMode ? {breakMode: style.breakMode} : {}),
    })
    let lines = result.lines
    if (result.truncated) {
      degraded = true
      if (style.overflow === "ellipsis" && lines.length > 0) {
        // Trim the last line until it fits WITH the ellipsis appended —
        // otherwise the extra glyph can overflow the clamped box width.
        let last = lines[lines.length - 1]
        while (last.length > 0 && !measurer.fitsInWidth(`${last}…`, clamped.w)) {
          last = last.slice(0, -1)
        }
        // A box narrower than the ellipsis glyph itself gets an empty line —
        // never emit a line wider than the clamped box.
        const ellipsized = last.length > 0 || measurer.fitsInWidth("…", clamped.w) ? `${last}…` : ""
        lines = [...lines.slice(0, -1), ellipsized]
      }
    }
    const wrappedText = lines.join("\n")
    out.push({
      id: el.id,
      type: "text",
      box: clamped,
      text: wrappedText,
      style: el.style,
      contentHash: elementContentHash({type: "text", text: wrappedText, style: el.style}),
    })
  }

  return {elements: out, degraded, dropped}
}
