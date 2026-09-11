/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {
  createSoftapCallDeps,
  SoftapCallError,
  SoftapCallTransport,
  SoftapEndNotSupportedError,
  type SoftapCallDeps,
  type SoftapProgress,
  type SoftapStep,
} from "../SoftapCallTransport"

/**
 * The orchestrator's entire job is ordering and unwinding, so that is what these assert.
 *
 * A recording fake rather than mocks: the interesting property is the *sequence* of calls across
 * five collaborators, and a list of names compared to an expected list states that far more
 * directly than five separate call-order assertions.
 */
function recordingDeps(overrides: Partial<SoftapCallDeps> | ((calls: string[]) => Partial<SoftapCallDeps>) = {}) {
  const calls: string[] = []
  const resolved = typeof overrides === "function" ? overrides(calls) : overrides
  const deps: SoftapCallDeps = {
    startHotspot: async () => {
      calls.push("startHotspot")
      return {ssid: "MentraLive-1234", passphrase: "hunter2!"}
    },
    waitUntilHotspotJoinable: async () => {
      calls.push("waitUntilHotspotJoinable")
    },
    stopHotspot: async () => {
      calls.push("stopHotspot")
    },
    joinScopedNetwork: async (ssid, passphrase) => {
      calls.push(`joinScopedNetwork:${ssid}:${passphrase}`)
      return "192.168.43.20"
    },
    leaveScopedNetwork: async () => {
      calls.push("leaveScopedNetwork")
    },
    joinMeeting: async (args) => {
      calls.push(`joinMeeting:${args.bindAddress}`)
      return {ingestUrl: "http://192.168.43.20:8790/whip"}
    },
    leaveMeeting: async () => {
      calls.push("leaveMeeting")
    },
    startPublishing: async (args) => {
      calls.push(`startPublishing:${args.ingestUrl}`)
    },
    stopPublishing: async () => {
      calls.push("stopPublishing")
    },
    awaitFirstFrame: async () => {
      calls.push("awaitFirstFrame")
    },
    ...resolved,
  }
  return {calls, deps, transport: new SoftapCallTransport(deps)}
}

const START_ORDER = [
  "startHotspot",
  "waitUntilHotspotJoinable",
  "joinScopedNetwork:MentraLive-1234:hunter2!",
  "joinMeeting:192.168.43.20",
  "startPublishing:http://192.168.43.20:8790/whip",
  "awaitFirstFrame",
]

const TEARDOWN_ORDER = ["stopPublishing", "leaveMeeting", "leaveScopedNetwork", "stopHotspot"]

describe("SoftapCallTransport ordering", () => {
  test("runs the sequence in order and reaches live", async () => {
    const {calls, transport} = recordingDeps()

    await transport.start()

    expect(calls).toEqual(START_ORDER)
    expect(transport.currentPhase()).toBe("live")
    expect(transport.currentIngestUrl()).toBe("http://192.168.43.20:8790/whip")
  })

  /**
   * The reviewer's ordering fix, and the reason this class exists. `LIVE` means a frame reached
   * ACS, so publishing before the ACS raw outputs exist drops the first frames into whatever
   * happens to be null at the time.
   */
  test("the glasses are told to publish only after the meeting has joined", async () => {
    const {calls, transport} = recordingDeps()

    await transport.start()

    expect(calls.indexOf("joinMeeting:192.168.43.20")).toBeLessThan(
      calls.findIndex((call) => call.startsWith("startPublishing")),
    )
  })

  test("the phone joins the hotspot before the meeting, so the listener has an address to bind", async () => {
    const {calls, transport} = recordingDeps()

    await transport.start()

    expect(calls.findIndex((call) => call.startsWith("joinScopedNetwork"))).toBeLessThan(
      calls.findIndex((call) => call.startsWith("joinMeeting")),
    )
  })

  test("the hotspot credentials reach both the scoped join and the meeting", async () => {
    const seen: unknown[] = []
    const {transport} = recordingDeps({
      joinMeeting: async (args) => {
        seen.push(args)
        return {ingestUrl: "http://192.168.43.20:8790/whip"}
      },
    })

    await transport.start()

    expect(seen[0]).toEqual({
      ssid: "MentraLive-1234",
      passphrase: "hunter2!",
      bindAddress: "192.168.43.20",
    })
  })

  test("the minted trace id is passed to the glasses so both logs correlate", async () => {
    const traceIds: string[] = []
    const {transport} = recordingDeps({
      startPublishing: async (args) => {
        traceIds.push(args.traceId)
      },
    })

    await transport.start({traceId: "abc123"})

    expect(traceIds).toEqual(["abc123"])
  })

  test("a scoped join with no address still proceeds and lets the native side resolve it", async () => {
    // The scoped join may report no address on some hosts; native falls back to asking the joined
    // network, so this must not be treated as a failure.
    const {calls, transport} = recordingDeps({joinScopedNetwork: async () => undefined})

    await transport.start()

    expect(calls).toContain("joinMeeting:undefined")
    expect(transport.currentPhase()).toBe("live")
  })
})

