/// <reference types="bun-types" />

import {afterEach, describe, expect, mock, spyOn, test} from "bun:test"

import {fleetEvents, type FleetEventListener} from "../fleetEvents"

const unsubscribers: Array<() => void> = []
function subscribe(listener: FleetEventListener): () => void {
  const off = fleetEvents.subscribe(listener)
  unsubscribers.push(off)
  return off
}

afterEach(() => {
  while (unsubscribers.length) unsubscribers.pop()?.()
})

describe("fleetEvents", () => {
  test("emitting with no reporter running does nothing and does not throw", () => {
    expect(() => fleetEvents.launch({packageName: "com.a", start: "user", outcome: "started"})).not.toThrow()
    expect(() => fleetEvents.photo({operationId: "op1", stage: "requested"})).not.toThrow()
  })

  test("delivers launches and photo stages to a listener, as given", () => {
    const launch = mock((_event: unknown) => {})
    const photo = mock((_event: unknown) => {})
    subscribe({launch, photo})
    fleetEvents.launch({
      packageName: "com.a",
      miniappName: "A",
      versionName: "1.0.0",
      start: "user",
      outcome: "started",
    })
    fleetEvents.photo({operationId: "op1", stage: "failed", failedStage: "requested"})
    expect(launch.mock.calls).toEqual([
      [{packageName: "com.a", miniappName: "A", versionName: "1.0.0", start: "user", outcome: "started"}],
    ])
    expect(photo.mock.calls).toEqual([[{operationId: "op1", stage: "failed", failedStage: "requested"}]])
  })

  test("a listener that only handles one kind of event is not called for the other", () => {
    const launch = mock((_event: unknown) => {})
    subscribe({launch})
    expect(() => fleetEvents.photo({operationId: "op1", stage: "captured"})).not.toThrow()
    expect(launch).not.toHaveBeenCalled()
  })

  test("a listener that throws never reaches the caller, and the others still hear the event", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const heard = mock((_event: unknown) => {})
    subscribe({
      launch: () => {
        throw new Error("boom")
      },
    })
    subscribe({launch: heard})
    try {
      expect(() => fleetEvents.launch({packageName: "com.a", start: "automatic", outcome: "failed"})).not.toThrow()
      expect(heard).toHaveBeenCalledTimes(1)
      // The warning names the failure, never the event's content.
      expect(JSON.stringify(warn.mock.calls)).not.toContain("com.a")
    } finally {
      warn.mockRestore()
    }
  })

  test("stops delivering once unsubscribed", () => {
    const launch = mock((_event: unknown) => {})
    const off = subscribe({launch})
    off()
    fleetEvents.launch({packageName: "com.a", start: "user", outcome: "started"})
    expect(launch).not.toHaveBeenCalled()
  })

  test("a listener that unsubscribes while being called does not disturb the others", () => {
    const second = mock((_event: unknown) => {})
    const off = subscribe({
      launch: () => {
        off()
      },
    })
    subscribe({launch: second})
    fleetEvents.launch({packageName: "com.a", start: "user", outcome: "started"})
    fleetEvents.launch({packageName: "com.a", start: "user", outcome: "started"})
    expect(second).toHaveBeenCalledTimes(2)
  })
})
