// Imports the real GlassesReadiness module by path (not via "@mentra/engine",
// which jest mocks) so the actual logic runs under the mobile jest CI runner.
import {
  isGlassesConnected,
  isGlassesLinkLayerBusy,
  isGlassesReady,
  waitForGlassesReady,
  type GlassesConnectionStatus,
} from "../../modules/engine/src/services/GlassesReadiness"

describe("GlassesReadiness predicates", () => {
  it("isGlassesConnected is true only when connected", () => {
    expect(isGlassesConnected({state: "connected", fullyBooted: false})).toBe(true)
    expect(isGlassesConnected({state: "connected", fullyBooted: true})).toBe(true)
    expect(isGlassesConnected({state: "scanning"})).toBe(false)
    expect(isGlassesConnected({state: "disconnected"})).toBe(false)
  })

  it("isGlassesReady requires connected AND fullyBooted", () => {
    expect(isGlassesReady({state: "connected", fullyBooted: true})).toBe(true)
    expect(isGlassesReady({state: "connected", fullyBooted: false})).toBe(false)
    expect(isGlassesReady({state: "connecting"})).toBe(false)
    expect(isGlassesReady({state: "disconnected"})).toBe(false)
  })

  it("isGlassesLinkLayerBusy covers scanning/connecting/bonding only", () => {
    expect(isGlassesLinkLayerBusy({state: "scanning"})).toBe(true)
    expect(isGlassesLinkLayerBusy({state: "connecting"})).toBe(true)
    expect(isGlassesLinkLayerBusy({state: "bonding"})).toBe(true)
    expect(isGlassesLinkLayerBusy({state: "connected", fullyBooted: true})).toBe(false)
    expect(isGlassesLinkLayerBusy({state: "disconnected"})).toBe(false)
  })
})

describe("waitForGlassesReady", () => {
  function makeHarness(initial: GlassesConnectionStatus) {
    let current = initial
    const listeners = new Set<(c: GlassesConnectionStatus) => void>()
    return {
      getConnection: () => current,
      subscribe: (l: (c: GlassesConnectionStatus) => void) => {
        listeners.add(l)
        return () => {
          listeners.delete(l)
        }
      },
      emit: (c: GlassesConnectionStatus) => {
        current = c
        for (const l of listeners) l(c)
      },
      listenerCount: () => listeners.size,
    }
  }

  it("resolves true immediately when already ready (never subscribes)", async () => {
    const h = makeHarness({state: "connected", fullyBooted: true})
    await expect(waitForGlassesReady({getConnection: h.getConnection, subscribe: h.subscribe})).resolves.toBe(true)
    expect(h.listenerCount()).toBe(0)
  })

  it("resolves true once the glasses become ready, then unsubscribes", async () => {
    const h = makeHarness({state: "connecting"})
    const p = waitForGlassesReady({getConnection: h.getConnection, subscribe: h.subscribe, timeoutMs: 10_000})
    expect(h.listenerCount()).toBe(1)
    h.emit({state: "connected", fullyBooted: false}) // connected but not booted — keep waiting
    expect(h.listenerCount()).toBe(1)
    h.emit({state: "connected", fullyBooted: true}) // booted
    await expect(p).resolves.toBe(true)
    expect(h.listenerCount()).toBe(0)
  })

  it("unsubscribes even when subscribe notifies synchronously with a ready state", async () => {
    // Some adapters emit their current state synchronously during subscribe();
    // the wait must still tear down the subscription rather than leak it.
    const listeners = new Set<(c: GlassesConnectionStatus) => void>()
    const subscribe = (l: (c: GlassesConnectionStatus) => void) => {
      listeners.add(l)
      l({state: "connected", fullyBooted: true})
      return () => {
        listeners.delete(l)
      }
    }
    const ready = await waitForGlassesReady({getConnection: () => ({state: "connecting"}), subscribe})
    expect(ready).toBe(true)
    expect(listeners.size).toBe(0)
  })

  it("resolves false on timeout and unsubscribes", async () => {
    jest.useFakeTimers()
    try {
      const h = makeHarness({state: "connecting"})
      const p = waitForGlassesReady({getConnection: h.getConnection, subscribe: h.subscribe, timeoutMs: 35_000})
      expect(h.listenerCount()).toBe(1)
      jest.advanceTimersByTime(35_000)
      await expect(p).resolves.toBe(false)
      expect(h.listenerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it("resolves false and unsubscribes when the signal aborts", async () => {
    const controller = new AbortController()
    const h = makeHarness({state: "connecting"})
    const p = waitForGlassesReady({
      getConnection: h.getConnection,
      subscribe: h.subscribe,
      timeoutMs: 10_000,
      signal: controller.signal,
    })
    expect(h.listenerCount()).toBe(1)
    controller.abort()
    await expect(p).resolves.toBe(false)
    expect(h.listenerCount()).toBe(0)
  })

  it("resolves false immediately when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const h = makeHarness({state: "connecting"})
    const ready = await waitForGlassesReady({
      getConnection: h.getConnection,
      subscribe: h.subscribe,
      signal: controller.signal,
    })
    expect(ready).toBe(false)
    expect(h.listenerCount()).toBe(0)
  })
})
