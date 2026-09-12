/// <reference types="bun-types" />

import {describe, expect, mock, test} from "bun:test"

import {awaitCleanupBarrier, CLEANUP_BARRIER_COPY} from "../SoftapCleanupBarrier"

/** A promise plus its resolver, so a test can hold a cleanup open for as long as it likes. */
function deferred(): {promise: Promise<void>; resolve: () => void} {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return {promise, resolve}
}

/** Lets the microtask queue drain so a resolved race can be observed without advancing time. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("awaitCleanupBarrier", () => {
  test("an already-finished cleanup costs nothing and says nothing", async () => {
    const narrate = mock((_: string) => {})
    const delay = mock(async (_: number) => {})

    const result = await awaitCleanupBarrier({
      settled: Promise.resolve(),
      settledDone: true,
      narrate,
      narrateAfterMs: 250,
      delay,
    })

    expect(result.narrated).toBe(false)
    expect(narrate).not.toHaveBeenCalled()
    // Not even a timer: the common restart must not pay for the rare stall.
    expect(delay).not.toHaveBeenCalled()
  })

  /**
   * The ordinary Stop/Start. The teardown is already unwinding and finishes within a tick, so the
   * wearer sees the checklist start rather than a status line about the call they just ended.
   */
  test("a cleanup that finishes promptly is waited for silently", async () => {
    const narrate = mock((_: string) => {})
    const cleanup = deferred()

    const barrier = awaitCleanupBarrier({
      settled: cleanup.promise,
      settledDone: false,
      narrate,
      narrateAfterMs: 250,
      delay: () => new Promise<void>(() => {}),
    })
    cleanup.resolve()

    expect(await barrier).toEqual({narrated: false})
    expect(narrate).not.toHaveBeenCalled()
  })

  /**
   * The case the wearer reported as a hang: a native operation — `setHotspotState(false)`, or a
   * `createCallAgent` still in flight — takes tens of seconds. The next Start is held, and after
   * the first quarter second it explains itself instead of showing five silent pending rows.
   */
  test("a slow cleanup is narrated once, and the wait continues past the narration", async () => {
    const narrate = mock((_: string) => {})
    const cleanup = deferred()
    let released = false

    const barrier = awaitCleanupBarrier({
      settled: cleanup.promise,
      settledDone: false,
      narrate,
      narrateAfterMs: 0,
      delay: async () => {},
    }).then((result) => {
      released = true
      return result
    })

    await tick()
    expect(narrate).toHaveBeenCalledTimes(1)
    expect(narrate).toHaveBeenCalledWith(CLEANUP_BARRIER_COPY)
    // The narration is not the release. This is the whole point of the class: the wearer being
    // told about a stalled cleanup must not be mistaken for the cleanup having finished.
    expect(released).toBe(false)

    cleanup.resolve()
    expect(await barrier).toEqual({narrated: true})
  })

  /**
   * The rule the review insisted on: no deadline may decide that a restart is safe. A cleanup
   * that never finishes holds the next call forever — visible, diagnosable, and never a race.
   */
  test("a cleanup that never finishes never opens the barrier", async () => {
    const narrate = mock((_: string) => {})
    let released = false

    void awaitCleanupBarrier({
      settled: new Promise<void>(() => {}),
      settledDone: false,
      narrate,
      narrateAfterMs: 0,
      delay: async () => {},
    }).then(() => {
      released = true
    })

    for (let i = 0; i < 5; i++) await tick()
    expect(narrate).toHaveBeenCalledTimes(1)
    expect(released).toBe(false)
  })

  /**
   * `settled` is built to resolve rather than reject — it reports that the previous attempt has
   * stopped touching the hardware, not whether it stopped happily. A rejection reaching here
   * would abort the barrier and let the next call start on top of a half-torn-down one, so the
   * caller's contract is checked here rather than assumed.
   */
  test("the barrier resolves on a settled promise regardless of how the attempt ended", async () => {
    const failedButFinished = Promise.reject(new Error("teardown failed")).catch(() => undefined)

    const result = await awaitCleanupBarrier({
      settled: failedButFinished,
      settledDone: false,
      narrate: () => {},
      narrateAfterMs: 250,
      delay: () => new Promise<void>(() => {}),
    })

    expect(result.narrated).toBe(false)
  })
})