describe("SoftapCallTransport teardown", () => {
  test("stop undoes every step in exact reverse order", async () => {
    const {calls, transport} = recordingDeps()
    await transport.start()
    calls.length = 0

    await transport.stop()

    expect(calls).toEqual(TEARDOWN_ORDER)
    expect(transport.currentPhase()).toBe("idle")
    expect(transport.activeSteps()).toEqual([])
  })

  test("stop on an idle transport does nothing", async () => {
    const {calls, transport} = recordingDeps()

    await transport.stop()

    expect(calls).toEqual([])
    expect(transport.currentPhase()).toBe("idle")
  })

  test("stop is idempotent", async () => {
    const {calls, transport} = recordingDeps()
    await transport.start()
    calls.length = 0

    await transport.stop()
    await transport.stop()

    expect(calls).toEqual(TEARDOWN_ORDER)
  })

  /** Two leave paths can race — a user tap and a meeting-ended callback. They must not both unwind. */
  test("concurrent stops share one teardown", async () => {
    const {calls, transport} = recordingDeps()
    await transport.start()
    calls.length = 0

    await Promise.all([transport.stop(), transport.stop(), transport.stop()])

    expect(calls).toEqual(TEARDOWN_ORDER)
  })

  /**
   * A failure to stop the publisher must not leave the hotspot on. The hotspot is the most costly
   * thing to leak: it drains the glasses battery and blocks the next call's join.
   */
  test("a failing teardown step does not prevent the rest from running", async () => {
    const {calls, transport} = recordingDeps({
      stopPublishing: async () => {
        calls.push("stopPublishing")
        throw new Error("BLE timeout")
      },
    })
    await transport.start()
    calls.length = 0

    await transport.stop()

    expect(calls).toEqual(TEARDOWN_ORDER)
    expect(transport.currentPhase()).toBe("idle")
  })

  test("all teardown steps failing still leaves the transport idle and reusable", async () => {
    const failing = async () => {
      throw new Error("nope")
    }
    const {transport} = recordingDeps({
      stopPublishing: failing,
      leaveMeeting: failing,
      leaveScopedNetwork: failing,
      stopHotspot: failing,
    })
    await transport.start()

    await transport.stop()

    expect(transport.currentPhase()).toBe("idle")
    expect(transport.activeSteps()).toEqual([])
  })

  /**
   * Swallowing an undo failure is right for the teardown — the remaining steps still have to run —
   * and wrong for everything after it. A hotspot that would not switch off is precisely the state
   * the next call cannot be built on, and starting anyway is what produced "Cannot start glasses
   * hotspot" followed by a scoped join that never found the SSID. So the failures are kept, by
   * name, for the caller that decides whether there is going to be a next call.
   */
  test("a swallowed teardown failure is still reported by name afterwards", async () => {
    const {calls, transport} = recordingDeps((recorded) => ({
      stopHotspot: async () => {
        recorded.push("stopHotspot")
        throw new Error("hotspot stuck on")
      },
    }))
    await transport.start()
    calls.length = 0

    await transport.stop()

    expect(calls).toEqual(TEARDOWN_ORDER)
    expect(transport.lastTeardownFailures()).toEqual(["hotspot"])
  })

  test("every failed undo is named, in teardown order", async () => {
    const failing = async () => {
      throw new Error("nope")
    }
    const {transport} = recordingDeps({
      stopPublishing: failing,
      leaveScopedNetwork: failing,
    })
    await transport.start()

    await transport.stop()

    expect(transport.lastTeardownFailures()).toEqual(["publish", "scopedJoin"])
  })

  /** A clean teardown must not leave a stale accusation behind for the next call to trip over. */
  test("a clean teardown reports no failures, and a later one does not inherit an earlier one", async () => {
    let brokenHotspot = true
    const {transport} = recordingDeps({
      stopHotspot: async () => {
        if (brokenHotspot) throw new Error("hotspot stuck on")
      },
    })
    await transport.start()
    await transport.stop()
    expect(transport.lastTeardownFailures()).toEqual(["hotspot"])

    brokenHotspot = false
    await transport.start()
    await transport.stop()

    expect(transport.lastTeardownFailures()).toEqual([])
  })
})

describe("SoftapCallTransport end for everyone", () => {
  const END_ORDER = ["stopPublishing", "endMeeting", "leaveScopedNetwork", "stopHotspot"]

  function endableDeps(overrides: Partial<SoftapCallDeps> = {}) {
    const harness = recordingDeps((calls) => ({
      endMeeting: async () => {
        calls.push("endMeeting")
      },
      ...overrides,
    }))
    return harness
  }

  /** End is one different verb at one step, not a second teardown path. */
  test("end swaps the meeting verb and leaves the rest of the teardown identical", async () => {
    const {calls, transport} = endableDeps()
    await transport.start()
    calls.length = 0

    await transport.stop({mode: "end"})

    expect(calls).toEqual(END_ORDER)
    expect(transport.currentPhase()).toBe("idle")
  })

  test("leave is still the default", async () => {
    const {calls, transport} = endableDeps()
    await transport.start()
    calls.length = 0

    await transport.stop()

    expect(calls).toEqual(TEARDOWN_ORDER)
  })

  /**
   * The whole reason End cannot be a single call: the hotspot has to come down even when Teams
   * refuses to end the meeting, and the caller still has to learn that it refused.
   */
  test("a refused end still releases the hotspot, then rethrows", async () => {
    const {calls, transport} = endableDeps({
      endMeeting: async () => {
        throw new Error("hang_up_for_everyone_not_allowed:role_restricted")
      },
    })
    await transport.start()
    calls.length = 0

    await expect(transport.stop({mode: "end"})).rejects.toThrow("role_restricted")

    expect(calls).toEqual(["stopPublishing", "leaveMeeting", "leaveScopedNetwork", "stopHotspot"])
    expect(transport.currentPhase()).toBe("idle")
  })

  test("a host with no end support leaves, releases everything, and says so", async () => {
    const {calls, transport} = recordingDeps()
    await transport.start()
    calls.length = 0

    await expect(transport.stop({mode: "end"})).rejects.toThrow(SoftapEndNotSupportedError)

    expect(calls).toEqual(TEARDOWN_ORDER)
  })

  /** A rethrown end failure must not survive into the next call's teardown. */
  test("the end failure is reported once", async () => {
    const {transport} = endableDeps({
      endMeeting: async () => {
        throw new Error("graph exploded")
      },
    })
    await transport.start()

    await expect(transport.stop({mode: "end"})).rejects.toThrow("graph exploded")
    await expect(transport.stop({mode: "end"})).resolves.toBeUndefined()
  })
})

