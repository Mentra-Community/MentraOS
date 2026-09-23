import type {RenderElement, RenderResult} from "@mentra/miniapp/background"
import type {TeleprompterSettings} from "../../shared/types"
import {describe, expect, test} from "bun:test"
import {ScriptEngine} from "../core/ScriptEngine"
import {TeleprompterController} from "./TeleprompterController"
import {processText} from "../../../../../mobile/modules/engine/src/utils/display/scene/text"
import {NIMO_PROFILE} from "../../../../../mobile/modules/engine/src/utils/display/profiles/nimo"

describe("Teleprompter host layout", () => {
  test("load_script reports unavailable lines when no display can provide layout", async () => {
    const controller = new TeleprompterController({storage: {set: async () => {}}} as never)
    Object.assign(controller, {
      engine: new ScriptEngine({numberOfLines: 2}),
      hasDisplay: false,
      ui: {send: () => {}},
    })
    expect(await controller.loadScript("one two three four", false)).toEqual({words: 4, lines: null, started: false})
  })
  test("load_script waits for host layout before returning its line count", async () => {
    let finishRender!: (result: RenderResult) => void
    const session = {
      capabilities: {display: {width: 80, height: 100}},
      display: {
        render: () =>
          new Promise<RenderResult>((resolve) => {
            finishRender = resolve
          }),
      },
      storage: {set: async () => {}},
    }
    const controller = new TeleprompterController(session as never)
    Object.assign(controller, {
      engine: new ScriptEngine({numberOfLines: 2}),
      hasDisplay: true,
      ui: {send: () => {}},
    })
    let returned = false
    const loading = controller.loadScript("one two three four five six", false).then((result) => {
      returned = true
      return result
    })
    await Promise.resolve()
    expect(returned).toBe(false)
    finishRender({
      status: "displayed",
      textLayout: {
        script: {
          lines: [
            {text: "one two", start: 0, end: 7},
            {text: "three four", start: 8, end: 18},
          ],
          lineStarts: [0, 8, 19],
          capacity: 2,
          truncated: true,
        },
      },
    })
    expect(await loading).toEqual({words: 6, lines: 3, started: false})
  })
  test.each([false, true])(
    "load_script follows a replacement render (newest resolves first: %s)",
    async (newestFirst) => {
      const pending: Array<(result: RenderResult) => void> = []
      const controller = new TeleprompterController({
        capabilities: {display: {width: 80, height: 100}},
        display: {render: () => new Promise<RenderResult>((resolve) => pending.push(resolve))},
        storage: {set: async () => {}},
      } as never)
      Object.assign(controller, {engine: new ScriptEngine({numberOfLines: 2}), hasDisplay: true, ui: {send: () => {}}})
      let returned = false
      const loading = controller.loadScript("one two three four", false).then((value) => {
        returned = true
        return value
      })
      const internal = controller as unknown as {render: () => Promise<number | null>; lastRenderedText: string}
      // Foreground/device events force a replacement even for unchanged content.
      internal.lastRenderedText = ""
      const replacement = internal.render()
      const layout: RenderResult = {
        status: "displayed",
        textLayout: {
          script: {
            lines: [
              {text: "one two", start: 0, end: 7},
              {text: "three four", start: 8, end: 18},
            ],
            lineStarts: [0, 8],
            capacity: 2,
            truncated: false,
          },
        },
      }
      if (newestFirst) pending[1](layout)
      pending[0]({status: "displayed"}) // obsolete feedback must not win
      await Promise.resolve()
      expect(returned).toBe(false)
      if (!newestFirst) pending[1](layout)
      expect(await loading).toEqual({words: 4, lines: 2, started: false})
      expect(await replacement).toBe(2)
      expect(await internal.render()).toBe(2) // deduped render shares the known result
    },
  )

  test("stopping cancels a pending layout without a promise cycle", async () => {
    let finish!: (result: RenderResult) => void
    const controller = new TeleprompterController({
      capabilities: {display: {width: 80, height: 100}},
      display: {
        render: () =>
          new Promise<RenderResult>((resolve) => {
            finish = resolve
          }),
      },
      storage: {set: async () => {}},
    } as never)
    Object.assign(controller, {engine: new ScriptEngine({numberOfLines: 2}), hasDisplay: true, ui: {send: () => {}}})
    const loading = controller.loadScript("one two", false)
    controller.stop()
    finish({status: "displayed"})
    expect((await loading).lines).toBeNull()
  })

  test("tracks source words and accepts line boundaries only from render results", () => {
    const engine = new ScriptEngine({numberOfLines: 2})
    engine.setScript("one two three four five six")
    engine.acceptLayout(0, {lines: [], lineStarts: [0, 8, 19], capacity: 2, truncated: true})
    expect(engine.totalWords).toBe(6)
    expect(engine.topLineForWord(2)).toBe(1)
    expect(engine.firstWordOfLine(1)).toBe(2)
    expect(engine.topLineForWord(5)).toBe(1) // final page remains full
    expect(engine.textFrom(engine.sourceStartForLine(1))).toBe("three four five six")
    expect(engine.matchSpoken(["three", "four"], 2)).toBe(4)
    engine.invalidateLayout()
    expect(engine.totalWords).toBe(6)
    engine.setScript("extraordinary words follow")
    engine.acceptLayout(0, {lines: [], lineStarts: [0, 5, 10, 14, 20], capacity: 2, truncated: true})
    expect(engine.firstWordOfLine(1)).toBe(0) // continuation of a hyphenated word
  })
  test("renders replacements, follows voice, steps lines, pins the last page", async () => {
    const sent: RenderElement[][] = []
    const pending: Array<() => void> = []
    const session = {
      capabilities: {display: {width: 80, height: 100}},
      display: {
        render: (elements: RenderElement[]) => {
          sent.push(elements)
          return new Promise<RenderResult>((resolve) =>
            pending.push(() => {
              const textLayout = Object.fromEntries(
                elements
                  .filter((e): e is Extract<RenderElement, {type: "text"}> => e.type === "text")
                  .map((e) => [e.id, processText(e.text, e.box, e.style ?? {}, NIMO_PROFILE).layout]),
              )
              resolve({status: "displayed", textLayout})
            }),
          )
        },
      },
    }
    const controller = new TeleprompterController(session as never) as unknown as {
      engine: ScriptEngine
      settings: TeleprompterSettings
      hasDisplay: boolean
      ui: {send: () => void}
      render: () => void
      currentVisible: string[]
      cursor: number
      nudge: (lines: number) => void
      seek: (percent: number) => void
    }
    controller.engine = new ScriptEngine({numberOfLines: 2})
    controller.engine.setScript("one two three four five six seven eight nine ten eleven twelve")
    controller.settings = {...controller.settings, numberOfLines: 2, lineWidth: 2, showTimecode: false}
    controller.hasDisplay = true
    controller.ui = {send: () => {}}
    controller.render()
    pending.shift()!()
    await Promise.resolve()
    expect(controller.currentVisible).toEqual(["one two", "three four"])
    controller.cursor = controller.engine.matchSpoken(["one", "two"], 0)
    controller.render()
    pending.shift()!()
    await Promise.resolve()
    expect((sent.at(-1)![0] as Extract<RenderElement, {type: "text"}>).text).toStartWith("three four")
    controller.nudge(-1)
    pending.shift()!()
    await Promise.resolve()
    expect((sent.at(-1)![0] as Extract<RenderElement, {type: "text"}>).text).toStartWith("one two")
    controller.seek(95)
    pending.shift()!()
    await Promise.resolve()
    expect(controller.currentVisible).toEqual(["ten eleven", "twelve"])
    controller.cursor = 0
    controller.render()
    controller.settings.lineWidth = 0
    controller.render()
    pending[1]()
    await Promise.resolve()
    const latest = [...controller.currentVisible]
    pending[0]()
    await Promise.resolve()
    expect(controller.currentVisible).toEqual(latest)
  })
})
