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
  fleetEvents.discardUndeliveredLaunches()
})

describe("fleetEvents", () => {
  test("emitting with no reporter running does not throw", () => {
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

  describe("launches heard with nothing listening", () => {
    test("are kept, with the time they happened, until a listener takes them", () => {
      const now = spyOn(Date, "now").mockReturnValue(1_000)
      try {
        fleetEvents.launch({packageName: "com.a", start: "automatic", outcome: "started"})
        now.mockReturnValue(2_000)
        fleetEvents.launch({packageName: "com.b", start: "automatic", outcome: "failed"})
      } finally {
        now.mockRestore()
      }
      expect(fleetEvents.takeUndeliveredLaunches()).toEqual([
        {event: {packageName: "com.a", start: "automatic", outcome: "started"}, observedAt: 1_000},
        {event: {packageName: "com.b", start: "automatic", outcome: "failed"}, observedAt: 2_000},
      ])
      expect(fleetEvents.takeUndeliveredLaunches()).toEqual([])
    })

    test("are not kept when a listener hears them, and photo stages never are", () => {
      subscribe({launch: () => {}})
      fleetEvents.launch({packageName: "com.a", start: "user", outcome: "started"})
      unsubscribers.pop()?.()
      fleetEvents.photo({operationId: "op1", stage: "requested"})
      expect(fleetEvents.takeUndeliveredLaunches()).toEqual([])
    })

    test("are at most the latest 32", () => {
      for (let index = 0; index < 40; index += 1) {
        fleetEvents.launch({packageName: `com.p${index}`, start: "automatic", outcome: "started"})
      }
      const kept = fleetEvents.takeUndeliveredLaunches().map((launch) => launch.event.packageName)
      expect(kept).toHaveLength(32)
      expect(kept[0]).toBe("com.p8")
      expect(kept.at(-1)).toBe("com.p39")
    })

    test("can be discarded", () => {
      fleetEvents.launch({packageName: "com.a", start: "automatic", outcome: "started"})
      fleetEvents.discardUndeliveredLaunches()
      expect(fleetEvents.takeUndeliveredLaunches()).toEqual([])
    })
  })

  describe("a start that reports its own launch", () => {
    test("keeps a launch the same miniapp makes elsewhere meanwhile from being reported, until it is done", () => {
      const launch = mock((_event: unknown) => {})
      subscribe({launch})
      const release = fleetEvents.claimLaunch("com.a")
      fleetEvents.launchUnlessClaimed({packageName: "com.a", start: "automatic", outcome: "started"})
      fleetEvents.launchUnlessClaimed({packageName: "com.b", start: "automatic", outcome: "started"})
      // Its own report is not held back.
      fleetEvents.launch({packageName: "com.a", start: "user", outcome: "started"})
      release()
      fleetEvents.launchUnlessClaimed({packageName: "com.a", start: "automatic", outcome: "started"})
      expect(
        launch.mock.calls.map(([event]) => [
          (event as {packageName: string}).packageName,
          (event as {start: string}).start,
        ]),
      ).toEqual([
        ["com.b", "automatic"],
        ["com.a", "user"],
        ["com.a", "automatic"],
      ])
    })

    test("keeps the reason a held-back launch failed for, for the start's own report", () => {
      const launch = mock((_event: unknown) => {})
      subscribe({launch})
      const release = fleetEvents.claimLaunch("com.a")
      fleetEvents.launchUnlessClaimed({packageName: "com.a", start: "user", outcome: "failed", failureReason: "spawn_failed"})
      fleetEvents.launchUnlessClaimed({packageName: "com.a", start: "user", outcome: "failed", failureReason: "unknown"})
      expect(release()).toBe("spawn_failed")
      expect(launch).not.toHaveBeenCalled()
      expect(fleetEvents.claimLaunch("com.a")()).toBeUndefined()
    })

    test("two starts of one miniapp hold it until both are done, and releasing twice changes nothing", () => {
      const launch = mock((_event: unknown) => {})
      subscribe({launch})
      const first = fleetEvents.claimLaunch("com.a")
      const second = fleetEvents.claimLaunch("com.a")
      first()
      first()
      fleetEvents.launchUnlessClaimed({packageName: "com.a", start: "automatic", outcome: "started"})
      expect(launch).not.toHaveBeenCalled()
      second()
      fleetEvents.launchUnlessClaimed({packageName: "com.a", start: "automatic", outcome: "started"})
      expect(launch).toHaveBeenCalledTimes(1)
    })
  })
})