describe("SoftapCallTransport terminal intent", () => {
  test("a live call is not terminating", async () => {
    const {transport} = recordingDeps()
    await transport.start()

    expect(transport.isTerminating()).toBe(false)
  })

  /**
   * The false-positive guard. Android reports the scoped network loss we asked for, so anything
   * watching the hotspot has to be able to see the intent before the first release happens — not
   * after teardown finishes, by which point the error has already been raised.
   */
  test("intent is raised before the first teardown step runs", async () => {
    let terminatingAtFirstUndo: boolean | null = null
    const harness = recordingDeps((calls) => ({
      stopPublishing: async () => {
        calls.push("stopPublishing")
        terminatingAtFirstUndo = harness.transport.isTerminating()
      },
    }))
    await harness.transport.start()

    await harness.transport.stop()

    expect(terminatingAtFirstUndo).toBe(true)
  })

  test("a fresh start clears the intent", async () => {
    const {transport} = recordingDeps()
    await transport.start()
    await transport.stop()
    expect(transport.isTerminating()).toBe(true)

    await transport.start()

    expect(transport.isTerminating()).toBe(false)
  })
})

describe("SoftapCallTransport failure mapping", () => {
  const cases: Array<{step: SoftapStep; code: string; override: keyof SoftapCallDeps; undone: string[]}> = [
    {step: "hotspot", code: "HOTSPOT_FAILED", override: "startHotspot", undone: []},
    {
      step: "scopedJoin",
      code: "SCOPED_JOIN_FAILED",
      override: "joinScopedNetwork",
      undone: ["stopHotspot"],
    },
    {
      step: "acsJoin",
      code: "ACS_JOIN_FAILED",
      override: "joinMeeting",
      undone: ["leaveScopedNetwork", "stopHotspot"],
    },
    {
      step: "publish",
      code: "PUBLISH_FAILED",
      override: "startPublishing",
      undone: ["leaveMeeting", "leaveScopedNetwork", "stopHotspot"],
    },
    {
      step: "live",
      code: "NO_FIRST_FRAME",
      override: "awaitFirstFrame",
      undone: ["stopPublishing", "leaveMeeting", "leaveScopedNetwork", "stopHotspot"],
    },
  ]

  for (const {step, code, override, undone} of cases) {
    test(`a failure at ${step} maps to ${code} and unwinds only what was built`, async () => {
      const {calls, transport} = recordingDeps({
        [override]: async () => {
          throw new Error(`${step} exploded`)
        },
      } as Partial<SoftapCallDeps>)

      let error: unknown
      try {
        await transport.start()
      } catch (thrown) {
        error = thrown
      }

      expect(error).toBeInstanceOf(SoftapCallError)
      const softapError = error as SoftapCallError
      expect(softapError.step).toBe(step)
      expect(softapError.code).toBe(code)
      expect(softapError.message).toBe(`${step} exploded`)
      // Only the steps that actually completed are undone; nothing else is touched.
      expect(calls.filter((call) => undone.includes(call))).toEqual(undone)
      expect(transport.currentPhase()).toBe("failed")
      expect(transport.activeSteps()).toEqual([])
    })
  }

  test("the original error is preserved as the cause", async () => {
    const cause = new Error("EHOSTUNREACH")
    const {transport} = recordingDeps({
      joinScopedNetwork: async () => {
        throw cause
      },
    })

    await expect(transport.start()).rejects.toMatchObject({cause})
  })

  /** A hotspot with no SSID is a successful call that returned nothing usable. */
  test("a hotspot with no SSID fails at the hotspot step rather than later", async () => {
    const {transport} = recordingDeps({
      startHotspot: async () => ({ssid: "", passphrase: "hunter2!"}),
    })

    await expect(transport.start()).rejects.toMatchObject({step: "hotspot"})
  })

  /**
   * Without a bound listener there is nowhere to publish, and telling the glasses to publish anyway
   * fails several seconds later on the device that is hardest to debug.
   */
  test("a meeting that reports no ingest URL fails before the glasses are told to publish", async () => {
    const {calls, transport} = recordingDeps({
      joinMeeting: async () => ({ingestUrl: ""}),
    })

    await expect(transport.start()).rejects.toMatchObject({step: "acsJoin"})
    expect(calls.some((call) => call.startsWith("startPublishing"))).toBe(false)
  })

  test("a second start while a call is live is rejected without disturbing it", async () => {
    const {calls, transport} = recordingDeps()
    await transport.start()
    calls.length = 0

    await expect(transport.start()).rejects.toMatchObject({code: "ALREADY_ACTIVE"})
    expect(calls).toEqual([])
    expect(transport.currentPhase()).toBe("live")
  })

  test("a failed start can be retried from scratch", async () => {
    let attempt = 0
    const {calls, transport} = recordingDeps((recorded) => ({
      joinScopedNetwork: async (ssid, passphrase) => {
        attempt += 1
        if (attempt === 1) throw new Error("first join failed")
        recorded.push(`joinScopedNetwork:${ssid}:${passphrase}`)
        return "192.168.43.20"
      },
    }))
    await expect(transport.start()).rejects.toMatchObject({step: "scopedJoin"})
    calls.length = 0

    await transport.start()

    expect(calls).toEqual(START_ORDER)
    expect(transport.currentPhase()).toBe("live")
  })
})

