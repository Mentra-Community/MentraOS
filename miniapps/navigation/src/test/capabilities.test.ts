import {describe, expect, test} from "bun:test"

import {readGlassesCapabilities} from "../background/lib/capabilities"

describe("navigation glasses capabilities", () => {
  test("keeps G2 on the positioned HUD when an older host omits canPosition", () => {
    expect(
      readGlassesCapabilities({
        modelName: "Even Realities G2",
        hasDisplay: true,
        display: {canDisplayBitmap: true},
      }).canPosition,
    ).toBe(true)
  })

  test("treats the G2 model profile as authoritative over a stale false flag", () => {
    expect(
      readGlassesCapabilities({
        modelName: "Even Realities G2",
        hasDisplay: true,
        display: {canPosition: false},
      }).canPosition,
    ).toBe(true)
  })

  test("keeps G1 on the compact text HUD", () => {
    expect(
      readGlassesCapabilities({
        modelName: "Even Realities G1",
        hasDisplay: true,
        display: {canPosition: false},
      }).canPosition,
    ).toBe(false)
  })

  test("honors positioned-scene support for other models", () => {
    expect(
      readGlassesCapabilities({
        modelName: "Mentra Display",
        hasDisplay: true,
        display: {canPosition: true},
      }).canPosition,
    ).toBe(true)
  })
})
