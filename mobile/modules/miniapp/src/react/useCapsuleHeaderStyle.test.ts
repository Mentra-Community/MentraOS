import {describe, expect, it} from "bun:test"

import {getCapsuleHeaderPaddingRight} from "./capsuleHeaderLayout"

const capsuleMenu = {
  top: 12,
  right: 380,
  bottom: 52,
  left: 300,
  width: 80,
  height: 40,
}

describe("getCapsuleHeaderPaddingRight", () => {
  it("includes the host margin between the capsule and viewport edge", () => {
    expect(getCapsuleHeaderPaddingRight(capsuleMenu, 400, 0, 16)).toBe(116)
  })

  it("does not double-count the safe-area inset", () => {
    expect(getCapsuleHeaderPaddingRight(capsuleMenu, 400, 20, 16)).toBe(96)
  })

  it("always preserves the requested content gap", () => {
    expect(getCapsuleHeaderPaddingRight({...capsuleMenu, left: 395}, 400, 20, 16)).toBe(16)
  })
})
