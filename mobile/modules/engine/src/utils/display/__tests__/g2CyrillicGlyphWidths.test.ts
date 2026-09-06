import {describe, expect, test} from "bun:test"

import {TextMeasurer} from "../measurer/TextMeasurer"
import {TextWrapper} from "../wrapper/TextWrapper"
import {G1_PROFILE} from "../profiles/g1"
import {G2_PROFILE} from "../profiles/g2"

/**
 * G2 renders Cyrillic proportionally (measured against the firmware font and
 * field-verified on physical glasses); G1 keeps its verified uniform 18px.
 * The measured table lives in the G2 profile's glyph map, which TextMeasurer
 * checks before uniformScripts.
 */
describe("G2 Cyrillic glyph widths", () => {
  const g2 = new TextMeasurer(G2_PROFILE)
  const g1 = new TextMeasurer(G1_PROFILE)

  test("Cyrillic is proportional on G2, uniform on G1", () => {
    expect(g2.measureText("о")).toBe(11)  // measured
    expect(g2.measureText("Ж")).toBe(17)  // widest uppercase
    expect(g2.measureText("г")).toBe(9)   // odd width — half-unit raw round-trips
    expect(g1.measureText("о")).toBe(18)  // G1 untouched
    expect(g1.measureText("Ж")).toBe(18)
  })

  test("a full-width G2 line fits 51 Cyrillic characters instead of 32", () => {
    const line = "о".repeat(51)
    // Before this table the same string measured 51 × 18 = 918px.
    expect(g2.measureText(line)).toBe(51 * 11)
    expect(g1.measureText(line)).toBe(51 * 18)

    const wrapped = new TextWrapper(g2).wrap(line, {maxWidthPx: 576})
    expect(wrapped.lines.length).toBe(1)

    const wrappedBefore = new TextWrapper(g1).wrap(line, {maxWidthPx: 576})
    expect(wrappedBefore.lines.length).toBeGreaterThan(1)
  })

  test("Latin, digits and CJK are unchanged on G2", () => {
    expect(g2.measureText("8")).toBe(g1.measureText("8"))
    expect(g2.measureText("m")).toBe(g1.measureText("m"))
    expect(g2.measureText("好")).toBe(18)  // uniform CJK still applies
  })

  test("field-verified wrap point: 39 digits fit a 472px line", () => {
    const digits = "8".repeat(39)
    expect(g2.measureText(digits)).toBeLessThanOrEqual(472)
    expect(g2.measureText(digits + "8")).toBeGreaterThan(472)
  })
})
