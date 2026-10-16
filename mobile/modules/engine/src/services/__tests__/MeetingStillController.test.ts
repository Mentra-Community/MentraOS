import {describe, expect, test} from "bun:test"

import {MeetingStillController, MeetingStillError, type MeetingStillDeps} from "../MeetingStillController"

type Deferred<T> = {promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {promise, resolve, reject}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness(overrides: Partial<MeetingStillDeps> = {}) {
  const calls: string[] = []
  const upload = deferred<{bytes: number; shownAt: number}>()
  const glasses = deferred<unknown>()
  const deps: MeetingStillDeps = {
    holdOutgoing: async (kind) => {
      calls.push(`hold:${kind}`)
    },
    prepareStill: async (requestId) => {
      calls.push(`prepare:${requestId}`)
      return {uploadUrl: `http://192.168.43.117:40203/photo/${requestId}`}
    },
    awaitStill: (requestId, timeoutMs) => {
      calls.push(`await:${requestId}:${timeoutMs}`)
      return upload.promise
    },
    cancelStill: async (requestId) => {
      calls.push(`cancel:${requestId}`)
    },
    requestGlassesPhoto: ({requestId, uploadUrl}) => {
      calls.push(`glasses:${requestId}:${uploadUrl}`)
      return glasses.promise
    },
    mintRequestId: () => "st1",
    uploadTimeoutMs: 5_000,
    ...overrides,
  }
  return {calls, upload, glasses, still: new MeetingStillController(deps)}
}

describe("MeetingStillController", () => {
  test("card, register, shoot, still, hold, live — and never touches the publisher", async () => {
    const {calls, upload, glasses, still} = harness()
    const run = still.capture({durationMs: 20})
    await tick()

    // The waiter exists before the glasses are asked, so the upload cannot beat it.
    expect(calls).toEqual([
      "hold:card",
      "prepare:st1",
      "await:st1:5000",
      "glasses:st1:http://192.168.43.117:40203/photo/st1",
    ])
    upload.resolve({bytes: 1_186_932, shownAt: 7})
    glasses.resolve({state: "success"})
    const result = await run

    expect(result).toMatchObject({ok: true, requestId: "st1", bytes: 1_186_932, shownAt: 7})
    expect(result.timings.heldMs).toBeGreaterThanOrEqual(15)
    expect(calls.slice(4)).toEqual(["cancel:st1", "hold:live"])
    expect(still.busy()).toBe(false)
  })

  test("progress follows the tile: card, the glasses' upload, then the still", async () => {
    let status: ((status: string) => void) | undefined
    const {upload, glasses, still} = harness({
      onGlassesPhotoStatus: (_requestId, listener) => {
        status = listener
        return () => {
          status = undefined
        }
      },
    })
    const phases: string[] = []
    const run = still.capture({durationMs: 0, onProgress: (phase) => phases.push(phase)})
    await tick()
    expect(phases).toEqual(["card"])

    status?.("capturing")
    status?.("uploading")
    expect(phases).toEqual(["card", "uploading"])
    upload.resolve({bytes: 1, shownAt: 1})
    glasses.resolve({})
    await run

    expect(phases).toEqual(["card", "uploading", "shown"])
    expect(status).toBeUndefined()
  })

  test("a glasses rejection ends the wait at once and returns the tile to live", async () => {
    const {calls, glasses, still} = harness()
    const run = still.capture({durationMs: 1_000})
    await tick()
    glasses.reject({code: "CAMERA_BUSY", message: "Camera busy with streaming"})

    await expect(run).rejects.toMatchObject({reason: "glasses_rejected"})
    expect(calls.slice(-2)).toEqual(["cancel:st1", "hold:live"])
  })

  test("an upload that never arrives is reported as a timeout", async () => {
    const {calls, upload, still} = harness()
    const run = still.capture({durationMs: 1_000})
    await tick()
    upload.reject({code: "STILL_TIMEOUT", message: "late"})

    await expect(run).rejects.toMatchObject({reason: "upload_timeout"})
    expect(calls.at(-1)).toBe("hold:live")
  })

  test("cancel during the upload leaves the tile to the call teardown", async () => {
    const {calls, still} = harness()
    const run = still.capture({durationMs: 1_000})
    await tick()

    still.cancel()

    await expect(run).rejects.toMatchObject({reason: "cancelled"})
    expect(calls).toContain("cancel:st1")
    expect(calls).not.toContain("hold:live")
    expect(still.busy()).toBe(false)
  })

  test("cancel during the hold stops the wait without a live frame from us", async () => {
    const {calls, upload, still} = harness()
    const run = still.capture({durationMs: 10_000})
    await tick()
    upload.resolve({bytes: 10, shownAt: 1})
    await tick()

    still.cancel()

    await expect(run).rejects.toBeInstanceOf(MeetingStillError)
    expect(calls).not.toContain("hold:live")
  })

  test("a second capture while one is running is refused as busy", async () => {
    const {upload, glasses, still} = harness()
    const first = still.capture({durationMs: 0})
    await expect(still.capture({durationMs: 0})).rejects.toMatchObject({reason: "busy"})
    upload.resolve({bytes: 1, shownAt: 1})
    glasses.resolve({})
    await first
  })

  test("a native without the still endpoint is unsupported and gives the card back", async () => {
    const {calls, still} = harness({
      prepareStill: async () => {
        throw new Error("This call has no Direct link receiver")
      },
    })

    await expect(still.capture({durationMs: 0})).rejects.toMatchObject({reason: "unsupported"})
    expect(calls).toEqual(["hold:card", "cancel:st1", "hold:live"])
  })

  test("a card that never reaches Teams fails before the glasses are asked", async () => {
    const {calls, still} = harness({
      holdOutgoing: async (kind) => {
        calls.push(`hold:${kind}`)
        if (kind === "card") throw new Error("HOLD_FAILED")
      },
    })

    await expect(still.capture({durationMs: 0})).rejects.toMatchObject({reason: "hold_failed"})
    expect(calls.some((call) => call.startsWith("glasses:"))).toBe(false)
    expect(calls).not.toContain("hold:live")
  })
})
