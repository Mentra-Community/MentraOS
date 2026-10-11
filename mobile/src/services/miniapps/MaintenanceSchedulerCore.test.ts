import {MaintenanceSchedulerCore} from "./MaintenanceSchedulerCore"

function harness(runOnStart?: boolean) {
  const runs: string[] = []
  let fire = () => {}
  let tick = () => {}
  const scheduler = new MaintenanceSchedulerCore<string>({
    run: async (target) => {
      runs.push(target)
    },
    triggers: [
      (handler) => {
        fire = handler
        return () => {
          fire = () => {}
        }
      },
    ],
    intervalMs: 1000,
    runOnStart,
    setInterval: (handler) => {
      tick = handler
      return 1
    },
    clearInterval: () => {
      tick = () => {}
    },
    warn: () => {},
  })
  return {scheduler, runs, fire: () => fire(), tick: () => tick()}
}

describe("MaintenanceSchedulerCore", () => {
  it("runs at start by default", async () => {
    const h = harness()
    await h.scheduler.start(["a"])
    expect(h.runs).toEqual(["a"])
  })

  it("can wait for the first trigger instead, then runs on triggers and the interval", async () => {
    const h = harness(false)
    await h.scheduler.start(["a"])
    expect(h.runs).toEqual([])
    h.fire()
    await h.scheduler.waitForIdle()
    h.tick()
    await h.scheduler.waitForIdle()
    expect(h.runs).toEqual(["a", "a"])
    h.scheduler.stop()
    h.fire()
    h.tick()
    await h.scheduler.waitForIdle()
    expect(h.runs).toEqual(["a", "a"])
  })
})
