import {describe, expect, test} from "bun:test"

import {claimsDoubleTap} from "../DoubleTapClaim"

// The runtime feeds this the keys of its stream→subscribers map, i.e. every
// stream at least one connected miniapp is subscribed to right now.
describe("claimsDoubleTap", () => {
  test("no touch subscriptions leave double-tap to the glasses", () => {
    expect(claimsDoubleTap([])).toBe(false)
    expect(claimsDoubleTap(["button_press", "transcription:en-US", "touch_event:single_tap"])).toBe(false)
  })

  test("a bare touch subscription claims every gesture, double-tap included", () => {
    expect(claimsDoubleTap(["touch_event"])).toBe(true)
  })

  test("a double_tap-only subscription claims it", () => {
    expect(claimsDoubleTap(["touch_event:double_tap"])).toBe(true)
  })

  test("the claim follows the live subscription set: released when the last claimant unsubscribes", () => {
    const streams = new Set(["touch_event:double_tap", "touch_event"])
    expect(claimsDoubleTap(streams)).toBe(true)
    streams.delete("touch_event")
    expect(claimsDoubleTap(streams)).toBe(true)
    streams.delete("touch_event:double_tap")
    expect(claimsDoubleTap(streams)).toBe(false)
  })
})
