/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"
import {limitEvent, TelemetryRate} from "../telemetryLimits"

describe("limitEvent", () => {
  test("drops an event whose name breaks the rule", () => {
    for (const name of ["", "Call", "1call", "_call", "call-ended", "a".repeat(65), 42, null]) expect(limitEvent(name, {})).toBeNull()
    expect(limitEvent("a".repeat(64), {})?.event).toBe("a".repeat(64))
  })

  test("drops bad properties, cuts long strings, keeps the first 25, and counts both", () => {
    const properties: Record<string, unknown> = {Bad: 1, ok: true, nan: Number.NaN, nested: {a: 1}, list: [1], none: null, long: "é".repeat(70)}
    for (let i = 0; i < 30; i += 1) properties[`p${i}`] = i
    const limited = limitEvent("call_ended", properties)!
    expect(Object.keys(limited.properties)).toHaveLength(25)
    expect(limited.properties.ok).toBe(true)
    expect(limited.properties.long).toBe("é".repeat(64))
    expect(limited.properties.p22).toBe(22)
    expect(limited.properties.p23).toBeUndefined()
    expect(limited.cutValues).toBe(1)
    // Bad, nan, nested, list, none, and p23..p29.
    expect(limited.droppedProperties).toBe(5 + 7)
  })

  test("never splits a surrogate pair when it cuts", () => {
    const cut = limitEvent("e", {s: "a".repeat(63) + "😀"})!.properties.s as string
    expect(cut).toBe("a".repeat(63))
  })

  test("ignores properties that are not an object", () => {
    expect(limitEvent("e", "text")).toEqual({event: "e", properties: {}, droppedProperties: 0, cutValues: 0})
  })
})

describe("TelemetryRate", () => {
  const T = Date.UTC(2026, 9, 29, 23, 59, 0)

  test("60 events in any minute, per miniapp", () => {
    const rate = new TelemetryRate()
    for (let i = 0; i < 60; i += 1) expect(rate.admit("a", T + i)).toBe(true)
    expect(rate.admit("a", T + 100)).toBe(false)
    expect(rate.admit("b", T + 100)).toBe(true)
    expect(rate.admit("a", T + 60_001)).toBe(true)
  })

  test("2,000 a UTC day, starting again the next day", () => {
    const rate = new TelemetryRate()
    let at = Date.UTC(2026, 9, 29, 0, 0, 0)
    for (let i = 0; i < 2_000; i += 1) {
      expect(rate.admit("a", at)).toBe(true)
      at += 1_100
    }
    expect(rate.admit("a", at + 60_000)).toBe(false)
    expect(rate.admit("a", Date.UTC(2026, 9, 30, 0, 0, 1))).toBe(true)
  })
})
