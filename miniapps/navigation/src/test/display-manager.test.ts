import {describe, expect, test} from "bun:test"

import {DisplayManager} from "../background/managers/DisplayManager"

// Rendered widths from the calibrated G2 font profile. All digits except 1
// occupy 12px; 1 occupies 8px; the colon occupies 4px.
const G2_DIGIT_WIDTH_PX = 12
const G2_COLON_WIDTH_PX = 4
const G2_NATIVE_HORIZONTAL_PADDING_PX = 8

describe("navigation display layout", () => {
  test("keeps every 24-hour clock value on one G2 text line", () => {
    const widestClockWidth = G2_DIGIT_WIDTH_PX * 4 + G2_COLON_WIDTH_PX
    const availableTextWidth = DisplayManager.HUD.clock.w - G2_NATIVE_HORIZONTAL_PADDING_PX

    expect(availableTextWidth).toBeGreaterThanOrEqual(widestClockWidth)
  })
})
