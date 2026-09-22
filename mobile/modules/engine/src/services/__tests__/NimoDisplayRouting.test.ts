import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"

import type {DisplayRequestResult} from "../LocalDisplayManager"
import type {SceneElementInput, SceneFrame} from "../../utils/display/scene/types"

// Exercise the real processor, scene pipeline and arbitration. Only their
// native transport and store boundaries are replaced, as in the existing
// LocalDisplayManager suite. No Bluetooth calls or native modules are loaded.
const sent: {view?: string; scene?: SceneFrame; layout?: Record<string, unknown>}[] = []
const mirrors: unknown[] = []
let selectedModel = "NIMO"

mock.module("@mentra/bluetooth-sdk/internal", () => ({
  default: {
    displayEvent: (event: (typeof sent)[number]) => {
      sent.push(event)
      return Promise.resolve()
    },
  },
}))
// Resolve the pure source contract even before workspace packages are built.
mock.module("@mentra/miniapp/hardware", () => require("../../../../miniapp/src/hardware"))
mock.module("../../stores/settings", () => ({
  SETTINGS: {default_wearable: {key: "default_wearable"}},
  useSettingsStore: {getState: () => ({getSetting: () => selectedModel})},
}))
mock.module("../../stores/glasses", () => ({
  useGlassesStore: {
    getState: () => ({connection: {state: "connected", fullyBooted: true}, deviceModel: selectedModel}),
    subscribe: () => () => {},
  },
}))
mock.module("../../stores/display", () => ({
  useDisplayStore: {getState: () => ({setDisplayEvent: (event: unknown) => mirrors.push(event)})},
}))
mock.module("../GlassesReadiness", () => ({
  isGlassesConnected: (connection: {state: string}) => connection.state === "connected",
}))
mock.module("../../utils/timers", () => ({
  BgTimer: {
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  },
}))

const {default: displayProcessor} = require("../DisplayProcessor") as typeof import("../DisplayProcessor")
const {default: localDisplayManager} = require("../LocalDisplayManager") as typeof import("../LocalDisplayManager")
const {default: sceneRenderer} = require("../SceneRenderer") as typeof import("../SceneRenderer")
const {TextMeasurer, TextWrapper} = require("../../utils/display") as typeof import("../../utils/display")

// A valid 1×1 PNG. The scene layer must keep the encoded image intact; native
// owns decoding/resizing/quantization to the declared destination box.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="

function scene(): SceneElementInput[] {
  return [
    {type: "text", id: "instruction", box: {x: 12, y: 20, w: 280, h: 40}, text: "Turn left\nonto Main Street"},
    {type: "rect", id: "outline", box: {x: 0, y: 0, w: 500, h: 220}, style: {border: 2, radius: 8}},
    {type: "image", id: "maneuver", box: {x: 320, y: 20, w: 160, h: 160}, data: PNG},
  ]
}

function lastScene(): SceneFrame {
  const frame = sent.at(-1)?.scene
  expect(frame).toBeDefined()
  if (!frame) throw new Error("Expected a positioned SceneFrame")
  return frame
}

beforeEach(() => {
  selectedModel = "NIMO"
  displayProcessor.setDeviceModel(selectedModel)
  localDisplayManager._resetForTest()
  sent.length = 0
  mirrors.length = 0
})

afterEach(() => {
  localDisplayManager._resetForTest()
})

