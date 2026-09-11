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

import type {SceneElementInput} from "./types"

export interface DegradedScene {
  /** Legacy layout for the existing display path, or null for an empty scene (caller clears). */
  layout: {layoutType: string; [key: string]: unknown} | null
  degraded: boolean
  dropped: string[]
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
