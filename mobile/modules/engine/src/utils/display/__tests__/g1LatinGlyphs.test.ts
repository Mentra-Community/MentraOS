import {describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"

import {TextMeasurer} from "../measurer/TextMeasurer"
import {normalizeG1DisplayText} from "../normalization"
import {G1_PROFILE, G1_PROFILE_LEGACY} from "../profiles/g1"
import {G1_LATIN_GLYPH_WIDTHS} from "../profiles/g1LatinGlyphs"
import {G2_PROFILE} from "../profiles/g2"
import {sourceLines} from "../scene/text"
import {TextWrapper} from "../wrapper/TextWrapper"

const root = new URL("../../../../../../../", import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), "utf8")

describe("G1 firmware Latin glyphs", () => {
  test("host and native preservation lists match the extracted firmware index", () => {
    const glyphs = read("notes/g1-embedded-glyphs.csv")
      .split("\n")
      .flatMap((line) => {
        const match = /^U\+([0-9A-F]+),.*,(\d+)$/.exec(line)
        if (!match) return []
        const codePoint = parseInt(match[1], 16)
        const char = String.fromCodePoint(codePoint)
        return codePoint > 127 && /\p{Script=Latin}/u.test(char) ? [[char, Number(match[2])] as const] : []
      })
    expect(glyphs).toHaveLength(124)
    expect(Object.entries(G1_LATIN_GLYPH_WIDTHS)).toEqual(glyphs)
    const expected = glyphs.map(([char]) => char).join("")
    const kotlin = read(
      "mobile/modules/bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/sgcs/G1TextSanitizer.kt",
    )
    const swift = read("mobile/modules/bluetooth-sdk/ios/Source/utils/G1TextSanitizer.swift")
    expect(kotlin.match(/G1_LATIN_GLYPHS = "([^"]+)"/)?.[1]).toBe(expected)
    expect(swift.match(/supportedLatin = Set\("([^"]+)"/)?.[1]).toBe(expected)
    expect(normalizeG1DisplayText(expected)).toBe(expected)
    expect(normalizeG1DisplayText(expected.normalize("NFD"))).toBe(expected)
  })

  test("preserves Swedish text, layout and non-Latin marks, with targeted fallback", () => {
    const text = "“Hallå, hallå”\nÅÄÖ åäö"
    expect(normalizeG1DisplayText(text)).toBe(text)
    expect(normalizeG1DisplayText("Halla\u030A, halla\u030A")).toBe("Hallå, hallå")
    const otherScripts = "が カ\u3099 한\u302E Α\u0301 مُرَحَّبًا शि ❤️"
    expect(normalizeG1DisplayText(otherScripts)).toBe(otherScripts)
    const normalized = normalizeG1DisplayText("Hallå Łódź Đặng Œuvre")
    expect(normalized).toBe("Hallå Łódź Dang OEuvre")
    expect(normalizeG1DisplayText(normalized)).toBe(normalized)
    expect(new TextWrapper(new TextMeasurer(G2_PROFILE)).wrap("Đặng Œ").lines).toEqual(["Đặng Œ"])
  })

  test("wraps mapped glyphs by their widths and UTF-8 size after composition", () => {
    for (const profile of [G1_PROFILE, G1_PROFILE_LEGACY]) {
      const wrapper = new TextWrapper(new TextMeasurer(profile))
      expect(wrapper.wrap("Halla\u030A, halla\u030A").lines).toEqual(["Hallå, hallå"])
      expect(wrapper.wrap("æ".repeat(32), {maxWidthPx: 576}).lines).toEqual(["æ".repeat(32)])
      expect(wrapper.wrap("æ".repeat(33), {maxWidthPx: 576}).lines.length).toBeGreaterThan(1)
      const input = "a\u030A".repeat(10)
      const result = wrapper.wrap(input, {maxBytes: 20})
      expect(result.lines).toEqual(["å".repeat(10)])
      expect(result.truncated).toBe(false)
      expect(result.originalText).toBe(input)
    }
    expect(sourceLines("Halla\u030A\nŒ", 576, {}, G1_PROFILE)).toEqual([
      {text: "Hallå", start: 0, end: 6},
      {text: "OE", start: 7, end: 8},
    ])
  })
})