describe("NIMO display profile", () => {
  test.each(["NIMO", "Nimo", "nimo", "Nimo-7188", "NIMO Smart Glasses"])("selects NIMO for %s", (model) => {
    displayProcessor.setDeviceModel(model)
    expect(displayProcessor.getDeviceModel()).toBe("nimo")
    expect(displayProcessor.getProfile()).toMatchObject({
      id: "nimo",
      displayWidthPx: 500,
      displayHeightPx: 220,
      maxLines: 11,
      lineHeightPx: 20,
    })
  })

  test("does not change other models or the unknown-model fallback", () => {
    displayProcessor.setDeviceModel("Even Realities G2")
    expect(displayProcessor.getProfile().id).toBe("even-realities-g2")
    displayProcessor.setDeviceModel("unrecognized glasses")
    expect(displayProcessor.getProfile().id).toBe("even-realities-g1")
    for (const model of ["Animotion", "Nimology", "ANIMO", "NIMO2", " NIMOBUS "]) {
      displayProcessor.setDeviceModel(model)
      expect(displayProcessor.getDeviceModel()).toBe("unknown")
      expect(displayProcessor.getProfile().id).toBe("even-realities-g1")
    }
    displayProcessor.setDeviceModel(" \tnImO \n")
    expect(displayProcessor.getDeviceModel()).toBe("nimo")
  })

  test("uses deterministic font-0 estimates at ASCII and CJK wrap boundaries", () => {
    const measurer = new TextMeasurer(displayProcessor.getProfile())
    const wrapper = new TextWrapper(measurer, {breakMode: "character-no-hyphen"})
    expect(measurer.measureText("A中")).toBe(24)
    expect(wrapper.wrap("A".repeat(63)).lines).toEqual(["A".repeat(62), "A"])
    expect(wrapper.wrap("中".repeat(32)).lines).toEqual(["中".repeat(31), "中"])
    expect(wrapper.wrap("ABCD", {maxWidthPx: 31}).lines).toEqual(["ABC", "D"])
  })

  test("preserves explicit newlines and clips a text box to its line-height policy", () => {
    localDisplayManager.request("com.test.captions", {
      view: "main",
      scene: [{type: "text", id: "caption", box: {x: 0, y: 0, w: 500, h: 40}, text: "one\ntwo\nthree"}],
    })
    expect(lastScene().elements[0].text).toBe("one\ntwo")
  })
})

describe("NIMO positioned scene routing", () => {
  test("uses the logical canvas, not the physical panel or old notes placeholder", () => {
    expect(sceneRenderer.currentCapabilities()).toEqual({
      width: 500,
      height: 220,
      canPosition: true,
      maxTextElements: 32,
      maxImageElements: 4,
      maxImagePx: {width: 200, height: 200},
      shapes: ["rect"],
      intensityLevels: 4,
      partialUpdate: false,
    })
  })

  test.each(["NIMO", "Nimo", "Nimo-7188"])("keeps %s on the positioning path", (model) => {
    selectedModel = model
    displayProcessor.setDeviceModel(model)
    expect(sceneRenderer.currentCapabilities()?.canPosition).toBe(true)
    localDisplayManager.request("com.test.maps", {view: "main", scene: scene()})
    expect(lastScene().elements).toHaveLength(3)
  })

  test.each(["main", "dashboard"] as const)("retains positioned text, rectangle and PNG in %s", (view) => {
    let result: DisplayRequestResult | undefined
    localDisplayManager.request("com.test.maps", {view, scene: scene()}, (value) => (result = value))
    expect(result).toEqual({status: "displayed", degraded: false, dropped: []})
    const frame = lastScene()
    expect(frame.view).toBe(view)
    expect(frame.elements).toHaveLength(3)
    for (const element of scene()) {
      expect(frame.elements.find((candidate) => candidate.id === element.id)).toMatchObject(element)
    }
    expect(sent.at(-1)?.layout).toBeUndefined()
    expect(mirrors.at(-1)).toMatchObject({
      view,
      layout: {layoutType: "scene", width: 500, height: 220, elements: frame.elements},
    })
  })

  test("converts legacy captions into a full logical-canvas text scene", () => {
    localDisplayManager.request("com.test.captions", {
      view: "main",
      layout: {layoutType: "text_wall", text: "Caption one\nCaption two"},
    })
    expect(lastScene().elements).toEqual([
      expect.objectContaining({
        type: "text",
        id: "sugar:wall",
        box: {x: 0, y: 0, w: 500, h: 220},
        text: "Caption one\nCaption two",
      }),
    ])
  })

  test("preserves legacy bitmap position and encoded pixels on the rich path", () => {
    localDisplayManager.request("com.test.maps", {
      view: "main",
      layout: {layoutType: "bitmap_view", x: 40, y: 25, width: 150, height: 150, data: PNG},
    })
    expect(lastScene().elements[0]).toMatchObject({
      type: "image",
      box: {x: 40, y: 25, w: 150, h: 150},
      data: PNG,
    })
  })

  test("retains unchanged elements alongside updates for complete native replacement", () => {
    const elements = scene()
    localDisplayManager.request("com.test.maps", {view: "main", scene: elements})
    const updated = elements.map((element) => (element.type === "text" ? {...element, text: "Turn right"} : element))
    localDisplayManager.request("com.test.maps", {view: "main", scene: updated})
    expect(lastScene().elements.map(({id, change}) => ({id, change}))).toEqual([
      {id: "instruction", change: "updated"},
      {id: "outline", change: "unchanged"},
      {id: "maneuver", change: "unchanged"},
    ])
    localDisplayManager.request("com.test.maps", {view: "main", scene: updated.slice(0, 1)})
    expect(lastScene().elements).toHaveLength(1)
    expect(lastScene().removed).toEqual(["outline", "maneuver"])
  })

  test("reports over-policy images rather than pretending they can be rendered", () => {
    localDisplayManager.request("com.test.maps", {view: "main", scene: scene()})
    expect(lastScene().elements.map(({id}) => id)).toEqual(["instruction", "outline", "maneuver"])
    let result: DisplayRequestResult | undefined
    localDisplayManager.request(
      "com.test.maps",
      {view: "main", scene: [{type: "image", id: "oversized", box: {x: 0, y: 0, w: 201, h: 200}, data: PNG}]},
      (value) => (result = value),
    )
    expect(result).toEqual({status: "displayed", degraded: true, dropped: ["oversized"]})
    expect(sent).toHaveLength(2)
    expect(lastScene().elements).toEqual([])
    expect(lastScene().removed).toEqual(["instruction", "outline", "maneuver"])
  })
})

