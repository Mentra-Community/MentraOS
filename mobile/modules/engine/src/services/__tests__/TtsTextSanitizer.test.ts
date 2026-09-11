/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {prepareTtsSentences, sanitizeTtsText} from "../TtsTextSanitizer"

describe("sanitizeTtsText", () => {
  test("normalizes the temperature text from OS-1769", () => {
    expect(sanitizeTtsText("SF Weather: Highs around 68°F (20°C), lows near 55℉.")).toBe(
      "SF Weather: Highs around 68 degrees Fahrenheit or 20 degrees Celsius, lows near 55 degrees Fahrenheit.",
    )
  })

  test("normalizes temperatures after a miniapp has already removed brackets", () => {
    expect(sanitizeTtsText("Highs around 68°F 20°C, lows near 55°F.")).toBe(
      "Highs around 68 degrees Fahrenheit or 20 degrees Celsius, lows near 55 degrees Fahrenheit.",
    )
  })

  test("does not add or before a lone parenthetical temperature", () => {
    expect(sanitizeTtsText("It feels like (20°C) outside.")).toBe("It feels like 20 degrees Celsius outside.")
  })

  test("links temperature alternatives split across sentence entries", () => {
    expect(prepareTtsSentences(["68°F", "(20°C)", "and sunny."])).toEqual([
      "68 degrees Fahrenheit",
      "or 20 degrees Celsius",
      "and sunny.",
    ])
  })

  test("removes markup and turns common symbols into words", () => {
    expect(
      sanitizeTtsText(
        'Use <say-as interpret-as="characters">API</say-as> [keys](https://example.com): C++ & R&D = 100%.',
      ),
    ).toBe("Use API keys: C plus plus and R and D equals 100 percent.")
  })

  test("speaks comparison operators and preserves numeric slashes", () => {
    expect(sanitizeTtsText("3 &lt; 5, x >= 2, and 3/4 cup.")).toBe(
      "3 less than 5, x greater than or equal to 2, and 3/4 cup.",
    )
  })

  test("is idempotent", () => {
    const once = sanitizeTtsText("Turn 90° clockwise & stop.")
    expect(sanitizeTtsText(once)).toBe(once)
  })

  test("preserves exact text when sanitization is disabled", () => {
    expect(prepareTtsSentences(["Read C++ & [brackets]."], false)).toEqual(["Read C++ & [brackets]."])
  })

  test("drops sentences with no speakable content after sanitization", () => {
    expect(prepareTtsSentences(["<break /> [] {}", "Speak 90°."])).toEqual(["Speak 90 degrees."])
  })
})
