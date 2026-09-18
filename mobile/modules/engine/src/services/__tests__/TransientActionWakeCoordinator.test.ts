import {describe, expect, test} from "bun:test"

import {TransientActionWakeCoordinator} from "../TransientActionWakeCoordinator"

function harness(initial?: {context?: boolean; projected?: boolean}) {
  let context = initial?.context ?? false
  let projected = initial?.projected ?? false
  let ensureCalls = 0
  let stopCalls = 0
  const coordinator = new TransientActionWakeCoordinator({
    isContextRunning: () => context,
    isProjectedRunning: () => projected,
    ensureConnectedHidden: async () => {
      ensureCalls += 1
      context = true
    },
    stopContext: async () => {
      stopCalls += 1
      context = false
    },
  })
  return {
    coordinator,
    get ensureCalls() {
      return ensureCalls
    },
    get stopCalls() {
      return stopCalls
    },
    promote() {
      projected = true
    },
  }
}

describe("TransientActionWakeCoordinator", () => {
  test("tears down a context created only for one transient invocation", async () => {
    const h = harness()
    const release = await h.coordinator.acquire("com.example.target")
    expect(h.ensureCalls).toBe(1)
    await release()
    expect(h.stopCalls).toBe(1)
  })

  test("waits for every concurrent invocation before teardown", async () => {
    const h = harness()
    const first = await h.coordinator.acquire("com.example.target")
    const second = await h.coordinator.acquire("com.example.target")
    await first()
    expect(h.stopCalls).toBe(0)
    await second()
    expect(h.stopCalls).toBe(1)
  })

  test("does not stop a context that was already running", async () => {
    const h = harness({context: true, projected: true})
    const release = await h.coordinator.acquire("com.example.target")
    await release()
    expect(h.stopCalls).toBe(0)
  })

  test("does not stop a transient context promoted by a user open", async () => {
    const h = harness()
    const release = await h.coordinator.acquire("com.example.target")
    h.promote()
    await release()
    expect(h.stopCalls).toBe(0)
  })

  test("forget makes a later release harmless after external teardown", async () => {
    const h = harness()
    const release = await h.coordinator.acquire("com.example.target")
    h.coordinator.forget("com.example.target")
    await release()
    expect(h.stopCalls).toBe(0)
  })

  test("a new invocation waits for an in-flight final teardown", async () => {
    let running = false
    let ensureCalls = 0
    let stopCalls = 0
    let finishStop!: () => void
    const stopGate = new Promise<void>((resolve) => {
      finishStop = resolve
    })
    const coordinator = new TransientActionWakeCoordinator({
      isContextRunning: () => running,
      isProjectedRunning: () => false,
      ensureConnectedHidden: async () => {
        ensureCalls += 1
        running = true
      },
      stopContext: async () => {
        stopCalls += 1
        await stopGate
        running = false
      },
    })

    const firstRelease = await coordinator.acquire("com.example.target")
    const firstTeardown = firstRelease()
    const secondAcquire = coordinator.acquire("com.example.target")
    await Promise.resolve()

    expect(ensureCalls).toBe(1)
    finishStop()
    await firstTeardown
    const secondRelease = await secondAcquire

    expect(ensureCalls).toBe(2)
    expect(stopCalls).toBe(1)
    await secondRelease()
    expect(stopCalls).toBe(2)
  })
})
