import {describe, expect, test} from "bun:test"
import {normalizeWords, ScriptEngine} from "./ScriptEngine"
import {processText} from "../../../../../mobile/modules/engine/src/utils/display/scene/text"
import {G2_PROFILE} from "../../../../../mobile/modules/engine/src/utils/display/profiles/g2"

describe("Japanese voice matching", () => {
  test("normalizes Japanese independently of spaces and punctuation", () => {
    expect(normalizeWords("今日は、東京です。")).toEqual(normalizeWords("今日 は 東京 です"))
    expect(normalizeWords("AIで2026年のデモ")).toEqual(["ai", "で", "2026", "年", "の", "デ", "モ"])
    expect(normalizeWords("ガラス")).toEqual(normalizeWords("カ\u3099ラス"))
  })

  test("advances within an unspaced sentence without changing timed word counts", () => {
    const engine = new ScriptEngine({numberOfLines: 2})
    engine.setScript("今日は東京です。明日は大阪です。")
    engine.acceptLayout(0, {lines: [], lineStarts: [0, 3, 6, 9, 12], capacity: 2, truncated: true})
    expect(engine.totalWords).toBe(1)
    const first = engine.matchSpoken(normalizeWords("今日は"), 0)
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(1)
    expect(engine.topLineForWord(first)).toBe(1)
    const second = engine.matchSpoken(normalizeWords("今日は、東京です"), first)
    expect(second).toBeGreaterThan(first)
    expect(engine.topLineForWord(second)).toBe(2)
    expect(engine.matchSpoken(normalizeWords("明日は大阪です。"), second)).toBe(1)
    expect(engine.topLineForWord(1)).toBe(3)
    expect(engine.matchSpoken(normalizeWords("unrelated speech"), first)).toBe(first)
    expect(engine.matchSpoken(normalizeWords("今日は"), second)).toBe(second)
  })

  test("keeps source offsets for astral characters and decomposed kana", () => {
    const engine = new ScriptEngine({numberOfLines: 1})
    const text = "\u{20000}カ\u3099ラスを見る"
    engine.setScript(text)
    engine.acceptLayout(0, {lines: [], lineStarts: [0, 4, 6, 8], capacity: 1, truncated: true})
    const cursor = engine.matchSpoken(normalizeWords("\u{20000}ガ"), 0)
    expect(engine.lineForWord(cursor)).toBe(1)
    expect(engine.firstWordOfLine(1)).toBe(cursor)
    expect(engine.textFrom(engine.sourceStartForLine(1))).toBe("ラスを見る")
  })

  test("retains English punctuation, timing, and matching behavior", () => {
    expect(normalizeWords("Don't stop, well-known WORDS!")).toEqual(["dont", "stop", "wellknown", "words"])
    const engine = new ScriptEngine({numberOfLines: 2})
    engine.setScript("one two three four five six")
    expect(engine.totalWords).toBe(6)
    expect(engine.matchSpoken(normalizeWords("one two"), 0)).toBe(2)
    expect(engine.matchSpoken(normalizeWords("three four"), 2)).toBe(4)
    expect(engine.matchSpoken([], 4)).toBe(4)
    expect(engine.wordForPercent(25)).toBe(2)
  })

  test("seeks within Japanese sentences instead of rounding to the start or end", () => {
    const engine = new ScriptEngine({numberOfLines: 2})
    engine.setScript("今日は東京です。明日は大阪です。")
    for (const percent of [0, 25, 50, 75, 100]) {
      expect(engine.progressForWord(engine.wordForPercent(percent))).toBe(percent)
    }
    expect(engine.wordForPercent(-10)).toBe(0)
    expect(engine.wordForPercent(110)).toBe(1)
  })

  test("advances using real G2 host line boundaries", () => {
    const script = "今日は東京を歩いています。明日は大阪に行きます。新しい景色を見るのが楽しみです。"
    const engine = new ScriptEngine({numberOfLines: 2})
    engine.setScript(script)
    const {layout} = processText(script, {x: 0, y: 0, w: 80, h: 100}, {maxLines: 2, breakMode: "word"}, G2_PROFILE)
    engine.acceptLayout(0, layout)
    expect(layout.lineStarts.length).toBeGreaterThan(2)
    const nextLine = layout.lineStarts[1]
    const cursor = engine.matchSpoken(normalizeWords(script.slice(0, nextLine)), 0)
    expect(engine.topLineForWord(cursor)).toBe(1)
    expect(engine.textFrom(engine.sourceStartForLine(1))).toBe(script.slice(nextLine))
    expect(engine.firstWordOfLine(1)).toBe(cursor)
  })

  test("clears Japanese anchors when the script is replaced or empty", () => {
    const engine = new ScriptEngine({numberOfLines: 2})
    engine.setScript("今日は東京です")
    engine.setScript("one two")
    expect(engine.matchSpoken(normalizeWords("今日は東京"), 0)).toBe(0)
    expect(engine.matchSpoken(normalizeWords("one two"), 0)).toBe(2)
    engine.setScript("。、 !")
    expect(engine.totalWords).toBe(0)
    expect(engine.matchSpoken(normalizeWords("今日は"), 0)).toBe(0)
    expect(engine.lineForWord(0)).toBe(0)
  })
})
