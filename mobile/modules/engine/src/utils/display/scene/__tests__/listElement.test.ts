import {describe, expect, test} from "bun:test"

import {G2_PROFILE} from "../../profiles/g2"
import {degradeScene} from "../degrade"
import {diffScene} from "../differ"
import {normalizeListItems, processScene} from "../process"
import type {SceneDisplayCapabilities, SceneElementInput} from "../types"
import {elementContentHash} from "../types"

// Host-side handling of the `list` scene element: budgets, row limits, and the
// text emulation on devices without a native list widget. No hardware here.

const g2Caps: SceneDisplayCapabilities = {
  width: 576,
  height: 288,
  canPosition: true,
  maxTextElements: 6,
  maxImageElements: 4,
  maxListElements: 1,
  maxListItems: 20,
  shapes: ["rect"],
  intensityLevels: 2,
  partialUpdate: true,
}

const noListCaps: SceneDisplayCapabilities = {...g2Caps, maxListElements: 0, maxListItems: 0}

const list = (items: string[], id = "menu"): SceneElementInput => ({
  type: "list",
  id,
  box: {x: 24, y: 16, w: 528, h: 256},
  items,
  style: {border: 1, radius: 8, selectionBorder: true},
})

describe("normalizeListItems", () => {
  test("keeps rows in order, one line each, and blanks empty rows", () => {
    expect(normalizeListItems(["Weather", "Two\nlines", ""], 20)).toEqual({
      rows: ["Weather", "Two lines", " "],
      degraded: false,
    })
  })

  test("drops non-string rows and rows past the device limit, reporting it", () => {
    const result = normalizeListItems(["a", 7, "b", "c"], 2)
    expect(result.rows).toEqual(["a", "b"])
    expect(result.degraded).toBe(true)
  })

  test("clips over-long rows", () => {
    const long = "x".repeat(100)
    const result = normalizeListItems([long], 20)
    expect(result.rows[0]).toHaveLength(64)
    expect(result.degraded).toBe(true)
  })
})

describe("processScene with list elements", () => {
  test("a native-list device keeps the list as its own element with clamped box and rows", () => {
    const result = processScene([list(["One", "Two"])], g2Caps, G2_PROFILE)
    expect(result.degraded).toBe(false)
    expect(result.dropped).toEqual([])
    expect(result.elements).toHaveLength(1)
    const el = result.elements[0]
    expect(el.type).toBe("list")
    expect(el.items).toEqual(["One", "Two"])
    expect(el.box).toEqual({x: 24, y: 16, w: 528, h: 256})
    expect(el.style).toEqual({border: 1, radius: 8, selectionBorder: true})
    expect(el.contentHash).toBe(elementContentHash({type: "list", items: ["One", "Two"], style: el.style}))
  })

  test("lists do not consume the text budget", () => {
    const texts: SceneElementInput[] = Array.from({length: 6}, (_, i) => ({
      type: "text",
      id: `t${i}`,
      box: {x: 0, y: i * 40, w: 200, h: 40},
      text: `row ${i}`,
    }))
    const result = processScene([list(["One"]), ...texts], g2Caps, G2_PROFILE)
    expect(result.dropped).toEqual([])
    expect(result.elements.map((el) => el.type)).toEqual(["list", ...Array(6).fill("text")])
  })

  test("a second list on a one-list device renders as text and is reported", () => {
    const result = processScene([list(["A", "B"], "first"), list(["C", "D"], "second")], g2Caps, G2_PROFILE)
    expect(result.degraded).toBe(true)
    expect(result.dropped).toEqual([])
    expect(result.elements.map((el) => [el.id, el.type])).toEqual([
      ["first", "list"],
      ["second", "text"],
    ])
    expect(result.elements[1].text).toBe("C\nD")
    expect(result.elements[1].style).toEqual({border: 1, radius: 8})
  })

  test("a device without native lists gets the rows as one text element", () => {
    const result = processScene([list(["Weather", "Timer", "Help"])], noListCaps, G2_PROFILE)
    expect(result.degraded).toBe(true)
    expect(result.dropped).toEqual([])
    expect(result.elements).toHaveLength(1)
    expect(result.elements[0].type).toBe("text")
    expect(result.elements[0].text).toBe("Weather\nTimer\nHelp")
  })

  test("row overflow past maxListItems is trimmed tail-first and reported", () => {
    const rows = Array.from({length: 25}, (_, i) => `Row ${i}`)
    const result = processScene([list(rows)], g2Caps, G2_PROFILE)
    expect(result.degraded).toBe(true)
    expect(result.dropped).toEqual([])
    expect(result.elements[0].items).toHaveLength(20)
    expect(result.elements[0].items?.[19]).toBe("Row 19")
  })

  test("an empty list is dropped and reported", () => {
    const result = processScene([list([])], g2Caps, G2_PROFILE)
    expect(result.degraded).toBe(true)
    expect(result.dropped).toEqual(["menu"])
    expect(result.elements).toEqual([])
  })
})

describe("diffScene with list elements", () => {
  test("changed rows are an update, same rows are unchanged, and rows cross the bridge", () => {
    const first = processScene([list(["One", "Two"])], g2Caps, G2_PROFILE)
    let counter = 0
    const frame1 = diffScene([], first.elements, () => `~${++counter}`)
    expect(frame1.elements[0].change).toBe("created")
    expect(frame1.elements[0].items).toEqual(["One", "Two"])

    const same = processScene([list(["One", "Two"])], g2Caps, G2_PROFILE)
    expect(diffScene(frame1.elements, same.elements, () => `~${++counter}`).elements[0].change).toBe("unchanged")

    const changed = processScene([list(["One", "Three"])], g2Caps, G2_PROFILE)
    expect(diffScene(frame1.elements, changed.elements, () => `~${++counter}`).elements[0].change).toBe("updated")
  })

  test("row boundaries are part of the content hash", () => {
    const a = elementContentHash({type: "list", items: ["ab", "c"]})
    const b = elementContentHash({type: "list", items: ["a", "bc"]})
    expect(a).not.toBe(b)
  })
})

describe("degradeScene with list elements", () => {
  test("rows collapse into the text wall in reading order and the loss of selection is reported", () => {
    const result = degradeScene([
      {type: "text", id: "title", box: {x: 0, y: 0, w: 576, h: 40}, text: "Menu"},
      list(["Weather", "Timer"]),
    ])
    expect(result.degraded).toBe(true)
    expect(result.dropped).toEqual([])
    expect(result.layout).toEqual({layoutType: "text_wall", text: "Menu\n\nWeather\nTimer"})
  })
})
