import {describe, expect, test} from "bun:test"

import {insightGestureAction} from "./insightGestures"

describe("insightGestureAction", () => {
  test("maps downward/backward swipes to dismiss", () => {
    expect(insightGestureAction("swipe_down")).toBe("dismiss")
    expect(insightGestureAction("swipe_back")).toBe("dismiss")
  })

  test("maps upward/forward swipes to expand", () => {
    expect(insightGestureAction("swipe_up")).toBe("expand")
    expect(insightGestureAction("swipe_forward")).toBe("expand")
  })

  test("ignores taps and lifecycle events", () => {
    expect(insightGestureAction("single_tap")).toBeNull()
    expect(insightGestureAction("system_exit")).toBeNull()
  })
})