describe("SoftapCallTransport leave during every phase", () => {
  /**
   * Leaving mid-join is the common case, not an edge case: the user taps back while the hotspot is
   * still coming up. Each of these blocks one step, calls stop, then releases it, and asserts that
   * everything built so far was released and nothing after the block ever ran.
   */
  const blockable: Array<{step: SoftapStep; override: keyof SoftapCallDeps; released: string[]}> = [
    {step: "hotspot", override: "startHotspot", released: ["stopHotspot"]},
    {step: "scopedJoin", override: "joinScopedNetwork", released: ["leaveScopedNetwork", "stopHotspot"]},
    {
      step: "acsJoin",
      override: "joinMeeting",
      released: ["leaveMeeting", "leaveScopedNetwork", "stopHotspot"],
    },
    {
      step: "publish",
      override: "startPublishing",
      released: ["stopPublishing", "leaveMeeting", "leaveScopedNetwork", "stopHotspot"],
    },
    {
      step: "live",
      override: "awaitFirstFrame",
      released: ["stopPublishing", "leaveMeeting", "leaveScopedNetwork", "stopHotspot"],
    },
  ]

  for (const {step, override, released} of blockable) {
    test(`leaving during ${step} releases what was built and starts nothing further`, async () => {
      let release!: () => void
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      // Wrap the recording default rather than replacing it, so the blocked step is still logged.
      const {calls, transport} = recordingDeps((recorded) => {
        const original = recordingDeps().deps[override] as (...args: never[]) => Promise<unknown>
        return {
          [override]: async (...args: never[]) => {
            await blocked
            const result = await original(...args)
            recorded.push(`${override}:completed`)
            return result
          },
        } as Partial<SoftapCallDeps>
      })

      const started = transport.start()
      // Let the sequence reach the blocked step before leaving.
      await new Promise((resolve) => setTimeout(resolve, 0))
      const stopped = transport.stop()
      release()

      await expect(started).rejects.toBeInstanceOf(SoftapCallError)
      await stopped

      expect(transport.currentPhase()).toBe("failed")
      for (const call of released) {
        expect(calls).toContain(call)
      }
      // Nothing is released twice, which would double-stop a resource another attempt may own.
      for (const call of released) {
        expect(calls.filter((entry) => entry === call)).toHaveLength(1)
      }
    })
  }

  test("a step that resolves after a leave does not leak its resource", async () => {
    // The race that motivates the generation guard: the hotspot comes up just after the user left.
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const calls: string[] = []
    const transport = new SoftapCallTransport({
      startHotspot: async () => {
        await blocked
        calls.push("startHotspot")
        return {ssid: "MentraLive-1234", passphrase: "hunter2!"}
      },
      stopHotspot: async () => {
        calls.push("stopHotspot")
      },
      joinScopedNetwork: async () => {
        calls.push("joinScopedNetwork")
        return "192.168.43.20"
      },
      leaveScopedNetwork: async () => {
        calls.push("leaveScopedNetwork")
      },
      joinMeeting: async () => {
        calls.push("joinMeeting")
        return {ingestUrl: "http://192.168.43.20:8790/whip"}
      },
      leaveMeeting: async () => {
        calls.push("leaveMeeting")
      },
      startPublishing: async () => {
        calls.push("startPublishing")
      },
      stopPublishing: async () => {
        calls.push("stopPublishing")
      },
      awaitFirstFrame: async () => {
        calls.push("awaitFirstFrame")
      },
    })

    const started = transport.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const stopped = transport.stop()
    release()
    await expect(started).rejects.toBeInstanceOf(SoftapCallError)
    await stopped
    // Give the late teardown a turn to run.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await transport.stop()

    expect(calls).toContain("startHotspot")
    expect(calls).toContain("stopHotspot")
    expect(calls).not.toContain("joinScopedNetwork")
  })
})

describe("SoftapCallTransport stop waits for the step in flight", () => {
  /**
   * The restart race, at the layer that can close it.
   *
   * `stop()` used to resolve while the hotspot command was still in flight. The caller took that
   * as "nothing from this call is still coming", started the next one, and the first call's late
   * `setHotspotState(false)` turned off the hotspot the new call had just brought up — which the
   * wearer saw as "Couldn't start glasses hotspot" followed by a scoped join that could not find
   * the SSID.
   */
  test("stop does not resolve until the late step has released what it produced", async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const calls: string[] = []
    const {transport} = recordingDeps({
      startHotspot: async () => {
        await blocked
        calls.push("startHotspot")
        return {ssid: "MentraLive-1234", passphrase: "hunter2!"}
      },
      stopHotspot: async () => {
        calls.push("stopHotspot")
      },
    })

    const started = transport.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const stopped = transport.stop()
    let stopResolved = false
    void stopped.then(() => {
      stopResolved = true
    })
    // The hotspot command is still in flight, so the teardown cannot honestly be finished.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stopResolved).toBe(false)

    release()
    await expect(started).rejects.toBeInstanceOf(SoftapCallError)
    await stopped

    expect(calls).toEqual(["startHotspot", "stopHotspot"])
  })

  /** The point of the wait: the next call starts on a transport with nothing left to fire. */
  test("a call started after stop resolves never sees the previous call's undo", async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    const calls: string[] = []
    const {transport} = recordingDeps({
      startHotspot: async () => {
        if (first) {
          first = false
          await blocked
        }
        calls.push("startHotspot")
        return {ssid: "MentraLive-1234", passphrase: "hunter2!"}
      },
      stopHotspot: async () => {
        calls.push("stopHotspot")
      },
    })

    const started = transport.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const stopped = transport.stop()
    release()
    await expect(started).rejects.toBeInstanceOf(SoftapCallError)
    await stopped
    calls.length = 0

    await transport.start()
    // Give any straggler from the first attempt a turn it must not use.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls).toEqual(["startHotspot"])
    expect(transport.currentPhase()).toBe("live")
  })

  /**
   * The UI half of the same race. A checklist event from the call the wearer just cancelled,
   * arriving after the next one has started, redraws the new call's rows with the old call's
   * progress — the screen jumps backwards, or forwards to a step that has not happened. The
   * cancelled attempt's listener has to stop being a listener the moment the next one begins.
   */
  test("a listener from the cancelled call receives nothing once the next call has begun", async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    const {transport} = recordingDeps({
      startHotspot: async () => {
        if (first) {
          first = false
          await blocked
        }
        return {ssid: "MentraLive-1234", passphrase: "hunter2!"}
      },
    })

    const stale: string[] = []
    const started = transport.start({onProgress: (progress) => stale.push(progress.phase)})
    await new Promise((resolve) => setTimeout(resolve, 0))
    const stopped = transport.stop()
    release()
    await expect(started).rejects.toBeInstanceOf(SoftapCallError)
    await stopped

    const fresh: string[] = []
    stale.length = 0
    await transport.start({onProgress: (progress) => fresh.push(progress.phase)})
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fresh).not.toHaveLength(0)
    expect(stale).toEqual([])
  })

  /**
   * `start()` handles its own failure by awaiting `stop()`. A `stop()` that waited on the whole
   * `start()` promise would therefore wait on itself; it waits on the running step alone.
   */
  test("stop during a failing start resolves rather than deadlocking", async () => {
    const {transport} = recordingDeps({
      joinScopedNetwork: async () => {
        throw new Error("EHOSTUNREACH")
      },
    })

    const started = transport.start()
    const stopped = transport.stop()

    await expect(started).rejects.toBeInstanceOf(SoftapCallError)
    await expect(stopped).resolves.toBeUndefined()
    expect(transport.currentPhase()).toBe("failed")
  })

  /**
   * Cancel can land before the sequence exists at all — the host is still asking for a permission
   * or signing in to Teams. There is nothing to unwind, so refusing the start is the only way the
   * cancellation can mean anything.
   */
  test("a stop before the first start makes that start refuse", async () => {
    const {calls, transport} = recordingDeps()

    await transport.stop()

    await expect(transport.start()).rejects.toMatchObject({code: "CANCELLED"})
    expect(calls).toEqual([])
    expect(transport.currentPhase()).toBe("idle")
  })

  test("a stop between two cycles does not poison the next start", async () => {
    const {transport} = recordingDeps()
    await transport.start()
    await transport.stop()
    await transport.stop()

    await expect(transport.start()).resolves.toBeUndefined()
    expect(transport.currentPhase()).toBe("live")
  })
})

