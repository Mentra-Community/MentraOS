import {describe, expect, test} from "bun:test"

import {classifyOffRouteAdvisory} from "../background/NavigationController"

describe("off-route advisory hysteresis", () => {
  test("enters at 20m and recovers only below 15m", () => {
    expect(classifyOffRouteAdvisory(19.9, false)).toBe(false)
    expect(classifyOffRouteAdvisory(20, false)).toBe(true)
    expect(classifyOffRouteAdvisory(19.5, true)).toBe(true)
    expect(classifyOffRouteAdvisory(15, true)).toBe(true)
    expect(classifyOffRouteAdvisory(14.9, true)).toBe(false)
  })

  test("does not chatter for the distances captured in the incident", () => {
    const incidentDistances = [21.2, 17.1, 20.1, 13.6, 20.1, 19.5, 20.2, 19.8, 20, 20, 20.1, 18.6, 23, 18.9, 22.3, 18.4]
    let advisoryActive = false
    let transitions = 0

    for (const distance of incidentDistances) {
      const next = classifyOffRouteAdvisory(distance, advisoryActive)
      if (next !== advisoryActive) transitions += 1
      advisoryActive = next
    }

    expect(transitions).toBe(3)
  })
})
