/**
 * Degrade — compile a scene for devices that can't position elements
 * (`canPosition: false`: G1, Z100). Output is a LEGACY layout that rides the
 * existing display path — DisplayProcessor wraps it there, exactly as today,
 * which is what keeps sugar byte-identical on old hardware (spec §2/§5:
 * degrade output must be UNWRAPPED; wrapping twice breaks the goldens).
 *
 * Rules (design doc §3.4.8): content-preserving, never-erroring,
 * honestly-reported. Text collapses in reading order (y, then x) joined by
 * blank lines; EXACTLY two text elements sharing a y-range with disjoint
 * x-ranges become a double_text_wall (ColumnComposer path downstream); rects
 * drop silently (decoration); images drop + report.
 */

import {TextMeasurer} from "../measurer/TextMeasurer"
import type {DisplayProfile} from "../profiles/types"
import {processText} from "./text"
import type {SceneTextLayout, SceneDisplayCapabilities} from "./types"
import type {SceneElementInput} from "./types"

export interface DegradedScene {
  /** Legacy layout for the existing display path, or null for an empty scene (caller clears). */
  layout: {layoutType: string; [key: string]: unknown} | null
  degraded: boolean
  dropped: string[]
  prewrapped?: boolean
  textLayout?: Record<string, SceneTextLayout>
}

type TextEl = Extract<SceneElementInput, {type: "text"}>

function yOverlap(a: TextEl, b: TextEl): boolean {
  return a.box.y < b.box.y + b.box.h && b.box.y < a.box.y + a.box.h
}

function xDisjoint(a: TextEl, b: TextEl): boolean {
  return a.box.x + a.box.w <= b.box.x || b.box.x + b.box.w <= a.box.x
}

export function degradeScene(input: readonly SceneElementInput[]): DegradedScene {
  const dropped: string[] = []
  let degraded = false

  const texts: TextEl[] = []
  input.forEach((el, index) => {
    if (!el || typeof el !== "object" || !el.box) {
      // Malformed element — report it like the positioning pipeline does
      // instead of silently pretending the render was clean.
      dropped.push((el as {id?: string} | null)?.id ?? `element[${index}]`)
      degraded = true
      return
    }
    if (el.type === "text") {
      texts.push(el)
    } else if (el.type === "image") {
      dropped.push(el.id ?? `image[${index}]`)
      degraded = true
    }
    // rects: silent drop — pure decoration on a text wall.
  })

  if (texts.length === 0) {
    return {layout: null, degraded, dropped}
  }

  // Row exception: exactly 2 columns with clean separation — the shipped
  // double_text_wall mechanism (scope guard: nothing fancier; this is NOT a
  // layout engine).
  if (texts.length === 2 && yOverlap(texts[0], texts[1]) && xDisjoint(texts[0], texts[1])) {
    const [left, right] = texts[0].box.x <= texts[1].box.x ? [texts[0], texts[1]] : [texts[1], texts[0]]
    return {
      layout: {layoutType: "double_text_wall", topText: left.text ?? "", bottomText: right.text ?? ""},
      degraded,
      dropped,
    }
  }

  // Reading order: y, then x; join with blank lines. Downstream wrap clips
  // overflow per the device profile.
  const ordered = [...texts].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
  const text = ordered
    .map((t) => t.text ?? "")
    .filter((t) => t.length > 0)
    .join("\n\n")
  return {layout: {layoutType: "text_wall", text}, degraded, dropped}
}

/** Compile opt-in text controls for text-only glasses, once, using their usable
 * text width. Old scenes still use the historical degrade path above.
 * Elements share the device's row and byte budgets, in reading order.
 */
export function degradeTextScene(
  input: readonly SceneElementInput[],
  caps: SceneDisplayCapabilities,
  profile: DisplayProfile,
  includeTextLayout: boolean,
): DegradedScene {
  const textLayout: Record<string, SceneTextLayout> = Object.create(null)
  const dropped: string[] = []
  let degraded = false
  let remaining = profile.maxLines
  let bytesLeft = profile.maxPayloadBytes
  const chunks: string[] = []
  const seen = new Set<string>()
  const texts = input
    .map((el, index) => ({el, index}))
    .filter(({el, index}) => {
      const id = el?.id ?? `text[${index}]`
      if (
        !el ||
        !el.box ||
        ![el.box.x, el.box.y, el.box.w, el.box.h].every(Number.isFinite) ||
        el.box.w <= 0 ||
        el.box.h <= 0
      ) {
        dropped.push(id)
        degraded = true
        return false
      }
      if (el.type === "text") {
        if (
          (el.style?.maxLines !== undefined && (!Number.isFinite(el.style.maxLines) || el.style.maxLines < 1)) ||
          (el.id && seen.has(el.id))
        ) {
          dropped.push(id)
          degraded = true
          return false
        }
        if (el.id) seen.add(el.id)
        return true
      }
      if (el.type === "image") {
        dropped.push(el.id ?? `image[${index}]`)
        degraded = true
      }
      return false
    })
    .sort((a, b) => a.el.box.y - b.el.box.y || a.el.box.x - b.el.box.x)
  for (const {el, index} of texts.splice(profile.maxLines)) {
    dropped.push(el.id ?? `text[${index}]`)
    degraded = true
  }
  for (let i = 0; i < texts.length; i++) {
    const {el, index} = texts[i]
    if (el.type !== "text") continue
    const id = el.id ?? `text[${index}]`
    const b = el.box
    // Reserve at least one row for subsequent text (e.g. a progress footer).
    const capacity = Math.max(0, remaining - (texts.length - i - 1))
    if (!capacity || bytesLeft < 0) {
      dropped.push(id)
      degraded = true
      continue
    }
    const width = Math.max(
      1,
      Math.min(profile.displayWidthPx, Math.floor((profile.displayWidthPx * Math.min(b.w, caps.width)) / caps.width)),
    )
    const result = processText(
      el.text,
      {x: 0, y: 0, w: width, h: capacity},
      {...el.style, verticalAlign: undefined},
      {...profile, lineHeightPx: 1, maxLines: capacity, maxPayloadBytes: bytesLeft},
    )
    if (!result.layout.lines.length && el.text) {
      dropped.push(id)
      degraded = true
      continue
    }
    textLayout[id] = result.layout
    chunks.push(result.text)
    remaining -= result.layout.lines.length
    // TextEncoder isn't available in every background JS runtime.
    bytesLeft -= new TextMeasurer(profile).getByteSize(result.text) + 1
    degraded ||= result.degraded || el.style?.verticalAlign === "bottom"
  }
  return {
    layout: chunks.length ? {layoutType: "text_wall", text: chunks.join("\n")} : null,
    prewrapped: true,
    degraded,
    dropped,
    ...(includeTextLayout ? {textLayout} : {}),
  }
}
