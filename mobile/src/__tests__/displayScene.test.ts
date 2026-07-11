/**
 * Scene pipeline tests — differ / process (clamp, budget, wrap) / degrade /
 * store. Island module source is imported by path (island's own test runner is
 * bit-rotted; mobile jest is the harness for island logic).
 *
 * The degrade "golden" tests pin the sugar-equivalence guarantee: a sugar-shaped
 * scene must degrade to EXACTLY the legacy layout sugar used to emit, because
 * everything downstream of that layout (DisplayProcessor wrap, ColumnComposer)
 * is unchanged — byte-identical output on G1/Z100 follows by construction.
 */

import {diffScene, type DiffableElement} from "../../modules/engine/src/utils/display/scene/differ"
import {degradeScene} from "../../modules/engine/src/utils/display/scene/degrade"
import {processScene, profileLineHeightPx} from "../../modules/engine/src/utils/display/scene/process"
import {SceneStore} from "../../modules/engine/src/utils/display/scene/store"
import {
  elementContentHash,
  type FrameElement,
  type SceneDisplayCapabilities,
  type SceneElementInput,
} from "../../modules/engine/src/utils/display/scene/types"
import {G1_PROFILE} from "../../modules/engine/src/utils/display/profiles/g1"
import {NEX_PROFILE} from "../../modules/engine/src/utils/display/profiles/nex"

// ── helpers ────────────────────────────────────────────────────────────

const CAPS: SceneDisplayCapabilities = {
  width: 500,
  height: 220,
  canPosition: true,
  maxTextElements: 6,
  maxImageElements: 4,
  maxImagePx: {width: 200, height: 200},
  shapes: ["rect"],
  intensityLevels: 2,
  partialUpdate: true,
}

function textEl(id: string | undefined, x: number, y: number, w: number, h: number, text: string): SceneElementInput {
  return {type: "text", ...(id ? {id} : {}), box: {x, y, w, h}, text}
}

function imgEl(id: string | undefined, x: number, y: number, w: number, h: number, data = "AAAA"): SceneElementInput {
  return {type: "image", ...(id ? {id} : {}), box: {x, y, w, h}, data}
}

function frameEl(partial: Partial<FrameElement> & Pick<FrameElement, "id" | "type" | "box">): FrameElement {
  return {
    change: "created",
    contentHash: elementContentHash({type: partial.type, text: partial.text, data: partial.data, style: partial.style}),
    ...partial,
  }
}

function diffable(el: {
  id?: string
  type: "text" | "image" | "rect"
  box: FrameElement["box"]
  text?: string
  data?: string
}): DiffableElement {
  return {...el, contentHash: elementContentHash(el)}
}

let synthCounter = 0
const synth = () => `~${++synthCounter}`
beforeEach(() => {
  synthCounter = 0
})

// ── differ ─────────────────────────────────────────────────────────────

