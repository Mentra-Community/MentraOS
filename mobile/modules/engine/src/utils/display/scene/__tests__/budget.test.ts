import {describe, expect, test} from "bun:test"

import {NIMO_PROFILE} from "../../profiles/nimo"
import {sceneBudget} from "../budget"
import {processScene} from "../process"
import type {SceneDisplayCapabilities, SceneElementInput} from "../types"

const caps: SceneDisplayCapabilities = {
  width: 500,
  height: 220,
  canPosition: true,
  maxTextElements: 32,
  maxImageElements: 4,
  maxImagePx: {width: 200, height: 200},
  shapes: ["rect"],
  intensityLevels: 4,
  partialUpdate: false,
}
const box = {x: 0, y: 0, w: 500, h: 220}
const text = (id: string, content = Array(11).fill("row").join("\n")): SceneElementInput => ({
  id,
  type: "text",
  box,
  text: content,
})
const image = (id: string, size: number): SceneElementInput => ({
  id,
  type: "image",
  box: {...box, w: size, h: size},
  data: "native-decoded",
})

describe("whole-frame admission", () => {
  test("drops expanded text objects past 64 and omits their feedback", () => {
    const result = processScene(
      Array.from({length: 6}, (_, i) => text(`t${i}`)),
      caps,
      NIMO_PROFILE,
      true,
    )
    expect(result.elements).toHaveLength(5)
    expect(result.dropped).toEqual(["t5"])
    expect(result.degraded).toBe(true)
    expect(Object.keys(result.textLayout!)).toHaveLength(5)
  })

  test("borders consume objects while empty rows only consume vertical space", () => {
    const input = Array.from({length: 6}, (_, i) => ({...text(`t${i}`), style: {border: 1}}))
    const full = processScene(input, caps, NIMO_PROFILE)
    expect(full.elements).toHaveLength(5) // 5 × (11 labels + border) = 60
    const blank = processScene(
      input.map((el) => ({...el, text: "first\n\nthird"})),
      caps,
      NIMO_PROFILE,
    )
    expect(blank.elements).toHaveLength(6)
    expect(blank.degraded).toBe(false)
  })

  test("counts UTF-8 across labels, not characters or individual boxes", () => {
    const input = Array.from({length: 9}, (_, i) => text(`t${i}`, Array(11).fill("中".repeat(31)).join("\n")))
    // Isolate text bytes from the independent object limit.
    const profile = {...NIMO_PROFILE, sceneBudget: {...NIMO_PROFILE.sceneBudget!, maxObjects: 200}}
    const result = processScene(input, caps, profile)
    expect(result.elements).toHaveLength(8) // 8 × 11 × 31 × 3 = 8184 bytes
    expect(result.dropped).toEqual(["t8"])
  })

  test("enforces aggregate pixels even when each image fits its dimensions", () => {
    // Isolate the pixel pool; the production byte budget is stricter for noisy images.
    const profile = {...NIMO_PROFILE, sceneBudget: {...NIMO_PROFILE.sceneBudget!, maxEncodedBytes: Infinity}}
    const result = processScene([image("a", 200), image("b", 200), image("c", 200)], caps, profile)
    expect(result.elements.map((el) => el.id)).toEqual(["a", "b"])
    expect(result.dropped).toEqual(["c"])
  })

  test("reserves worst-case image bytes and lets smaller later elements fit", () => {
    const result = processScene([image("a", 200), image("b", 200), image("small", 80)], caps, NIMO_PROFILE)
    expect(result.elements.map((el) => el.id)).toEqual(["a", "small"])
    expect(result.dropped).toEqual(["b"])
    expect(result.degraded).toBe(true)
  })

  test("retains ordinary navigation frames with text, border and a 160px map", () => {
    const result = processScene(
      [
        text("instruction", "Turn left\nMain Street"),
        {id: "border", type: "rect", box, style: {border: 2}},
        image("map", 160),
      ],
      caps,
      NIMO_PROFILE,
    )
    expect(result.elements).toHaveLength(3)
    expect(result.degraded).toBe(false)
  })

  test("resets reservations on every render and leaves other profiles unchanged", () => {
    const input = [image("a", 200), image("b", 200)]
    expect(processScene(input, caps, NIMO_PROFILE).dropped).toEqual(["b"])
    expect(processScene([input[1]], caps, NIMO_PROFILE).dropped).toEqual([])
    expect(processScene(input, caps, {...NIMO_PROFILE, sceneBudget: undefined}).dropped).toEqual([])
  })

  test("encoded byte admission includes frame, text and object headers", () => {
    const reserve = sceneBudget({...NIMO_PROFILE, sceneBudget: {...NIMO_PROFILE.sceneBudget!, maxEncodedBytes: 24}})
    expect(reserve({type: "text", box, text: "four", contentHash: ""})).toBe(true) // 3 + 17 + 4
    expect(reserve({type: "rect", box, contentHash: ""})).toBe(false)
  })
})
