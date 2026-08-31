import {StoreUpdateSchedulerCore} from "./StoreUpdateSchedulerCore"

function harness() {
  const calls: string[] = []
  const warnings: string[] = []
  let foreground: (() => void) | null = null
  let reconnect: (() => void) | null = null
  let interval: (() => void) | null = null
  const scheduler = new StoreUpdateSchedulerCore({
    invoke: async (packageName) => {
      calls.push(packageName)
    },
    subscribeForeground: (handler) => {
      foreground = handler
      return () => {
        foreground = null
      }
    },
    subscribeReconnect: (handler) => {
      reconnect = handler
      return () => {
        reconnect = null
      }
    },
    setInterval: (handler) => {
      interval = handler
      return 1
    },
    clearInterval: () => {
      interval = null
    },
    warn: (message) => warnings.push(message),
  })
  return {
    scheduler,
    calls,
    warnings,
    foreground: () => foreground?.(),
    reconnect: () => reconnect?.(),
    interval: () => interval?.(),
  }
}

describe("StoreUpdateSchedulerCore", () => {
  test("checks every configured Store at startup and each lifecycle trigger", async () => {
    const h = harness()
    await h.scheduler.start(["com.mentra.store", "com.oem.store"])
    expect(h.calls).toEqual(["com.mentra.store", "com.oem.store"])

    h.foreground()
    await h.scheduler.waitForIdle()
    h.reconnect()
    await h.scheduler.waitForIdle()
    h.interval()
    await h.scheduler.waitForIdle()
    expect(h.calls).toHaveLength(8)
  })

  test("deduplicates Store packages and stops responding after teardown", async () => {
    const h = harness()
    await h.scheduler.start(["com.mentra.store", "com.mentra.store"])
    expect(h.calls).toEqual(["com.mentra.store"])
    h.scheduler.stop()
    h.foreground()
    h.reconnect()
    h.interval()
    await h.scheduler.trigger()
    expect(h.calls).toEqual(["com.mentra.store"])
  })
})