describe("diffScene", () => {
  const box = {x: 0, y: 0, w: 100, h: 40}

  it("classifies content-only change on a stable id as updated (never rebuild)", () => {
    const prev = [frameEl({id: "cap", type: "text", box, text: "hello"})]
    const next = [diffable({id: "cap", type: "text", box, text: "world"})]
    const {elements, removed} = diffScene(prev, next, synth)
    expect(elements[0].change).toBe("updated")
    expect(removed).toEqual([])
  })

  it("classifies identical content as unchanged", () => {
    const prev = [frameEl({id: "cap", type: "text", box, text: "hello"})]
    const next = [diffable({id: "cap", type: "text", box, text: "hello"})]
    expect(diffScene(prev, next, synth).elements[0].change).toBe("unchanged")
  })

  it("classifies a box change as moved", () => {
    const prev = [frameEl({id: "cap", type: "text", box, text: "hello"})]
    const next = [diffable({id: "cap", type: "text", box: {...box, x: 10}, text: "hello"})]
    expect(diffScene(prev, next, synth).elements[0].change).toBe("moved")
  })

  it("computes removed as prev ids absent from next", () => {
    const prev = [
      frameEl({id: "a", type: "text", box, text: "1"}),
      frameEl({id: "b", type: "text", box: {...box, y: 50}, text: "2"}),
    ]
    const next = [diffable({id: "a", type: "text", box, text: "1"})]
    expect(diffScene(prev, next, synth).removed).toEqual(["b"])
  })

  it("matches no-id elements by (type, box) and inherits the assigned id", () => {
    const prev = [frameEl({id: "~7", type: "text", box, text: "hello"})]
    const next = [diffable({type: "text", box, text: "world"})]
    const {elements, removed} = diffScene(prev, next, synth)
    expect(elements[0].id).toBe("~7")
    expect(elements[0].change).toBe("updated")
    expect(removed).toEqual([])
  })

  it("matches remaining no-id elements by type + order", () => {
    const prev = [
      frameEl({id: "~1", type: "text", box, text: "a"}),
      frameEl({id: "~2", type: "text", box: {...box, y: 50}, text: "b"}),
    ]
    // Both boxes changed — falls through to order-within-type matching.
    const next = [
      diffable({type: "text", box: {...box, y: 5}, text: "a"}),
      diffable({type: "text", box: {...box, y: 60}, text: "b"}),
    ]
    const {elements, removed} = diffScene(prev, next, synth)
    expect(elements.map((e) => e.id)).toEqual(["~1", "~2"])
    expect(elements.map((e) => e.change)).toEqual(["moved", "moved"])
    expect(removed).toEqual([])
  })

  it("mints synthetic ids for unmatched new elements", () => {
    const {elements} = diffScene([], [diffable({type: "text", box, text: "x"})], synth)
    expect(elements[0].id).toBe("~1")
    expect(elements[0].change).toBe("created")
  })

  it("does not cross-match explicit ids with different types", () => {
    const prev = [frameEl({id: "x", type: "text", box, text: "t"})]
    const next = [diffable({id: "x", type: "image", box, data: "AAAA"})]
    const {elements, removed} = diffScene(prev, next, synth)
    expect(elements[0].change).toBe("created")
    expect(removed).toEqual(["x"])
  })
})

// ── process: clamp / budget / image limits / wrap ──────────────────────

describe("processScene", () => {
  it("clamps out-of-bounds text boxes and reports degraded", () => {
    const {elements, degraded} = processScene([textEl("t", 450, 200, 100, 60, "hi")], CAPS, NEX_PROFILE)
    expect(elements[0].box).toEqual({x: 450, y: 200, w: 50, h: 20})
    expect(degraded).toBe(true)
  })

  it("drops elements fully outside the canvas", () => {
    const {elements, dropped} = processScene([textEl("t", 600, 0, 50, 50, "hi")], CAPS, NEX_PROFILE)
    expect(elements).toEqual([])
    expect(dropped).toEqual(["t"])
  })

  it("drops images whose box was clamped (no host-side crop)", () => {
    const {elements, dropped} = processScene([imgEl("m", 450, 0, 100, 100)], CAPS, NEX_PROFILE)
    expect(elements).toEqual([])
    expect(dropped).toEqual(["m"])
  })

  it("drops images exceeding maxImagePx", () => {
    const {dropped, degraded} = processScene([imgEl("big", 0, 0, 300, 150)], CAPS, NEX_PROFILE)
    expect(dropped).toEqual(["big"])
    expect(degraded).toBe(true)
  })

  it("keeps images inside limits", () => {
    const {elements, dropped} = processScene([imgEl("map", 335, 14, 150, 150)], CAPS, NEX_PROFILE)
    expect(elements).toHaveLength(1)
    expect(dropped).toEqual([])
  })

  it("drops the tail past the text budget, with rects sharing the pool", () => {
    const els: SceneElementInput[] = []
    for (let i = 0; i < 6; i++) els.push(textEl(`t${i}`, 0, i * 30, 100, 25, `line${i}`))
    els.push({type: "rect", id: "r", box: {x: 0, y: 190, w: 100, h: 20}})
    const {elements, dropped, degraded} = processScene(els, CAPS, NEX_PROFILE)
    expect(elements).toHaveLength(6)
    expect(dropped).toEqual(["r"])
    expect(degraded).toBe(true)
  })

  it("drops duplicate explicit ids, first occurrence wins", () => {
    const {elements, dropped} = processScene(
      [textEl("dup", 0, 0, 100, 30, "first"), textEl("dup", 0, 50, 100, 30, "second")],
      CAPS,
      NEX_PROFILE,
    )
    expect(elements).toHaveLength(1)
    expect(elements[0].text).toBe("first")
    expect(dropped).toEqual(["dup"])
  })

  it("pre-wraps text into the box (newlines inserted at box width)", () => {
    const {elements} = processScene(
      [textEl("t", 0, 0, 120, 220, "a few words that cannot possibly fit on one narrow line")],
      CAPS,
      NEX_PROFILE,
    )
    const lines = (elements[0].text ?? "").split("\n")
    expect(lines.length).toBeGreaterThan(1)
  })

  it("bounds line count by box height ONLY with a calibrated lineHeightPx", () => {
    // Uncalibrated profile: no host-side height clipping — the firmware clips
    // in-box (legacy behavior; hardware showed derived line heights clip real
    // content).
    const tall = textEl("t", 0, 0, 120, 27, "many words that would wrap onto lots and lots of lines")
    const uncalibrated = processScene([tall], CAPS, NEX_PROFILE)
    expect((uncalibrated.elements[0].text ?? "").split("\n").length).toBeGreaterThan(1)

    // Calibrated profile: box height ÷ lineHeightPx bounds the line count.
    const calibrated = {...NEX_PROFILE, lineHeightPx: 27}
    expect(profileLineHeightPx(calibrated, CAPS.height)).toBe(27)
    const {elements, degraded} = processScene([tall], CAPS, calibrated)
    expect((elements[0].text ?? "").split("\n")).toHaveLength(1)
    expect(degraded).toBe(true)
  })

  it("appends an ellipsis on truncation when overflow=ellipsis", () => {
    const el: SceneElementInput = {
      type: "text",
      id: "t",
      box: {x: 0, y: 0, w: 120, h: 27},
      text: "many words that would wrap onto lots and lots of lines",
      style: {overflow: "ellipsis"},
    }
    const {elements} = processScene([el], CAPS, {...NEX_PROFILE, lineHeightPx: 27})
    expect(elements[0].text?.endsWith("…")).toBe(true)
  })

  it("budget re-entry: an element dropped last frame diffs as created when it fits", () => {
    const store = new SceneStore()
    const tight = {...CAPS, maxTextElements: 1}
    const two = [textEl("a", 0, 0, 100, 30, "a"), textEl("b", 0, 50, 100, 30, "b")]
    const p1 = processScene(two, tight, NEX_PROFILE)
    expect(p1.dropped).toEqual(["b"])
    const d1 = diffScene(store.lastFrame("app", "main"), p1.elements, store.nextSyntheticId("app", "main"))
    store.commit("app", "main", d1.elements)

    const p2 = processScene([two[1]], tight, NEX_PROFILE)
    const d2 = diffScene(store.lastFrame("app", "main"), p2.elements, store.nextSyntheticId("app", "main"))
    expect(d2.elements[0].id).toBe("b")
    expect(d2.elements[0].change).toBe("created")
    expect(d2.removed).toEqual(["a"])
  })
})

