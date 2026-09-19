import {expect, test} from "bun:test"
import {browserTimeline} from "./browser-evidence"

const event = {id: "join", instruction: "Join the call.", phase: "connected", elapsedMs: 10000}

test("chapter time subtracts the measured recording start offset", () => {
  const result = browserTimeline({beforeMs: 1000, afterMs: 1020}, 0.5, [event], 15)
  expect(result.chapters[0].videoSeconds).toBeCloseTo(9.49)
  expect(result.uncertaintyMs).toBe(50)
})

test("late calibration and truncated or out-of-order recordings cannot qualify", () => {
  expect(() => browserTimeline({beforeMs: 1000, afterMs: 1400}, 0.5, [event], 15)).toThrow("delayed")
  expect(() => browserTimeline({beforeMs: 1000, afterMs: 1020}, 0.5, [event], 5)).toThrow("outside")
  expect(() => browserTimeline({beforeMs: 1000, afterMs: 1020}, 0.5, [event, {...event, elapsedMs: 9000}], 15)).toThrow(
    "outside",
  )
})
