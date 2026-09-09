/// <reference types="bun-types" />

import {describe, expect, mock, test} from "bun:test"

import {disableHotspotWithRetry} from "../HotspotShutdown"

describe("disableHotspotWithRetry", () => {
  test("waits for ASG restart settling and retries a lost disable command", async () => {
    const events: string[] = []
    const requestDisabled = mock(async () => {
      events.push("request")
      if (requestDisabled.mock.calls.length === 1) throw new Error("response timeout")
      return {state: "disabled" as const}
    })
    const wait = mock(async (delayMs: number) => {
      events.push(`wait:${delayMs}`)
    })

    const stopped = await disableHotspotWithRetry(requestDisabled, {
      attempts: 2,
      initialDelayMs: 750,
      retryDelayMs: 500,
      sleep: wait,
    })

    expect(stopped).toBe(true)
    expect(events).toEqual(["wait:750", "request", "wait:500", "request"])
  })

  test("stops after the bounded attempt count when the hotspot remains enabled", async () => {
    const requestDisabled = mock(async () => ({state: "enabled" as const}))

    const stopped = await disableHotspotWithRetry(requestDisabled, {
      attempts: 2,
      sleep: async () => {},
    })

    expect(stopped).toBe(false)
    expect(requestDisabled).toHaveBeenCalledTimes(2)
  })
})