// ── degrade (canPosition: false) ───────────────────────────────────────

describe("degradeScene", () => {
  it("GOLDEN: sugar showTextWall shape degrades to exactly the legacy text_wall layout", () => {
    // showTextWall(text) compiles to one full-canvas text element; degrade must
    // emit the byte-identical legacy layout so the unchanged downstream path
    // (DisplayProcessor wrap) produces exactly today's output.
    const raw = "Hello from a caption line"
    const scene = [textEl(undefined, 0, 0, 500, 220, raw)]
    expect(degradeScene(scene)).toEqual({
      layout: {layoutType: "text_wall", text: raw},
      degraded: false,
      dropped: [],
    })
  })

  it("GOLDEN: sugar showDoubleTextWall shape degrades to exactly the legacy double_text_wall layout", () => {
    // Two side-by-side boxes → the shipped ColumnComposer mechanism downstream.
    const scene = [textEl(undefined, 0, 0, 250, 220, "left col"), textEl(undefined, 250, 0, 250, 220, "right col")]
    expect(degradeScene(scene)).toEqual({
      layout: {layoutType: "double_text_wall", topText: "left col", bottomText: "right col"},
      degraded: false,
      dropped: [],
    })
  })

  it("orders columns by x regardless of array order", () => {
    const scene = [textEl(undefined, 250, 0, 250, 220, "right"), textEl(undefined, 0, 0, 250, 220, "left")]
    const {layout} = degradeScene(scene)
    expect(layout).toMatchObject({topText: "left", bottomText: "right"})
  })

  it("collapses stacked text in reading order joined by blank lines", () => {
    const scene = [
      textEl("bottom", 0, 180, 500, 40, "stats"),
      textEl("top", 0, 0, 500, 40, "title"),
      textEl("mid", 0, 90, 500, 40, "body"),
    ]
    expect(degradeScene(scene).layout).toEqual({layoutType: "text_wall", text: "title\n\nbody\n\nstats"})
  })

  it("does not column-compose 3+ texts even when side-by-side (scope guard)", () => {
    const scene = [
      textEl(undefined, 0, 0, 160, 220, "a"),
      textEl(undefined, 170, 0, 160, 220, "b"),
      textEl(undefined, 340, 0, 160, 220, "c"),
    ]
    expect(degradeScene(scene).layout?.layoutType).toBe("text_wall")
  })

  it("drops images with report, rects silently", () => {
    const scene: SceneElementInput[] = [
      textEl("t", 0, 0, 500, 100, "text"),
      imgEl("map", 0, 100, 100, 100),
      {type: "rect", box: {x: 0, y: 0, w: 500, h: 220}},
    ]
    const {layout, degraded, dropped} = degradeScene(scene)
    expect(layout).toEqual({layoutType: "text_wall", text: "text"})
    expect(degraded).toBe(true)
    expect(dropped).toEqual(["map"])
  })

  it("returns null layout for an all-image scene (caller clears + app can detect via dropped)", () => {
    const {layout, dropped} = degradeScene([imgEl("only", 0, 0, 100, 100)])
    expect(layout).toBeNull()
    expect(dropped).toEqual(["only"])
  })
})

