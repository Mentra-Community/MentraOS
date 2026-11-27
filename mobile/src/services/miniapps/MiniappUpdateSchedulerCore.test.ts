import {MINIAPP_UPDATE_INTERVAL_MS, MiniappUpdateSchedulerCore} from "./MiniappUpdateSchedulerCore"

type TriggerName = "foreground" | "reconnect" | "deferred" | "interval"

function harness(checkAll: () => Promise<unknown> = async () => undefined) {
  const calls: string[] = []
  const warnings: string[] = []
  const triggers: Record<TriggerName, (() => void) | null> = {
    foreground: null,
    reconnect: null,
    deferred: null,
    interval: null,
  }
  let intervalMs = 0
  const subscribe = (name: Exclude<TriggerName, "interval">) => (handler: () => void) => {
    triggers[name] = handler
    return () => {
      triggers[name] = null
    }
  }
  const scheduler = new MiniappUpdateSchedulerCore({
    checkAll: async () => {
      calls.push("all")
      return checkAll()
    },
    subscribeForeground: subscribe("foreground"),
    subscribeReconnect: subscribe("reconnect"),
    subscribeDeferredUpdateReady: subscribe("deferred"),
    setInterval: (handler, ms) => {
      triggers.interval = handler
      intervalMs = ms
      return 1
    },
    clearInterval: () => {
      triggers.interval = null
    },
    warn: (message) => warnings.push(message),
  })
  const fire = (name: TriggerName) => triggers[name]?.()
  return {
    scheduler,
    calls,
    warnings,
    fire,
    intervalMs: () => intervalMs,
    triggers,
  }
}

describe("MiniappUpdateSchedulerCore", () => {
  it("checks at startup, foreground, reconnect, a deferred update and every 15 minutes", async () => {
    const h = harness()
    await h.scheduler.start()
    expect(h.calls).toEqual(["all"])
    expect(h.intervalMs()).toBe(MINIAPP_UPDATE_INTERVAL_MS)
    expect(MINIAPP_UPDATE_INTERVAL_MS).toBe(15 * 60_000)
    for (const trigger of ["foreground", "reconnect", "deferred", "interval"] as const) {
      h.fire(trigger)
      await h.scheduler.waitForIdle()
    }
    expect(h.calls).toEqual(["all", "all", "all", "all", "all"])
  })

  it("coalesces triggers that arrive during a pass into one more pass", async () => {
    let release!: () => void
    const h = harness(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const first = h.scheduler.start()
    h.fire("foreground")
    h.fire("reconnect")
    h.fire("interval")
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The three triggers run one more pass, not three.
    expect(h.calls).toEqual(["all", "all"])
    release()
    await first
    await h.scheduler.waitForIdle()
    expect(h.calls).toEqual(["all", "all"])
  })

  it("reports a failed pass and keeps checking", async () => {
    let fail = true
    const h = harness(async () => {
      if (fail) throw new Error("offline")
    })
    await h.scheduler.start()
    expect(h.warnings).toEqual(["Miniapp update check failed"])
    fail = false
    h.fire("foreground")
    await h.scheduler.waitForIdle()
    expect(h.calls).toEqual(["all", "all"])
  })

  it("stops responding after teardown", async () => {
    const h = harness()
    await h.scheduler.start()
    h.scheduler.stop()
    expect(Object.values(h.triggers).every((trigger) => trigger === null)).toBe(true)
    await h.scheduler.trigger()
    expect(h.calls).toEqual(["all"])
  })
})
