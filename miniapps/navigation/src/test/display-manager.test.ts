import {describe, expect, test} from "bun:test"
import type {MiniappSession, RenderElement} from "@mentra/miniapp"

import {DisplayManager} from "../background/managers/DisplayManager"

// Rendered widths from the calibrated G2 font profile. All digits except 1
// occupy 12px; 1 occupies 8px; the colon occupies 4px.
const G2_DIGIT_WIDTH_PX = 12
const G2_COLON_WIDTH_PX = 4
const G2_NATIVE_HORIZONTAL_PADDING_PX = 8
const G2_LINE_HEIGHT_PX = 40

describe("navigation display layout", () => {
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