describe("SoftapCallTransport preflight narration", () => {
  /**
   * The host narrates work that happens before the sequence exists (permissions, ACS sign-in) on
   * the first row. Wiping it on the first emit would blank a line the wearer is already reading.
   */
  test("initial step details survive into the first snapshot", async () => {
    const {transport} = recordingDeps({
      startHotspot: async () => new Promise(() => {}) as Promise<{ssid: string; passphrase: string}>,
    })
    const seen: Array<string | undefined> = []

    void transport.start({
      initialSteps: [{step: "hotspot", status: "pending", detail: "Signing in to Teams…"}],
      onProgress: (progress) => seen.push(progress.steps.find((step) => step.step === "hotspot")?.detail),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(seen[0]).toBe("Signing in to Teams…")
    // The step's own narration takes over as soon as it runs.
    expect(seen.at(-1)).toBe("Asking the glasses to turn on their hotspot")
  })

  test("a caller cannot mark a step done before it ran", async () => {
    const {transport} = recordingDeps({
      startHotspot: async () => new Promise(() => {}) as Promise<{ssid: string; passphrase: string}>,
    })
    let first: SoftapProgress | undefined

    void transport.start({
      initialSteps: [{step: "scopedJoin", status: "done", detail: "not really"}],
      onProgress: (progress) => (first ??= progress),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(first?.steps.find((step) => step.step === "scopedJoin")?.status).toBe("pending")
  })
})

describe("SoftapCallTransport cycle cleanliness", () => {
  /**
   * Ten cycles because the failure this catches is cumulative: a step recorded twice, or never
   * cleared, shows up as a teardown that grows by one call per cycle rather than as a single
   * wrong assertion.
   */
  test("ten start/stop cycles leave no residue and repeat exactly", async () => {
    const {calls, transport} = recordingDeps()

    for (let cycle = 0; cycle < 10; cycle += 1) {
      calls.length = 0
      await transport.start()
      expect(calls).toEqual(START_ORDER)

      calls.length = 0
      await transport.stop()
      expect(calls).toEqual(TEARDOWN_ORDER)

      expect(transport.currentPhase()).toBe("idle")
      expect(transport.activeSteps()).toEqual([])
      expect(transport.currentIngestUrl()).toBeNull()
    }
  })

  test("ten failed starts leave no residue either", async () => {
    const {transport} = recordingDeps({
      joinMeeting: async () => {
        throw new Error("ACS unreachable")
      },
    })

    for (let cycle = 0; cycle < 10; cycle += 1) {
      await expect(transport.start()).rejects.toMatchObject({step: "acsJoin"})
      expect(transport.activeSteps()).toEqual([])
      expect(transport.currentIngestUrl()).toBeNull()
    }
  })
})

describe("SoftapCallTransport progress", () => {
  function statuses(progress: SoftapProgress): string {
    return progress.steps.map((step) => `${step.step}=${step.status}`).join(" ")
  }

  test("every step is reported running then done, and the sequence ends live", async () => {
    const {transport} = recordingDeps()
    const seen: string[] = []
    await transport.start({onProgress: (progress) => seen.push(`${progress.phase}: ${statuses(progress)}`)})
    // First and last snapshots pin the envelope; the running/done pairs pin the order in between.
    expect(seen[0]).toBe("starting: hotspot=pending scopedJoin=pending acsJoin=pending publish=pending live=pending")
    expect(seen.at(-1)).toBe("live: hotspot=done scopedJoin=done acsJoin=done publish=done live=done")
    for (const step of ["hotspot", "scopedJoin", "acsJoin", "publish", "live"] as const) {
      const running = seen.findIndex((entry) => entry.includes(`${step}=running`))
      const done = seen.findIndex((entry) => entry.includes(`${step}=done`))
      expect(running).toBeGreaterThanOrEqual(0)
      expect(done).toBeGreaterThan(running)
    }
  })

  test("step details carry the facts the UI needs: SSID, phone address, ingest URL", async () => {
    const {transport} = recordingDeps()
    await transport.start()
    const steps = Object.fromEntries(transport.progress().steps.map((step) => [step.step, step]))
    expect(steps.hotspot.detail).toContain("MentraLive-1234")
    expect(steps.scopedJoin.detail).toContain("192.168.43.20")
    expect(steps.acsJoin.detail).toContain("http://192.168.43.20:8790/whip")
    expect(steps.live.status).toBe("done")
    for (const step of transport.progress().steps) expect(step.durationMs).toBeGreaterThanOrEqual(0)
  })

  test("a step can narrate sub-status while it runs", async () => {
    const {transport} = recordingDeps({
      startPublishing: async (_args, report) => {
        report?.("Glasses accepted the command")
        report?.("Glasses are streaming to the phone")
      },
    })
    const details: string[] = []
    await transport.start({
      onProgress: (progress) => {
        const publish = progress.steps.find((step) => step.step === "publish")
        if (publish?.status === "running" && publish.detail) details.push(publish.detail)
      },
    })
    expect(details).toContain("Glasses accepted the command")
    expect(details).toContain("Glasses are streaming to the phone")
  })

  test("a failed step is marked failed with its reason, later steps stay pending, and the checklist survives teardown", async () => {
    const {transport} = recordingDeps({
      joinMeeting: async () => {
        throw new Error("ACS said no")
      },
    })
    let last: SoftapProgress | undefined
    await expect(transport.start({onProgress: (progress) => (last = progress)})).rejects.toBeInstanceOf(
      SoftapCallError,
    )
    expect(last?.phase).toBe("failed")
    expect(statuses(last!)).toBe("hotspot=done scopedJoin=done acsJoin=failed publish=pending live=pending")
    expect(last?.steps.find((step) => step.step === "acsJoin")?.error).toBe("ACS said no")
    // Still readable after the fact, for a UI that renders from the last known state.
    expect(transport.progress().phase).toBe("failed")
  })

  test("a deliberate stop resets the checklist", async () => {
    const {transport} = recordingDeps()
    await transport.start()
    await transport.stop()
    expect(transport.progress().phase).toBe("idle")
    expect(transport.progress().steps.every((step) => step.status === "pending")).toBe(true)
  })

  test("a listener that throws does not fail the call", async () => {
    const {transport} = recordingDeps()
    await transport.start({
      onProgress: () => {
        throw new Error("UI exploded")
      },
    })
    expect(transport.currentPhase()).toBe("live")
  })

  test("the snapshot carries the trace id so the UI can point at the right logs", async () => {
    const {transport} = recordingDeps()
    let traceId: string | undefined
    await transport.start({traceId: "trace-xyz", onProgress: (progress) => (traceId = progress.traceId)})
    expect(traceId).toBe("trace-xyz")
  })
})

describe("createSoftapCallDeps", () => {
  function subsystems() {
    const calls: Array<[string, unknown]> = []
    return {
      calls,
      subsystems: {
        setHotspotState: async (enabled: boolean) => {
          calls.push(["setHotspotState", enabled])
          return enabled ? {state: "enabled", ssid: "MentraLive-1234", password: "hunter2!"} : {state: "disabled"}
        },
        joinScopedNetwork: async (ssid: string, passphrase: string) => {
          calls.push(["joinScopedNetwork", {ssid, passphrase}])
          return "192.168.43.20"
        },
        leaveScopedNetwork: async () => {
          calls.push(["leaveScopedNetwork", null])
        },
        joinMeeting: async (pkg: string, options: unknown) => {
          calls.push(["joinMeeting", {pkg, options}])
        },
        leaveMeeting: async (pkg: string) => {
          calls.push(["leaveMeeting", pkg])
        },
        ingestUrl: () => "http://192.168.43.20:8790/whip",
        startPublishing: async (pkg: string, options: unknown) => {
          calls.push(["startPublishing", {pkg, options}])
        },
        stopPublishing: async (pkg: string) => {
          calls.push(["stopPublishing", pkg])
        },
      },
    }
  }

  function deps(
    overrides: Partial<ReturnType<typeof subsystems>["subsystems"]> = {},
    options: {hotspotBroadcastWaitMs?: number} = {},
  ) {
    const harness = subsystems()
    return {
      calls: harness.calls,
      deps: createSoftapCallDeps({
        packageName: "com.mentra.call",
        meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
        token: "tok",
        displayName: "Mentra Live",
        awaitFirstFrame: async () => {},
        subsystems: {...harness.subsystems, ...overrides},
        hotspotBroadcastWaitMs: options.hotspotBroadcastWaitMs,
      }),
    }
  }

  test("the meeting is asked for a softap source carrying the hotspot credentials", async () => {
    const harness = deps()

    await harness.deps.joinMeeting({
      ssid: "MentraLive-1234",
      passphrase: "hunter2!",
      bindAddress: "192.168.43.20",
    })

    expect(harness.calls).toContainEqual([
      "joinMeeting",
      {
        pkg: "com.mentra.call",
        options: {
          meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
          token: "tok",
          videoSource: {
            type: "softap",
            ssid: "MentraLive-1234",
            passphrase: "hunter2!",
            bindAddress: "192.168.43.20",
          },
          displayName: "Mentra Live",
        },
      },
    ])
  })

  test("the join waits for the phone's internet to come back before asking ACS for anything", async () => {
    // Joining the hotspot takes this phone off Wi-Fi, and signing in to ACS is the very next thing
    // that needs the internet. On device that ordering cost a 30s stall plus the join step's own
    // timeout, so the wait has to happen first, not concurrently.
    const order: string[] = []
    const {deps: real} = deps({
      awaitValidatedDefaultNetwork: async () => {
        order.push("awaitDefault")
        return {usable: true, detail: "cellular (validated)"}
      },
      joinMeeting: async () => {
        order.push("joinMeeting")
        return {state: "connecting", ingestUrl: "http://192.168.43.20:8790/whip"}
      },
    })

    const details: string[] = []
    await real.joinMeeting({ssid: "MentraLive-1234", passphrase: "hunter2!", bindAddress: "192.168.43.20"}, (d) =>
      details.push(d),
    )

    expect(order).toEqual(["awaitDefault", "joinMeeting"])
    expect(details.some((d) => d.includes("mobile data"))).toBe(true)
    expect(details.some((d) => d.includes("Internet is on cellular (validated)"))).toBe(true)
  })

  test("an unvalidated default network is narrated but does not abort the join", async () => {
    // A route that validates a second later would otherwise fail a call that was about to work.
    // The ACS join has its own bounded timeout for the case that does not recover, and it now
    // reports a nameable cause rather than a bare deadline.
    const {deps: real} = deps({
      awaitValidatedDefaultNetwork: async () => ({usable: false, detail: "cellular (unvalidated)"}),
    })

    const details: string[] = []
    await expect(
      real.joinMeeting({ssid: "MentraLive-1234", passphrase: "hunter2!", bindAddress: "192.168.43.20"}, (d) =>
        details.push(d),
      ),
    ).resolves.toBeDefined()
    expect(details.some((d) => d.includes("not confirmed yet") && d.includes("joining Teams anyway"))).toBe(true)
  })

  test("a host that cannot report its default network says nothing and still joins", async () => {
    // iOS and older Android hosts have no answer here. Narrating a guess would be worse than
    // silence, and refusing to join would ground SoftAP on every host but the newest.
    const quiet = deps()
    const quietDetails: string[] = []
    await expect(
      quiet.deps.joinMeeting({ssid: "MentraLive-1234", passphrase: "hunter2!", bindAddress: "192.168.43.20"}, (d) =>
        quietDetails.push(d),
      ),
    ).resolves.toBeDefined()
    expect(quietDetails.some((d) => d.includes("mobile data"))).toBe(false)

    const nullish = deps({awaitValidatedDefaultNetwork: async () => null})
    await expect(
      nullish.deps.joinMeeting({ssid: "MentraLive-1234", passphrase: "hunter2!", bindAddress: "192.168.43.20"}),
    ).resolves.toBeDefined()
  })

  test("a default-network check that throws is recorded and the join proceeds", async () => {
    // A diagnostic must never be able to fail the call it is diagnosing.
    const {deps: real} = deps({
      awaitValidatedDefaultNetwork: async () => {
        throw new Error("connectivity manager unavailable")
      },
    })

    await expect(
      real.joinMeeting({ssid: "MentraLive-1234", passphrase: "hunter2!", bindAddress: "192.168.43.20"}),
    ).resolves.toBeDefined()
  })

  test("glasses stream_status events narrate the publish step and the listener is released afterwards", async () => {
    let listener: ((event: {status: string; error?: string}) => void) | null = null
    let unsubscribed = false
    const {deps: real} = deps({
      onGlassesStreamStatus: (next) => {
        listener = next
        return () => {
          unsubscribed = true
        }
      },
      startPublishing: async () => {
        listener?.({status: "initializing"})
        listener?.({status: "streaming"})
      },
    })
    const details: string[] = []
    await real.startPublishing({ingestUrl: "http://192.168.43.20:8790/whip", traceId: "t"}, (d) => details.push(d))
    expect(details.some((d) => d.includes("camera starting"))).toBe(true)
    expect(details.some((d) => d.includes("streaming to the phone"))).toBe(true)
    expect(unsubscribed).toBe(true)
  })

  test("a glasses error is narrated with its message, not swallowed", async () => {
    let listener: ((event: {status: string; error?: string}) => void) | null = null
    const {deps: real} = deps({
      onGlassesStreamStatus: (next) => {
        listener = next
        return () => {}
      },
      startPublishing: async () => {
        listener?.({status: "error", error: "WHIP request failed: connect timeout"})
        throw new Error("WHIP request failed: connect timeout")
      },
    })
    const details: string[] = []
    await expect(
      real.startPublishing({ingestUrl: "http://192.168.43.20:8790/whip", traceId: "t"}, (d) => details.push(d)),
    ).rejects.toThrow("connect timeout")
    expect(details).toContain("Glasses reported: WHIP request failed: connect timeout")
  })

  test("the gateway probe verdict is narrated into the scoped join, and a failing probe does not throw", async () => {
    const ok = deps({probeGateway: async () => ({reachable: true, detail: "tcp 192.168.43.1:53 in 12ms"})})
    const okDetails: string[] = []
    await expect(ok.deps.joinScopedNetwork("MentraLive-1234", "hunter2!", (d) => okDetails.push(d))).resolves.toBe(
      "192.168.43.20",
    )
    expect(okDetails.at(-1)).toContain("glasses OK")

    const bad = deps({probeGateway: async () => ({reachable: false, detail: "timeout"})})
    const badDetails: string[] = []
    await expect(bad.deps.joinScopedNetwork("MentraLive-1234", "hunter2!", (d) => badDetails.push(d))).resolves.toBe(
      "192.168.43.20",
    )
    expect(badDetails.at(-1)).toContain("cannot reach the glasses")

    const thrown = deps({
      probeGateway: async () => {
        throw new Error("probe crashed")
      },
    })
    await expect(thrown.deps.joinScopedNetwork("MentraLive-1234", "hunter2!")).resolves.toBe("192.168.43.20")
  })

  test("an Unavailable scoped join cycles the glasses hotspot and joins again from idle", async () => {
    // The first specifier steals wlan0 from office/personal Wi-Fi and Samsung assoc-rejects the
    // glasses AP. After that request dies the STA is idle — cycling the AP and joining again is
    // the recovery that worked at 17:43:20 after a failed switch.
    let attempts = 0
    const {calls, deps: real} = deps(
      {
        joinScopedNetwork: async () => {
          attempts += 1
          if (attempts === 1) {
            throw new Error(
              "Call to function 'MentraAcsMeeting.joinScopedNetwork' has been rejected.\n→ Caused by: com.mentra.acsmeeting.network.ScopedNetworkError$Unavailable: Could not join MentraLive_15f63c (SSID not in scan, Wi-Fi off, or the system join prompt was dismissed)",
            )
          }
          return "192.168.43.20"
        },
      },
      {hotspotBroadcastWaitMs: 0},
    )
    const details: string[] = []
    await expect(real.joinScopedNetwork("MentraLive-1234", "hunter2!", (d) => details.push(d))).resolves.toBe(
      "192.168.43.20",
    )
    expect(attempts).toBe(2)
    expect(calls).toContainEqual(["setHotspotState", false])
    expect(calls).toContainEqual(["setHotspotState", true])
    expect(details.some((d) => d.includes("cycling"))).toBe(true)
  })

  test("a non-Unavailable scoped join failure is not retried", async () => {
    let attempts = 0
    const {deps: real} = deps({
      joinScopedNetwork: async () => {
        attempts += 1
        throw new Error("SOFTAP_WIFI_DISABLED")
      },
    })
    await expect(real.joinScopedNetwork("MentraLive-1234", "hunter2!")).rejects.toThrow("SOFTAP_WIFI_DISABLED")
    expect(attempts).toBe(1)
  })

  test("the glasses are told to publish in host-only ICE mode", async () => {
    // An empty stun server is what puts the glasses in host-only mode; a configured one would add
    // several seconds of doomed gathering to every call, since the hotspot has no route to it.
    const harness = deps()

    await harness.deps.startPublishing({
      ingestUrl: "http://192.168.43.20:8790/whip",
      traceId: "abc123",
    })

    expect(harness.calls).toContainEqual([
      "startPublishing",
      {
        pkg: "com.mentra.call",
        options: {
          streamUrl: "http://192.168.43.20:8790/whip",
          ice: {stun: ""},
          traceId: "abc123",
          captureAudio: true,
        },
      },
    ])
  })

  /**
   * Which side carries the wearer's voice has to be settled before the BLE start command goes out.
   *
   * The glasses cannot drop an audio track they already negotiated, so deciding afterwards leaves a
   * call with two live copies of the wearer — the LC3 uplink and the published WHIP track, tens of
   * milliseconds apart, which is worse than either one alone.
   */
  test("an LC3 uplink makes the glasses publish video only", async () => {
    const harness = subsystems()
    const details: string[] = []
    const real = createSoftapCallDeps({
      packageName: "com.mentra.call",
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      awaitFirstFrame: async () => {},
      subsystems: {...harness.subsystems, glassesLc3Uplink: () => true},
    })

    await real.startPublishing({ingestUrl: "http://192.168.43.20:8790/whip", traceId: "abc123"}, (d) =>
      details.push(d),
    )

    expect(harness.calls).toContainEqual([
      "startPublishing",
      {
        pkg: "com.mentra.call",
        options: {
          streamUrl: "http://192.168.43.20:8790/whip",
          ice: {stun: ""},
          traceId: "abc123",
          captureAudio: false,
        },
      },
    ])
    expect(details.some((d) => d.includes("Bluetooth LC3"))).toBe(true)
  })

  test("without an LC3 uplink the glasses keep putting their microphone on the WHIP track", async () => {
    const harness = subsystems()
    const real = createSoftapCallDeps({
      packageName: "com.mentra.call",
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      awaitFirstFrame: async () => {},
      subsystems: {...harness.subsystems, glassesLc3Uplink: () => false},
    })

    await real.startPublishing({ingestUrl: "http://192.168.43.20:8790/whip", traceId: "abc123"})

    expect(harness.calls).toContainEqual([
      "startPublishing",
      {
        pkg: "com.mentra.call",
        options: {
          streamUrl: "http://192.168.43.20:8790/whip",
          ice: {stun: ""},
          traceId: "abc123",
          captureAudio: true,
        },
      },
    ])
  })

  /** A host that predates the uplink must keep the audio track it has always published. */
  test("a host with no LC3 uplink getter publishes audio", async () => {
    const harness = deps()

    await harness.deps.startPublishing({ingestUrl: "http://192.168.43.20:8790/whip", traceId: "abc123"})

    expect(harness.calls).toContainEqual([
      "startPublishing",
      {
        pkg: "com.mentra.call",
        options: {
          streamUrl: "http://192.168.43.20:8790/whip",
          ice: {stun: ""},
          traceId: "abc123",
          captureAudio: true,
        },
      },
    ])
  })

  test("waitUntilHotspotJoinable is a no-op when the wait is disabled", async () => {
    const harness = deps()
    const timed = createSoftapCallDeps({
      packageName: "com.mentra.call",
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      awaitFirstFrame: async () => {},
      subsystems: {
        setHotspotState: async () => ({state: "enabled", ssid: "MentraLive-1234", password: "hunter2!"}),
        joinScopedNetwork: async () => "192.168.43.20",
        leaveScopedNetwork: async () => {},
        joinMeeting: async () => {},
        leaveMeeting: async () => {},
        ingestUrl: () => null,
        startPublishing: async () => {},
        stopPublishing: async () => {},
      },
      hotspotBroadcastWaitMs: 0,
    })

    const started = Date.now()
    await timed.waitUntilHotspotJoinable()
    expect(Date.now() - started).toBeLessThan(50)
    expect(harness.calls).toEqual([])
  })

  test("a hotspot that reports enabled with no password is a failure", async () => {
    const harness = deps({
      setHotspotState: async () => ({state: "enabled", ssid: "MentraLive-1234"}),
    })

    await expect(harness.deps.startHotspot()).rejects.toThrow("no password")
  })

  test("a hotspot that reports enabled with no SSID is a failure", async () => {
    const harness = deps(
      {
        setHotspotState: async () => ({state: "enabled"}),
      },
      {hotspotBroadcastWaitMs: 0},
    )

    await expect(harness.deps.startHotspot()).rejects.toThrow()
  })

  test("a hotspot that stays disabled is a failure naming the state", async () => {
    const harness = deps(
      {
        setHotspotState: async () => ({state: "disabled"}),
      },
      {hotspotBroadcastWaitMs: 0},
    )

    await expect(harness.deps.startHotspot()).rejects.toThrow("state=disabled")
  })

  test("a first enable that fails is cycled off and tried again", async () => {
    let enables = 0
    const toggles: boolean[] = []
    const {deps: real} = deps(
      {
        setHotspotState: async (enabled: boolean) => {
          toggles.push(enabled)
          if (enabled) {
            enables += 1
            if (enables === 1) return {state: "disabled"}
            return {state: "enabled", ssid: "MentraLive-1234", password: "hunter2!"}
          }
          return {state: "disabled"}
        },
      },
      {hotspotBroadcastWaitMs: 0},
    )
    const details: string[] = []
    await expect(real.startHotspot((d) => details.push(d))).resolves.toEqual({
      ssid: "MentraLive-1234",
      passphrase: "hunter2!",
    })
    expect(enables).toBe(2)
    expect(toggles).toEqual([true, false, true])
    expect(details.some((d) => d.includes("trying again"))).toBe(true)
  })

  test("stopHotspot asks for disabled rather than toggling blindly", async () => {
    const harness = deps()

    await harness.deps.stopHotspot()

    expect(harness.calls).toContainEqual(["setHotspotState", false])
  })

  test("a join that binds no listener surfaces an empty ingest URL for the sequence to reject", async () => {
    const harness = deps({ingestUrl: () => null})

    await expect(harness.deps.joinMeeting({ssid: "MentraLive-1234", passphrase: "hunter2!"})).resolves.toEqual({
      ingestUrl: "",
    })
  })
})
