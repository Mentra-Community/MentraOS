/// <reference types="bun-types" />

import {beforeEach, describe, expect, test} from "bun:test"

import {MentraJSCrashController} from "../MentraJSCrashController"

describe("MentraJSCrashController", () => {
  let clock: number
  let controller: MentraJSCrashController

  beforeEach(() => {
    clock = 1_000_000
    controller = new MentraJSCrashController({
      now: () => clock,
      backoffMs: [2_000, 8_000, 30_000],
      crashWindowMs: 5 * 60_000,
      maxRetries: 3,
      cleanUptimeResetMs: 60_000,
    })
  })

  function advance(ms: number) {
    clock += ms
  }

  test("onSpawn enters RUNNING", () => {
    controller.onSpawn("com.foo")
    expect(controller.stateFor("com.foo")?.kind).toBe("RUNNING")
  })

  test("first crash schedules 2s backoff and quiet log level", () => {
    controller.onSpawn("com.foo")
    const outcome = controller.onCrash("com.foo", "uncaught throw")
    expect(outcome.scheduleRespawnAfterMs).toBe(2000)
    expect(outcome.surfaceCrashloopBanner).toBeFalsy()
    expect(outcome.showRestartToast).toBeFalsy()
    expect(outcome.sentryLevel).toBe("info")
    expect(controller.stateFor("com.foo")?.kind).toBe("BACKOFF")
  })

  test("second crash inside the window escalates to 8s + restart toast", () => {
    controller.onSpawn("com.foo")
    controller.onCrash("com.foo", "1")
    advance(3_000)
    controller.onSpawn("com.foo") // respawn
    advance(500) // less than cleanUptimeResetMs (60s) so retry budget persists
    const outcome = controller.onCrash("com.foo", "2")
    expect(outcome.scheduleRespawnAfterMs).toBe(8000)
    expect(outcome.showRestartToast).toBe(true)
    expect(outcome.sentryLevel).toBe("warning")
  })

  test("third crash escalates to 30s + warning level", () => {
    controller.onSpawn("com.foo")
    controller.onCrash("com.foo", "1")
    advance(2_000)
    controller.onSpawn("com.foo")
    advance(500)
    controller.onCrash("com.foo", "2")
    advance(8_000)
    controller.onSpawn("com.foo")
    advance(500)
    const outcome = controller.onCrash("com.foo", "3")
    expect(outcome.scheduleRespawnAfterMs).toBe(30_000)
    expect(outcome.showRestartToast).toBe(true)
  })

  test("fourth crash inside the window transitions to CRASHLOOP_DISABLED", () => {
    controller.onSpawn("com.foo")
    for (let i = 0; i < 3; i++) {
      controller.onCrash("com.foo", String(i))
      advance(1_000)
      controller.onSpawn("com.foo")
      advance(500) // stay below clean-uptime reset
    }
    const outcome = controller.onCrash("com.foo", "4")
    expect(controller.stateFor("com.foo")?.kind).toBe("CRASHLOOP_DISABLED")
    expect(outcome.surfaceCrashloopBanner).toBe(true)
    expect(outcome.scheduleRespawnAfterMs).toBeUndefined()
    expect(outcome.sentryLevel).toBe("error")
  })

  test("clean uptime >= cleanUptimeResetMs resets the retry counter", () => {
    controller.onSpawn("com.foo")
    controller.onCrash("com.foo", "1")
    advance(2_000)
    controller.onSpawn("com.foo")
    advance(70_000) // longer than cleanUptimeResetMs
    const outcome = controller.onCrash("com.foo", "2-after-stable")
    // Should look like a "first" crash again.
    expect(outcome.scheduleRespawnAfterMs).toBe(2_000)
    expect(outcome.showRestartToast).toBeFalsy()
  })

  test("crashes that fall outside the window are pruned", () => {
    controller.onSpawn("com.foo")
    controller.onCrash("com.foo", "old")
    advance(6 * 60_000) // beyond the 5min window
    controller.onSpawn("com.foo")
    const outcome = controller.onCrash("com.foo", "fresh")
    expect(outcome.scheduleRespawnAfterMs).toBe(2_000)
  })

  test("disabledPackages reflects current state", () => {
    controller.onSpawn("a")
    controller.onSpawn("b")
    for (let i = 0; i < 4; i++) {
      const outcome = controller.onCrash("a", String(i))
      advance(1_000)
      if (outcome.scheduleRespawnAfterMs !== undefined) {
        controller.onSpawn("a")
      }
      advance(100)
    }
    expect(controller.disabledPackages()).toEqual(["a"])
  })

  test("reset(packageName) clears the disabled state and the crash history", () => {
    controller.onSpawn("a")
    for (let i = 0; i < 4; i++) {
      const outcome = controller.onCrash("a", String(i))
      advance(1_000)
      // Real orchestrators only respawn when the policy schedules one.
      if (outcome.scheduleRespawnAfterMs !== undefined) {
        controller.onSpawn("a")
      }
      advance(100)
    }
    expect(controller.disabledPackages()).toEqual(["a"])
    controller.reset("a")
    expect(controller.stateFor("a")?.kind).toBe("RUNNING")
    expect(controller.disabledPackages()).toEqual([])
  })

  test("respawnCount increments on each onSpawn after the first", () => {
    controller.onSpawn("a")
    controller.onSpawn("a")
    controller.onSpawn("a")
    expect(controller.respawnCount("a")).toBe(2)
  })

  test("onKill drops package state", () => {
    controller.onSpawn("a")
    controller.onCrash("a", "boom")
    controller.onKill("a")
    expect(controller.stateFor("a")).toBeNull()
  })

  // No-opts construction: zero retries by default. The block above exercises
  // the backoff-state-machine with maxRetries:3; this block exercises the
  // fail-fast default.
  describe("default zero-retry policy", () => {
    test("first crash with no opts transitions straight to CRASHLOOP_DISABLED", () => {
      const c = new MentraJSCrashController({now: () => clock})
      c.onSpawn("com.foo")
      const outcome = c.onCrash("com.foo", "uncaught throw")
      expect(c.stateFor("com.foo")?.kind).toBe("CRASHLOOP_DISABLED")
      expect(outcome.scheduleRespawnAfterMs).toBeUndefined()
      expect(outcome.surfaceCrashloopBanner).toBe(true)
      expect(outcome.sentryLevel).toBe("error")
    })

    test("reset() re-enables the package; the next crash again hard-disables it", () => {
      const c = new MentraJSCrashController({now: () => clock})
      c.onSpawn("com.foo")
      c.onCrash("com.foo", "1")
      c.reset("com.foo")
      expect(c.stateFor("com.foo")?.kind).toBe("RUNNING")
      const outcome = c.onCrash("com.foo", "2")
      expect(c.stateFor("com.foo")?.kind).toBe("CRASHLOOP_DISABLED")
      expect(outcome.scheduleRespawnAfterMs).toBeUndefined()
    })
  })
})
