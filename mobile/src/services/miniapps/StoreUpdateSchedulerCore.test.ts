import {STORE_UPDATE_INTERVAL_MS, StoreUpdateSchedulerCore} from "./StoreUpdateSchedulerCore"

function harness(invoke: (packageName: string) => Promise<unknown> = async () => undefined) {
  const calls: string[] = []
  const warnings: string[] = []
  const triggers: Record<"foreground" | "reconnect" | "deferred" | "interval", (() => void) | null> = {
    foreground: null,
    reconnect: null,
    deferred: null,
    interval: null,
  }
  let intervalMs = 0
  const subscribe = (name: "foreground" | "reconnect" | "deferred") => (handler: () => void) => {
    triggers[name] = handler
    return () => {
      triggers[name] = null
    }
  }
  const scheduler = new StoreUpdateSchedulerCore({
    invoke: async (packageName) => {
      calls.push(packageName)
      return invoke(packageName)
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
  const fire = (name: keyof typeof triggers) => triggers[name]?.()
  return {scheduler, calls, warnings, fire, intervalMs: () => intervalMs, triggers}
}

describe("StoreUpdateSchedulerCore", () => {
  it("checks every Store at startup, foreground, reconnect, a deferred update and every 15 minutes", async () => {
    const h = harness()
    await h.scheduler.start(["com.mentra.store", "com.oem.store"])
    expect(h.calls).toEqual(["com.mentra.store", "com.oem.store"])
    expect(h.intervalMs()).toBe(STORE_UPDATE_INTERVAL_MS)
    expect(STORE_UPDATE_INTERVAL_MS).toBe(15 * 60_000)
    for (const trigger of ["foreground", "reconnect", "deferred", "interval"] as const) {
      h.fire(trigger)
      await h.scheduler.waitForIdle()
    }
    expect(h.calls).toHaveLength(10)
  })

  it("coalesces triggers that arrive during a pass into one more pass", async () => {
    let release!: () => void
    const h = harness(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const first = h.scheduler.start(["com.mentra.store"])
    h.fire("foreground")
    h.fire("reconnect")
    h.fire("interval")
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The three triggers run one more pass, not three.
    expect(h.calls).toEqual(["com.mentra.store", "com.mentra.store"])
    release()
    await first
    await h.scheduler.waitForIdle()
    expect(h.calls).toEqual(["com.mentra.store", "com.mentra.store"])
  })

  it("keeps going after a failed check and reports it", async () => {
    const h = harness(async (packageName) => {
      if (packageName === "com.oem.store") throw new Error("offline")
    })
    await h.scheduler.start(["com.oem.store", "com.mentra.store"])
    expect(h.calls).toEqual(["com.oem.store", "com.mentra.store"])
    expect(h.warnings).toEqual(["Store update reconciliation failed for com.oem.store"])
  })

  it("deduplicates Stores and stops responding after teardown", async () => {
    const h = harness()
    await h.scheduler.start(["com.mentra.store", "com.mentra.store"])
    expect(h.calls).toEqual(["com.mentra.store"])
    h.scheduler.stop()
    expect(Object.values(h.triggers).every((trigger) => trigger === null)).toBe(true)
    await h.scheduler.trigger()
    expect(h.calls).toEqual(["com.mentra.store"])
  })

  it("stops when the active deployment allows no Store, and resumes when it allows one again", async () => {
    const h = harness()
    await h.scheduler.start(["com.mentra.store"])
    await h.scheduler.start([])
    h.fire("foreground")
    await h.scheduler.trigger()
    expect(h.calls).toEqual(["com.mentra.store"])
    await h.scheduler.start(["com.mentra.store"])
    expect(h.calls).toHaveLength(2)
  })
})
