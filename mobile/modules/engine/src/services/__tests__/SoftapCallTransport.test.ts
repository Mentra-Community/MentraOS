/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {
  createSoftapCallDeps,
  SoftapCallError,
  SoftapCallTransport,
  type SoftapCallDeps,
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

  function deps(overrides: Partial<ReturnType<typeof subsystems>["subsystems"]> = {}) {
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
        },
      },
    ])
  })

  test("a hotspot that reports enabled with no SSID is a failure", async () => {
    const harness = deps({
      setHotspotState: async () => ({state: "enabled"}),
    })

    await expect(harness.deps.startHotspot()).rejects.toThrow()
  })

  test("a hotspot that stays disabled is a failure naming the state", async () => {
    const harness = deps({
      setHotspotState: async () => ({state: "disabled"}),
    })

    await expect(harness.deps.startHotspot()).rejects.toThrow("state=disabled")
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
