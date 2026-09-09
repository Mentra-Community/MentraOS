import {describe, expect, test} from "bun:test"

import {TextMeasurer} from "../measurer/TextMeasurer"
import {G1_PROFILE} from "../profiles/g1"
import {G2_PROFILE} from "../profiles/g2"
import {processScene} from "../scene/process"
import type {SceneDisplayCapabilities} from "../scene/types"
import {TextWrapper} from "../wrapper/TextWrapper"

// These tests verify host measurement and wrapping. Simulator measurements
// support the table; this suite does not exercise physical glasses.
describe("G2 Cyrillic glyph widths", () => {
  const g2 = new TextMeasurer(G2_PROFILE)
  const g1 = new TextMeasurer(G1_PROFILE)

  test("uses proportional advances, including odd pixel widths, only on G2", () => {
    expect(g2.measureText("о")).toBe(11)
    expect(g2.measureText("Ж")).toBe(17)
    expect(g2.measureText("г")).toBe(9)
    expect(g1.measureText("оЖг")).toBe(54)
    expect(g2.measureText("Ёё")).toBe(23)
  })

  test("checks both sides of the host wrap boundary", () => {
    const wrapper = new TextWrapper(g2)
    // The host receives the full width. Native G2 containers reserve 4px on
    // each side; 568 usable pixels fit 51, whereas 576 host pixels fit 52.
    for (const [width, count] of [
      [576, 52],
      [568, 51],
    ]) {
      const line = "о".repeat(count)
      expect(wrapper.wrap(line, {maxWidthPx: width}).lines).toEqual([line])
      expect(wrapper.wrap(line + "о", {maxWidthPx: width}).lines.length).toBeGreaterThan(1)
    }
    expect(g1.charsThatFit("о".repeat(60), 576)).toBe(32)
    expect(g2.charsThatFit("о".repeat(60), 576)).toBe(52)
  })

  test("preserves a reported-length Russian line through scene processing", () => {
    const caps: SceneDisplayCapabilities = {
      width: 576,
      height: 288,
      canPosition: true,
      maxTextElements: 4,
      maxImageElements: 2,
      shapes: ["rect"],
      intensityLevels: 16,
      partialUpdate: true,
    }
    const text = "о".repeat(51)
    const input = [{type: "text" as const, id: "text", box: {x: 0, y: 0, w: 576, h: 40}, text}]
    const result = processScene(input, caps, G2_PROFILE)
    expect(result.elements[0].text).toBe(text)
    expect(result.degraded).toBe(false)
    // Reproduce the inherited-metrics bug without changing G2's line height.
    const before = processScene(input, caps, {...G2_PROFILE, fontMetrics: G1_PROFILE.fontMetrics})
    expect(before.degraded).toBe(true)
    expect(before.elements[0].text).not.toBe(text)
  })

  test("preserves every G1 glyph and unmapped-script fallback", () => {
    expect(G2_PROFILE.fontMetrics.glyphWidths).not.toBe(G1_PROFILE.fontMetrics.glyphWidths)
    for (const [char, rawWidth] of G1_PROFILE.fontMetrics.glyphWidths) {
      expect(G2_PROFILE.fontMetrics.glyphWidths.get(char)).toBe(rawWidth)
      expect(g2.measureText(char)).toBe(g1.measureText(char))
    }
    for (const char of ["好", "あ", "ア", "한", "і", "ї", "є", "ґ", "љ"]) {
      expect(g2.measureText(char)).toBe(g1.measureText(char))
    }
    const russian = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя"
    for (const char of russian) {
      expect(G2_PROFILE.fontMetrics.glyphWidths.has(char)).toBe(true)
      expect(G1_PROFILE.fontMetrics.glyphWidths.has(char)).toBe(false)
      expect(g1.measureText(char)).toBe(18)
    }
  })

  test("39 digits fit 472 usable pixels, but 40 do not", () => {
    const digits = "8".repeat(39)
    expect(g2.measureText(digits)).toBeLessThanOrEqual(472)
    expect(g2.measureText(digits + "8")).toBeGreaterThan(472)
  })
})
