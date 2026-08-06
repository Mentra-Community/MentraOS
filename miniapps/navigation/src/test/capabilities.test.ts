import {describe, expect, test} from "bun:test"

import {readGlassesCapabilities} from "../background/lib/capabilities"

describe("navigation glasses capabilities", () => {
  test("preserves the positioned HUD when the host omits canPosition", () => {
    expect(
      readGlassesCapabilities({
        modelName: "Even Realities G2",
        hasDisplay: true,
        display: {canDisplayBitmap: true},
      }).canPosition,
    ).toBe(true)
  })

  test("does not infer positioning support from a device model", () => {
    expect(
      readGlassesCapabilities({
        modelName: "Even Realities G2",
        hasDisplay: true,
        display: {canPosition: false},
      }).canPosition,
    ).toBe(false)
  })

  test("uses the compact text HUD only when positioning is explicitly unsupported", () => {
    expect(
      readGlassesCapabilities({
        modelName: "Even Realities G1",
        hasDisplay: true,
        display: {canPosition: false},
      }).canPosition,
    ).toBe(false)
  })

  test("honors explicit positioned-scene support", () => {
    expect(
      readGlassesCapabilities({
        modelName: "Mentra Display",
        hasDisplay: true,
        display: {canPosition: true},
      }).canPosition,
    ).toBe(true)
  })

  test("does not claim positioning support without a display", () => {
    expect(readGlassesCapabilities({modelName: "Mentra Live", hasDisplay: false}).canPosition).toBe(false)
  })
})