describe("render text feedback and source replay", () => {
  test("feedback and replay preserve text-only columns and stacked spacing", () => {
    for (const model of ["Even Realities G1", "Vuzix Z100"]) {
      selectedModel = model
      for (const y of [0, 100]) {
        const elements: SceneElementInput[] = [
          {type: "text", id: "left", box: {x: 0, y: 0, w: 200, h: 100}, text: "Left column"},
          {type: "text", id: "right", box: {x: 200, y, w: 200, h: 100}, text: "Right column"},
        ]
        localDisplayManager.request("com.app.text", {scene: elements})
        const before = sent.at(-1)?.layout
        let result: DisplayRequestResult | undefined
        localDisplayManager.request(
          "com.app.text",
          {scene: elements, includeTextLayout: true},
          (value) => (result = value),
        )
        expect(sent.at(-1)?.layout).toEqual(before)
        expect(result?.textLayout?.left.lines.map((line) => line.text)).toEqual(["Left column"])
        expect(result?.textLayout?.right.lines.map((line) => line.text)).toEqual(["Right column"])
        localDisplayManager.replayCurrent()
        expect(sent.at(-1)?.layout).toEqual(before)
      }
    }
  })
  test("returns host line boundaries and only sends the selected tail", () => {
    let result: DisplayRequestResult | undefined
    localDisplayManager.request(
      "com.app.text",
      {
        includeTextLayout: true,
        scene: [
          {
            type: "text",
            id: "caption",
            box: {x: 0, y: 0, w: 500, h: 220},
            text: "one\ntwo\nthree\nfour",
            style: {maxLines: 2, textWindow: "end"},
          },
        ],
      },
      (value) => (result = value),
    )
    expect(lastScene().elements[0].text).toBe("three\nfour")
    expect(result?.textLayout?.caption.lines.map((line) => line.start)).toEqual([8, 14])
    expect(result?.textLayout?.caption.lineStarts).toEqual([0, 4, 8, 14])
  })

  test("replays original source through the current device profile", () => {
    const source: SceneElementInput[] = [
      {
        type: "text",
        id: "caption",
        box: {x: 0, y: 0, w: 100, h: 220},
        text: "one two three four five six seven eight nine ten eleven twelve",
        style: {maxLines: 3, textWindow: "end"},
      },
    ]
    localDisplayManager.request("com.app.text", {scene: source})
    const nimoText = lastScene().elements[0].text
    selectedModel = "Even Realities G2"
    localDisplayManager.replayCurrent()
    expect(lastScene().replay).toBe(true)
    const g2Text = lastScene().elements[0].text
    expect(g2Text).not.toBe(nimoText)
    expect(g2Text).toEndWith("twelve")
    selectedModel = "Even Realities G1"
    localDisplayManager.replayCurrent()
    expect(sent.at(-1)?.layout?.layoutType).toBe("text_wall")
    expect(String(sent.at(-1)?.layout?.text).replace(/\n/g, "")).toEndWith("twelve")
  })
})