// ── store: replay / epoch ──────────────────────────────────────────────

describe("SceneStore", () => {
  it("builds replay frames all-created with a bumped epoch (replay is create-based)", () => {
    const store = new SceneStore()
    const els = [
      frameEl({id: "a", type: "text", box: {x: 0, y: 0, w: 100, h: 40}, text: "t", change: "updated"}),
      frameEl({id: "b", type: "image", box: {x: 0, y: 50, w: 100, h: 100}, data: "AA", change: "unchanged"}),
    ]
    store.commit("app", "main", els)
    const epochBefore = store.currentEpoch("app", "main")
    const frame = store.buildReplayFrame("app", "main")
    expect(frame?.replay).toBe(true)
    expect(frame?.sceneEpoch).toBe(epochBefore + 1)
    expect(frame?.elements.map((e) => e.change)).toEqual(["created", "created"])
    expect(frame?.removed).toEqual([])
  })

  it("returns null replay when nothing is retained", () => {
    expect(new SceneStore().buildReplayFrame("app", "main")).toBeNull()
  })

  it("bumpEpoch resets the diff baseline", () => {
    const store = new SceneStore()
    store.commit("app", "main", [frameEl({id: "a", type: "text", box: {x: 0, y: 0, w: 10, h: 10}, text: "x"})])
    store.bumpEpoch("app", "main")
    expect(store.lastFrame("app", "main")).toEqual([])
  })

  it("clear(app) forgets all views for the app", () => {
    const store = new SceneStore()
    store.commit("app", "main", [frameEl({id: "a", type: "text", box: {x: 0, y: 0, w: 10, h: 10}, text: "x"})])
    store.clear("app")
    expect(store.hasScene("app", "main")).toBe(false)
  })

  it("markViewStale keeps the replay source but forces the next diff from empty (durationMs expiry)", () => {
    // Regression: app renders with durationMs → expiry sends clear_view → app
    // re-renders IDENTICAL elements. With the baseline intact they'd all diff
    // to "unchanged" and never repaint onto the now-blank glasses.
    const store = new SceneStore()
    const els = [frameEl({id: "a", type: "text", box: {x: 0, y: 0, w: 100, h: 40}, text: "hello"})]
    store.commit("app", "main", els)

    store.markViewStale("main")

    // Replay source survives (restore-as-replay is create-based).
    expect(store.buildReplayFrame("app", "main")).not.toBeNull()
    expect(store.isBaselineStale("app", "main")).toBe(true)

    // The next incremental diff must run against EMPTY, so the identical
    // element comes back as "created", not "unchanged".
    const prev = store.isBaselineStale("app", "main") ? [] : store.lastFrame("app", "main")
    const next: DiffableElement[] = [
      {id: "a", type: "text", box: {x: 0, y: 0, w: 100, h: 40}, text: "hello", contentHash: els[0].contentHash},
    ]
    const {elements} = diffScene(prev, next, store.nextSyntheticId("app", "main"))
    expect(elements.map((e) => e.change)).toEqual(["created"])

    // Committing the re-render clears the flag.
    store.commit("app", "main", elements)
    expect(store.isBaselineStale("app", "main")).toBe(false)
  })
})
