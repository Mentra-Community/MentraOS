import {describe, expect, test} from "bun:test"
import {TextMeasurer} from "../../measurer/TextMeasurer"
import {TextWrapper} from "../../wrapper/TextWrapper"
import {normalizeNimoDisplayText} from "../../normalization"
import {processText, sourceLines} from "../text"
import {processScene} from "../process"
import {degradeTextScene} from "../degrade"
import {NIMO_PROFILE} from "../../profiles/nimo"
import {G2_PROFILE} from "../../profiles/g2"
import {G1_PROFILE} from "../../profiles/g1"
import {Z100_PROFILE} from "../../profiles/z100"
import type {SceneDisplayCapabilities} from "../types"

const caps: SceneDisplayCapabilities = {
  width: 500,
  height: 220,
  canPosition: true,
  maxTextElements: 6,
  maxImageElements: 4,
  shapes: ["rect"],
  intensityLevels: 4,
  partialUpdate: false,
}
const box = {x: 0, y: 0, w: 500, h: 220}

describe("render text selection", () => {
  test("NIMO Latin fallback preserves other scripts, their marks and original syllable widths", () => {
    const otherScripts = "ありがとう が パ カ\u3099 한국어 한\u302E Α\u0301 مُرَحَّبًا शि ❤️"
    expect(normalizeNimoDisplayText(`${otherScripts} café—Æ\u0301`)).toBe(`${otherScripts} cafe-AE`)
    for (const text of ["한".repeat(31), "が".repeat(31)]) {
      const result = processText(text, {...box, h: 20}, {maxLines: 1}, NIMO_PROFILE)
      expect(result.text).toBe(text)
      expect(result.degraded).toBe(false)
      expect(result.layout.lines).toEqual([{text, start: 0, end: 31}])
    }
  })
  test("normalizes NIMO text before legacy and scene wrapping can truncate it", () => {
    const text = "—".repeat(32)
    const wrapper = new TextWrapper(new TextMeasurer(NIMO_PROFILE))
    const wrapped = wrapper.wrap(text, {maxWidthPx: 500, maxLines: 1})
    expect(wrapped.lines).toEqual(["-".repeat(32)])
    expect(wrapped.truncated).toBe(false)
    expect(wrapped.maxLineWidthPx).toBe(256)
    expect(wrapped.originalText).toBe(text)
    for (const style of [undefined, {maxLines: 1}]) {
      const scene = processScene(
        [{type: "text", id: "text", box: {...box, h: 20}, text, style}],
        caps,
        NIMO_PROFILE,
        true,
      )
      expect(scene.elements[0].text).toBe("-".repeat(32))
      expect(scene.degraded).toBe(false)
      expect(scene.textLayout?.text.lines).toEqual([{text: "-".repeat(32), start: 0, end: 32}])
    }
  })
  test("Latin expansions and removed accents retain original scene source offsets", () => {
    const text = "Æé—\nCafe\u0301"
    expect(sourceLines(text, 500, {}, NIMO_PROFILE)).toEqual([
      {text: "AEe-", start: 0, end: 3},
      {text: "Cafe", start: 4, end: 9},
    ])
    const tail = processText(text, box, {maxLines: 1, textWindow: "end"}, NIMO_PROFILE)
    expect(tail.layout.lines).toEqual([{text: "Cafe", start: 4, end: 9}])
    expect(processText("é—Æ", box, {maxLines: 1}, G2_PROFILE).text).toBe("é—Æ")
  })
  test("feedback does not change legacy positioned text or box-height behavior", () => {
    const elements = [{type: "text" as const, id: "text", box: {...box, h: 10}, text: "one\ntwo"}]
    const without = processScene(elements, caps, G2_PROFILE)
    const withFeedback = processScene(elements, caps, G2_PROFILE, true)
    expect(withFeedback.elements).toEqual(without.elements)
    expect(withFeedback.textLayout?.text.lines.map((line) => line.text)).toEqual(["one"])
  })
  test("keeps either end after wrapping, without truncating the newest transcript at the byte limit", () => {
    const text = "old\n".repeat(3000) + "latest\nwords"
    expect(processText(text, box, {maxLines: 2, textWindow: "end"}, NIMO_PROFILE).text).toBe("latest\nwords")
    expect(processText(text, box, {maxLines: 2}, NIMO_PROFILE).text).toBe("old\nold")
  })
  test("the physical box remains the hard limit", () => {
    const result = processText("one\ntwo\nthree", {...box, h: 40}, {maxLines: 5, textWindow: "end"}, NIMO_PROFILE)
    expect(result.text).toBe("two\nthree")
    expect(result.layout.capacity).toBe(2)
    expect(processText("text", {...box, h: 10}, {maxLines: 3}, NIMO_PROFILE).text).toBe("")
  })
  test("bottom caption bands stay fixed as partial text grows, using each device's metrics", () => {
    for (const [profile, height, expected] of [
      [NIMO_PROFILE, 220, 160],
      [G2_PROFILE, 288, 168],
    ] as const) {
      const style = {maxLines: 3, verticalAlign: "bottom" as const}
      const first = processText("first", {...box, h: height}, style, profile)
      const full = processText("first\nsecond\nthird", {...box, h: height}, style, profile)
      expect(first.box).toEqual(full.box)
      expect(first.box.y).toBe(expected)
    }
  })
  test("ellipsis marks the omitted end and respects width and bytes", () => {
    const text = "one\ntwo\nthree"
    expect(processText(text, box, {maxLines: 1, overflow: "ellipsis"}, NIMO_PROFILE).text).toBe("one…")
    expect(processText(text, box, {maxLines: 1, textWindow: "end", overflow: "ellipsis"}, NIMO_PROFILE).text).toBe(
      "…three",
    )
    const tiny = processText(text, {...box, w: 4}, {maxLines: 1, overflow: "ellipsis"}, NIMO_PROFILE)
    expect(tiny.text).toBe("")
  })
  test("invalid line limits are reported, not propagated to native", () => {
    const result = processScene(
      [{type: "text", id: "bad", box, text: "hello", style: {maxLines: NaN}}],
      caps,
      NIMO_PROFILE,
      true,
    )
    expect(result.dropped).toEqual(["bad"])
  })
  test("source offsets survive repeated words, blank lines, tabs, CJK and emoji", () => {
    const text = "  same same\n\n中文\t🙂 repeated repeated  "
    for (const breakMode of ["word", "character", "character-no-hyphen"] as const) {
      const lines = sourceLines(text, 64, {breakMode}, NIMO_PROFILE)
      let end = 0
      for (const line of lines) {
        expect(line.start).toBeGreaterThanOrEqual(end)
        expect(line.end).toBeGreaterThanOrEqual(line.start)
        expect(line.text.replace(/[-\s]/g, "")).toBe(text.slice(line.start, line.end).replace(/\s/g, ""))
        end = line.end
      }
      expect(end).toBe(text.trimEnd().length)
    }
  })
  test("inserted hyphens do not steal a literal hyphen from the next line", () => {
    const text = "abcde-fghijklmnop"
    const lines = sourceLines(text, 48, {breakMode: "word"}, NIMO_PROFILE)
    expect(lines[0]).toEqual({text: "abcde-", start: 0, end: 5})
    expect(lines[1].start).toBe(5)
    expect(text.slice(lines[1].start)).toStartWith("-")
  })
  test("render feedback is opt-in and keyed by the element id", () => {
    const input = [
      {
        type: "text" as const,
        id: "caption",
        box,
        text: "one\ntwo\nthree",
        style: {maxLines: 2, textWindow: "end" as const},
      },
    ]
    const plain = processScene(input, caps, NIMO_PROFILE)
    const feedback = processScene(input, caps, NIMO_PROFILE, true)
    expect(plain.textLayout).toBeUndefined()
    expect(plain.elements).toEqual(feedback.elements)
    expect(feedback.textLayout?.caption.lines).toEqual([
      {text: "two", start: 4, end: 7},
      {text: "three", start: 8, end: 13},
    ])
  })
  for (const profile of [G1_PROFILE, Z100_PROFILE])
    test(`${profile.id} honors tail selection and reserves a footer without rewrapping`, () => {
      const result = degradeTextScene(
        [
          {
            type: "text",
            id: "body",
            box,
            text: "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight",
            style: {maxLines: 8, textWindow: "end"},
          },
          {type: "text", id: "footer", box: {...box, y: 200, h: 20}, text: "0:12", style: {maxLines: 1}},
        ],
        {...caps, canPosition: false},
        profile,
        true,
      )
      expect(result.prewrapped).toBe(true)
      expect(String(result.layout?.text).split("\n").length).toBe(profile.maxLines)
      expect(String(result.layout?.text)).toEndWith("eight\n0:12")
      expect(result.textLayout?.footer.lines[0].text).toBe("0:12")
    })
})
