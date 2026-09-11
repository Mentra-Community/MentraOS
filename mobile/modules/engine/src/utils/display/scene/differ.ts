/**
 * Scene differ — matches elements between the last frame sent to the device and
 * the next scene, and classifies each element's change. Pure set arithmetic:
 * nothing in here is device-specific (spec §1).
 *
 * Matching rules (design doc §3.4.1, in order):
 *   1. same explicit `id` + same `type`  ⇒ same element
 *   2. no id: same `type` + identical box ⇒ same element
 *   3. no id: same `type`, by order among the still-unmatched
 *   4. anything unmatched in prev ⇒ removed; unmatched in next ⇒ created
 *
 * Matched no-id elements INHERIT the previous element's assigned id so the
 * device-side id⇒firmware-component mapping stays stable; fresh elements get a
 * synthesized id from the caller (SceneStore counter). Synthesized ids are
 * prefixed "~" so they can never collide with app-supplied ids.
 */

import type {FrameElement, SceneBox, SceneChange, SceneElementType} from "./types"
import {boxesEqual} from "./types"

/** A processed (clamped/wrapped) element, pre-diff: id optional, no annotation yet. */
export interface DiffableElement {
  id?: string
  type: SceneElementType
  box: SceneBox
  text?: string
  data?: string
  style?: FrameElement["style"]
  contentHash: string
}

export interface DiffResult {
  elements: FrameElement[]
  removed: string[]
}

function classify(prev: FrameElement, next: DiffableElement): SceneChange {
  if (!boxesEqual(prev.box, next.box)) return "moved"
  if (prev.contentHash !== next.contentHash) return "updated"
  return "unchanged"
}

/**
 * Assemble the annotated FrameElement, OMITTING optional fields that are
 * undefined. A present key with an `undefined` value cannot cross the Expo
 * Android bridge — its `Map<String, Any>` converter rejects it ("Value is
 * undefined, expected an Object"), which surfaces as ERR_UNEXPECTED from
 * displayEvent. (iOS's `[String: Any]` bridge silently drops nils, so the
 * defect was invisible there.) Keeping the keys absent — not undefined —
 * matches the optional-field contract in types.ts.
 */
function buildFrameElement(el: DiffableElement, id: string, change: SceneChange): FrameElement {
  const out: FrameElement = {id, type: el.type, box: el.box, contentHash: el.contentHash, change}
  if (el.text !== undefined) out.text = el.text
  if (el.data !== undefined) out.data = el.data
  if (el.style !== undefined) out.style = el.style
  return out
}

/**
 * Diff `next` against `prev` (the last frame sent for this app/view/device;
 * empty array for a fresh scene). `nextSyntheticId` mints ids for elements the
 * app didn't name — must be stable per (app, view) across calls (SceneStore).
 */
export function diffScene(
  prev: readonly FrameElement[],
  next: readonly DiffableElement[],
  nextSyntheticId: () => string,
): DiffResult {
  const prevUnmatched = new Set(prev.map((_, i) => i))
  const prevByExplicitId = new Map<string, number>()
  prev.forEach((el, i) => {
    if (!el.id.startsWith("~")) prevByExplicitId.set(`${el.type}:${el.id}`, i)
  })

  // matches[nextIndex] = prevIndex | undefined
  const matches: (number | undefined)[] = new Array(next.length).fill(undefined)

  // Pass 1: explicit id + type.
  next.forEach((el, i) => {
    if (!el.id) return
    const j = prevByExplicitId.get(`${el.type}:${el.id}`)
    if (j !== undefined && prevUnmatched.has(j)) {
      matches[i] = j
      prevUnmatched.delete(j)
    }
  })

  // Pass 2: no-id elements match a no-id prev element of the same type with an
  // identical box.
  next.forEach((el, i) => {
    if (el.id || matches[i] !== undefined) return
    for (const j of prevUnmatched) {
      const p = prev[j]
      if (p.id.startsWith("~") && p.type === el.type && boxesEqual(p.box, el.box)) {
        matches[i] = j
        prevUnmatched.delete(j)
        break
      }
    }
  })

  // Pass 3: remaining no-id elements match remaining no-id prev of the same
  // type in order (k-th unmatched text ↔ k-th unmatched text).
  next.forEach((el, i) => {
    if (el.id || matches[i] !== undefined) return
    for (const j of prevUnmatched) {
      const p = prev[j]
      if (p.id.startsWith("~") && p.type === el.type) {
        matches[i] = j
        prevUnmatched.delete(j)
        break
      }
    }
  })

  const elements: FrameElement[] = next.map((el, i) => {
    const j = matches[i]
    if (j !== undefined) {
      const p = prev[j]
      return buildFrameElement(el, el.id ?? p.id, classify(p, el))
    }
    return buildFrameElement(el, el.id ?? nextSyntheticId(), "created")
  })

  const removed = [...prevUnmatched].map((j) => prev[j].id)
  return {elements, removed}
}
