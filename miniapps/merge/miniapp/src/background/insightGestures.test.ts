import {describe, expect, test} from "bun:test"

import {insightGestureAction} from "./insightGestures"

describe("insightGestureAction", () => {
  test("maps downward/backward swipes to dismiss", () => {
    expect(insightGestureAction("swipe_down")).toBe("dismiss")
    expect(insightGestureAction("swipe_back")).toBe("dismiss")
  })

  test("maps taps to expand", () => {
    expect(insightGestureAction("single_tap")).toBe("expand")
    expect(insightGestureAction("tap")).toBe("expand")
  })

  test("ignores upward swipes and lifecycle events", () => {
    expect(insightGestureAction("swipe_up")).toBeNull()
    expect(insightGestureAction("swipe_forward")).toBeNull()
    expect(insightGestureAction("system_exit")).toBeNull()
  })
})
