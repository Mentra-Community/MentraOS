import {afterEach, describe, expect, test} from "bun:test"
import type {MiniappSession, RenderElement} from "@mentra/miniapp"

import {DisplayManager} from "../background/managers/DisplayManager"
import {NavigationController} from "../background/NavigationController"
import {borderTestImageBase64} from "../background/lib/bmp"

// Rendered widths from the calibrated G2 font profile. All digits except 1
// occupy 12px; 1 occupies 8px; the colon occupies 4px.
const G2_DIGIT_WIDTH_PX = 12
const G2_COLON_WIDTH_PX = 4
const G2_NATIVE_HORIZONTAL_PADDING_PX = 8
const G2_LINE_HEIGHT_PX = 40

function makeNimoDisplay() {
  const frames: RenderElement[][] = []
  const session = {
    capabilities: {
      modelName: "NIMO",
      display: {width: 500, height: 220, canPosition: true, maxImagePx: {width: 200, height: 200}},
    },
    display: {render: (elements: RenderElement[]) => frames.push(elements)},
  } as unknown as MiniappSession
  return {frames, session, display: new DisplayManager(session)}
}

describe("navigation capability-bounded bitmaps", () => {
  const setTimeoutOriginal = globalThis.setTimeout
  afterEach(() => {
    globalThis.setTimeout = setTimeoutOriginal
  })

  test("ignores large-map requests on text-only displays without taking over the HUD", () => {
    const {frames, session} = makeNimoDisplay()
    session.capabilities = {display: {width: 576, height: 288, canPosition: false, maxImageElements: 0}}
    const controller = new NavigationController(session) as unknown as {
      showLargeMap(): void
      renderLargeMap(position: {lat: number; lng: number}): void
      largeMapShown: boolean
      largeMapTransitioning: boolean
    }
    expect(() => controller.showLargeMap()).not.toThrow()
    expect(() => controller.renderLargeMap({lat: 37.77, lng: -122.42})).not.toThrow()
    expect(controller.largeMapShown).toBe(false)
    expect(controller.largeMapTransitioning).toBe(false)
    expect(frames).toEqual([])
  })

  test("repaints the HUD when only bitmap capability disappears", () => {
    const {frames, session} = makeNimoDisplay()
    const controller = new NavigationController(session) as unknown as {
      applyCapabilities(raw: MiniappSession["capabilities"]): void
      largeMapShown: boolean
      broadcastVoiceGuidanceState(): void
    }
    controller.broadcastVoiceGuidanceState = () => {}
    session.capabilities = {...session.capabilities, hasDisplay: true}
    controller.applyCapabilities(session.capabilities)
    controller.largeMapShown = true
    session.capabilities = {...session.capabilities, display: {...session.capabilities?.display, maxImageElements: 0}}
    controller.applyCapabilities(session.capabilities)
    expect(controller.largeMapShown).toBe(false)
    expect(frames.at(-1)?.some((el) => el.type === "text" && el.text.includes("Welcome to Mentra Maps"))).toBe(true)
  })

  test("renders the real large-map raster and matching placement inside NIMO limits", () => {
    const {frames, session} = makeNimoDisplay()
    const controller = new NavigationController(session) as unknown as {
      renderLargeMap: (position: {lat: number; lng: number}) => void
    }
    controller.renderLargeMap({lat: 37.77, lng: -122.42})
    const image = frames.at(-1)?.[0]
    expect(image?.type).toBe("image")
    if (image?.type !== "image") throw new Error("large map did not render an image")
    expect(image.box).toEqual({x: 150, y: 40, w: 200, h: 140})
    const bmp = Buffer.from(image.data, "base64")
    expect(bmp.readUInt32LE(18)).toBe(image.box.w)
    expect(bmp.readUInt32LE(22)).toBe(image.box.h)
  })

  test("centers existing raw images without changing their declared raster size", () => {
    const {frames, display} = makeNimoDisplay()
    display.showRawBitmap(borderTestImageBase64(100, 80), 100, 80)
    expect(frames.at(-1)?.[0]?.box).toEqual({x: 200, y: 70, w: 100, h: 80})
  })

  test("generates diagnostics at the same dimensions as their device-centered box", () => {
    const callbacks: Array<() => void> = []
    globalThis.setTimeout = ((cb: () => void) => {
      callbacks.push(cb)
      return 1
    }) as unknown as typeof setTimeout
    const {frames, display} = makeNimoDisplay()
    for (const render of [() => display.showTestBox(200, 100), () => display.showBitmapSize(200, 100)]) {
      render()
      callbacks.shift()?.()
      const image = frames.at(-1)?.[0]
      expect(image?.type).toBe("image")
      if (image?.type !== "image") throw new Error("diagnostic did not render an image")
      expect(image.box).toEqual({x: 150, y: 60, w: 200, h: 100})
      const bmp = Buffer.from(image.data, "base64")
      expect(bmp.readUInt32LE(18)).toBe(200)
      expect(bmp.readUInt32LE(22)).toBe(100)
    }
  })

  test("rejects invalid and oversized diagnostics before clearing or sending a frame", () => {
    globalThis.setTimeout = (() => 1) as unknown as typeof setTimeout
    const {frames, display} = makeNimoDisplay()
    for (const [w, h] of [
      [288, 140],
      [100, 221],
      [NaN, 100],
      [100, Infinity],
      [0, 100],
      [-1, 100],
      [8.5, 100],
    ]) {
      expect(() => display.showLargeBitmap("bmp", w, h)).toThrow()
      expect(() => display.showRawBitmap("bmp", w, h)).toThrow()
      expect(() => display.showTestBox(w, h)).toThrow()
      expect(() => display.showBitmapSize(w, h)).toThrow()
    }
    expect(() => display.showBitmapTest("288-square-bmp")).toThrow()
    expect(frames).toEqual([])
  })

  test("uses live capabilities and preserves the older-host canvas fallback", () => {
    const {frames, session, display} = makeNimoDisplay()
    display.showText("NIMO")
    expect(frames.at(-1)?.[0]?.box).toEqual({x: 0, y: 0, w: 500, h: 220})
    session.capabilities = {display: {width: 576, height: 288}}
    display.showLargeBitmap("bmp", 288, 140)
    expect(frames.at(-1)?.[0]?.box).toEqual({x: 144, y: 74, w: 288, h: 140})
    session.capabilities = null
    display.showLargeBitmap("bmp", 288, 140)
    expect(frames.at(-1)?.[0]?.box).toEqual({x: 144, y: 74, w: 288, h: 140})
  })
})

