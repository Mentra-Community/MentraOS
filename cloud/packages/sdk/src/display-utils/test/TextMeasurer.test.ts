import {describe, expect, test, beforeEach} from "bun:test"
import {TextMeasurer} from "../measurer/TextMeasurer"
import {G1_PROFILE} from "../profiles/g1"

describe("TextMeasurer", () => {
  let measurer: TextMeasurer

  beforeEach(() => {
    measurer = new TextMeasurer(G1_PROFILE)
  })

  describe("constructor", () => {
    test("should create a measurer with a profile", () => {
      expect(measurer).toBeDefined()
      expect(measurer.getProfile()).toBe(G1_PROFILE)
    })
  })

  describe("measureText", () => {
    test("should return 0 for empty string", () => {
      expect(measurer.measureText("")).toBe(0)
    })

    test("should return 0 for null-like input", () => {
      expect(measurer.measureText("")).toBe(0)
    })

    test("should measure single Latin character", () => {
      // 'a' has glyph width 5, rendered = (5+1)*2 = 12
      expect(measurer.measureChar("a")).toBe(12)
    })

    test("should measure narrow characters correctly", () => {
      // 'i' has glyph width 1, rendered = (1+1)*2 = 4
      expect(measurer.measureChar("i")).toBe(4)
      // 'l' has glyph width 1, rendered = (1+1)*2 = 4
      expect(measurer.measureChar("l")).toBe(4)
    })

    test("should measure wide characters correctly", () => {
      // 'm' has glyph width 7, rendered = (7+1)*2 = 16
      expect(measurer.measureChar("m")).toBe(16)
      // 'w' has glyph width 7, rendered = (7+1)*2 = 16
      expect(measurer.measureChar("w")).toBe(16)
    })

    test("should measure space correctly", () => {
      // space has glyph width 2, rendered = (2+1)*2 = 6
      expect(measurer.measureChar(" ")).toBe(6)
    })

    test("should measure hyphen correctly", () => {
      // hyphen has glyph width 4, rendered = (4+1)*2 = 10
      expect(measurer.measureChar("-")).toBe(10)
    })

    test("should measure multiple characters", () => {
      // "ab" = 12 + (4+1)*2 = 12 + 10 = 22
      const width = measurer.measureText("ab")
      expect(width).toBeGreaterThan(0)
    })

    test("should sum character widths", () => {
      const aWidth = measurer.measureChar("a")
      const bWidth = measurer.measureChar("b")
      expect(measurer.measureText("ab")).toBe(aWidth + bWidth)
    })
  })

  describe("CJK character measurement", () => {
    test("should measure Chinese characters at uniform width", () => {
      // All CJK characters should be 18px
      expect(measurer.measureChar("你")).toBe(18)
      expect(measurer.measureChar("好")).toBe(18)
      expect(measurer.measureChar("世")).toBe(18)
    })

    test("should measure Japanese Hiragana at uniform width", () => {
      expect(measurer.measureChar("あ")).toBe(18)
      expect(measurer.measureChar("い")).toBe(18)
    })

    test("should measure Japanese Katakana at uniform width", () => {
      expect(measurer.measureChar("ア")).toBe(18)
      expect(measurer.measureChar("イ")).toBe(18)
    })

    test("should measure Korean Hangul at uniform width", () => {
      // Korean Hangul should be 24px
      expect(measurer.measureChar("한")).toBe(24)
      expect(measurer.measureChar("글")).toBe(24)
    })

    test("should measure Cyrillic at uniform width", () => {
      // Cyrillic should be 18px
      expect(measurer.measureChar("А")).toBe(18)
      expect(measurer.measureChar("Б")).toBe(18)
    })
  })

  describe("measureTextDetailed", () => {
    test("should return detailed measurement", () => {
      const result = measurer.measureTextDetailed("abc")
      expect(result.text).toBe("abc")
      expect(result.charCount).toBe(3)
      expect(result.totalWidthPx).toBeGreaterThan(0)
      expect(result.chars).toBeDefined()
      expect(result.chars?.length).toBe(3)
    })

    test("should include script type in detailed measurement", () => {
      const result = measurer.measureTextDetailed("a你")
      expect(result.chars?.[0].script).toBe("latin")
      expect(result.chars?.[1].script).toBe("cjk")
    })

    test("should indicate if char is from glyph map", () => {
      const result = measurer.measureTextDetailed("a你")
      expect(result.chars?.[0].fromGlyphMap).toBe(true) // 'a' is in glyph map
      expect(result.chars?.[1].fromGlyphMap).toBe(false) // Chinese is not in glyph map
    })
  })

  describe("fitsInWidth", () => {
    test("should return true for text that fits", () => {
      expect(measurer.fitsInWidth("Hi", 100)).toBe(true)
    })

    test("should return false for text that doesn't fit", () => {
      expect(measurer.fitsInWidth("Hello world this is a long text", 50)).toBe(false)
    })

    test("should handle edge case of exact fit", () => {
      const text = "a"
      const width = measurer.measureText(text)
      expect(measurer.fitsInWidth(text, width)).toBe(true)
    })
  })

  describe("charsThatFit", () => {
    test("should return 0 for empty string", () => {
      expect(measurer.charsThatFit("", 100)).toBe(0)
    })

    test("should return all chars if they fit", () => {
      expect(measurer.charsThatFit("Hi", 100)).toBe(2)
    })

    test("should return partial count if not all fit", () => {
      const count = measurer.charsThatFit("Hello world", 50)
      expect(count).toBeGreaterThan(0)
      expect(count).toBeLessThan(11) // Less than full string
    })

    test("should respect startIndex", () => {
      const fromStart = measurer.charsThatFit("Hello", 100, 0)
      const fromMiddle = measurer.charsThatFit("Hello", 100, 2)
      expect(fromStart).toBeGreaterThanOrEqual(fromMiddle)
    })
  })

  describe("getPixelOffset", () => {
    test("should return 0 for index 0", () => {
      expect(measurer.getPixelOffset("Hello", 0)).toBe(0)
    })

    test("should return cumulative width at index", () => {
      const text = "ab"
      const aWidth = measurer.measureChar("a")
      expect(measurer.getPixelOffset(text, 1)).toBe(aWidth)
    })
  })

  describe("detectScript", () => {
    test("should detect Latin", () => {
      expect(measurer.detectScript("a")).toBe("latin")
      expect(measurer.detectScript("Z")).toBe("latin")
    })

    test("should detect CJK", () => {
      expect(measurer.detectScript("中")).toBe("cjk")
    })

    test("should detect Korean", () => {
      expect(measurer.detectScript("한")).toBe("korean")
    })

    test("should detect Cyrillic", () => {
      expect(measurer.detectScript("Д")).toBe("cyrillic")
    })

    test("should detect numbers", () => {
      expect(measurer.detectScript("5")).toBe("numbers")
    })

    test("should detect punctuation", () => {
      expect(measurer.detectScript(".")).toBe("punctuation")
      expect(measurer.detectScript(",")).toBe("punctuation")
    })
  })

  describe("isUniformWidth", () => {
    test("should return true for CJK", () => {
      expect(measurer.isUniformWidth("中")).toBe(true)
    })

    test("should return true for Korean", () => {
      expect(measurer.isUniformWidth("한")).toBe(true)
    })

    test("should return true for Cyrillic", () => {
      expect(measurer.isUniformWidth("Б")).toBe(true)
    })

    test("should return false for Latin", () => {
      expect(measurer.isUniformWidth("a")).toBe(false)
    })
  })

  describe("utility methods", () => {
    test("should get display width", () => {
      expect(measurer.getDisplayWidthPx()).toBe(576)
    })

    test("should get max lines", () => {
      expect(measurer.getMaxLines()).toBe(5)
    })

    test("should get max payload bytes", () => {
      expect(measurer.getMaxPayloadBytes()).toBe(390)
    })

    test("should get hyphen width", () => {
      expect(measurer.getHyphenWidth()).toBe(10)
    })

    test("should get space width", () => {
      expect(measurer.getSpaceWidth()).toBe(6)
    })
  })

  describe("getByteSize", () => {
    test("should return correct byte size for ASCII", () => {
      expect(measurer.getByteSize("Hello")).toBe(5)
    })

    test("should return correct byte size for multi-byte chars", () => {
      // Chinese characters are 3 bytes each in UTF-8
      expect(measurer.getByteSize("中")).toBe(3)
      expect(measurer.getByteSize("你好")).toBe(6)
    })
  })

  describe("getGlyphWidth", () => {
    test("should return glyph width for mapped characters", () => {
      expect(measurer.getGlyphWidth("a")).toBe(5)
      expect(measurer.getGlyphWidth("m")).toBe(7)
      expect(measurer.getGlyphWidth("i")).toBe(1)
    })

    test("should return undefined for unmapped characters", () => {
      expect(measurer.getGlyphWidth("中")).toBeUndefined()
    })
  })

  describe("caching", () => {
    test("should return same value on repeated calls", () => {
      const first = measurer.measureChar("a")
      const second = measurer.measureChar("a")
      expect(first).toBe(second)
    })

    test("should clear cache correctly", () => {
      measurer.measureChar("a")
      measurer.clearCache()
      // Should still work after clearing
      const result = measurer.measureChar("a")
      expect(result).toBe(12)
    })
  })

  describe("G1 specific measurements", () => {
    test("should fit ~48 average Latin chars on G1 display", () => {
      // G1 is 576px wide, average Latin char is ~12px
      // So roughly 48 chars should fit
      const avgChar = "e" // width = (4+1)*2 = 10px
      const charWidth = measurer.measureChar(avgChar)
      const estimatedChars = Math.floor(576 / charWidth)
      expect(estimatedChars).toBeGreaterThanOrEqual(40)
      expect(estimatedChars).toBeLessThanOrEqual(60)
    })

    test("should fit 32 CJK chars on G1 display", () => {
      // G1 is 576px wide, CJK is 18px each
      // So 576 / 18 = 32 chars
      const cjkWidth = measurer.measureChar("中")
      const estimatedChars = Math.floor(576 / cjkWidth)
      expect(estimatedChars).toBe(32)
    })

    test("should fit 24 Korean chars on G1 display", () => {
      // G1 is 576px wide, Korean is 24px each
      // So 576 / 24 = 24 chars
      const koreanWidth = measurer.measureChar("한")
      const estimatedChars = Math.floor(576 / koreanWidth)
      expect(estimatedChars).toBe(24)
    })
  })
})
