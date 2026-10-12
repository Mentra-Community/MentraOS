import {describe, expect, test} from "bun:test"

import {PhotoPauseController} from "../PhotoPauseController"

function controller(ceilingMs = 30_000) {
  const calls: string[] = []
  const events: string[] = []
  const pause = new PhotoPauseController({
    stopPublisher: async () => {
      calls.push("stop")
    },
    startPublisher: async () => {
      calls.push("start")
    },
    ceilingMs,
    onExpired: (pauseId) => events.push(pauseId),
  })
  return {calls, events, pause}
}

describe("PhotoPauseController", () => {
  test("pause stops the publisher and resume starts only that pause", async () => {
    const {calls, pause} = controller()

    const {pauseId} = await pause.pause()
    expect(calls).toEqual(["stop"])
    expect(pause.holding()).toBe(true)

    expect(await pause.resume(pauseId)).toBe("resumed")
    expect(calls).toEqual(["stop", "start"])
    expect(pause.holding()).toBe(false)
  })

  test("a stale resume does not start the publisher", async () => {
    const {calls, pause} = controller()
    await pause.pause()

    expect(await pause.resume("someone-elses-pause")).toBe("stale")
    expect(calls).toEqual(["stop"])
    expect(pause.holding()).toBe(true)
  })

  test("cancel releases ownership without restarting the publisher", async () => {
    const {calls, pause} = controller()
    const {pauseId} = await pause.pause()

    pause.cancel()

    expect(pause.holding()).toBe(false)
    expect(await pause.resume(pauseId)).toBe("stale")
    expect(calls).toEqual(["stop"])
  })

  test("the ceiling resumes the publisher and emits an event", async () => {
    const {calls, events, pause} = controller(15)
    const {pauseId} = await pause.pause()

    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(events).toEqual([pauseId])
    expect(calls).toEqual(["stop", "start"])
    expect(pause.holding()).toBe(false)
  })
})