describe("navigation display layout", () => {
  test("keeps arrival words intact in the positioned message box", () => {
    const {frames, display} = makeNimoDisplay()

    display.showNavMessage("You have arrived at Union Square, on your left", "15:55")

    expect(frames.at(-1)?.find((element) => element.id === "message")).toEqual({
      type: "text",
      id: "message",
      box: DisplayManager.HUD.message,
      text: "You have arrived at Union Square, on your left",
      style: {breakMode: "word"},
    })
  })

  test("uses word wrapping for older positioned hosts that omit canPosition", () => {
    const {frames, session, display} = makeNimoDisplay()
    session.capabilities = {display: {width: 500, height: 220}}

    display.showNavMessage("You have arrived at Union Square, on your left")

    expect(frames.at(-1)?.find((element) => element.id === "message")).toMatchObject({
      style: {breakMode: "word"},
    })
  })

  test("keeps every 24-hour clock value on one G2 text line", () => {
    const widestClockWidth = G2_DIGIT_WIDTH_PX * 4 + G2_COLON_WIDTH_PX
    const availableTextWidth = DisplayManager.HUD.clock.w - G2_NATIVE_HORIZONTAL_PADDING_PX

    expect(availableTextWidth).toBeGreaterThanOrEqual(widestClockWidth)
    expect(DisplayManager.HUD.clock.h).toBeGreaterThanOrEqual(G2_LINE_HEIGHT_PX)
  })

  test("reserves complete G2 lines for wrapped stats and maneuver instructions", () => {
    const {maneuver, map, stats} = DisplayManager.HUD

    expect(stats.w).toBeGreaterThanOrEqual(200)
    expect(stats.h).toBeGreaterThanOrEqual(G2_LINE_HEIGHT_PX * 2)
    expect(stats.y + stats.h).toBeLessThanOrEqual(map.y)

    // One distance line plus up to two wrapped instruction lines.
    expect(maneuver.h).toBeGreaterThanOrEqual(G2_LINE_HEIGHT_PX * 3)
    expect(maneuver.y + maneuver.h).toBeLessThanOrEqual(220)
    expect(maneuver.x + maneuver.w).toBeLessThanOrEqual(map.x)
  })

  test("keeps the maneuver instruction inside G1's five-line text budget", () => {
    const frames: RenderElement[][] = []
    const session = {
      capabilities: {display: {canPosition: false}},
      display: {
        render: (elements: RenderElement[]) => {
          frames.push(elements)
        },
      },
    } as unknown as MiniappSession
    const display = new DisplayManager(session)

    // Prime the positioning-only slots. The compact frame must drop them so
    // scene degradation cannot consume G1's line budget before the instruction.
    display.showBitmap("map-bitmap")
    display.showNavMessage("Starting…", "10:51")
    display.showCompactNavHud("→\n56 m\nTurn right onto Gough Street", "1.2 km · 14 min")

    expect(frames.at(-1)).toEqual([
      {
        type: "text",
        id: "message",
        box: DisplayManager.HUD.message,
        text: "→\n56 m\nTurn right onto Gough Street\n\n1.2 km · 14 min",
      },
    ])
    expect((frames.at(-1)?.[0] as {text: string}).text.split("\n")).toHaveLength(5)
  })
})
