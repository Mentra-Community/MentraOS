/**
 * Unit tests for LocalDisplayManager.
 *
 * Covers boot window, throttle, durationMs expiry, and core-vs-background
 * arbitration. Uses jest fake timers + an injected clock.
 */

// Override the global mock of "core" so we can capture displayEvent calls.
const displayEventMock = jest.fn()
jest.doMock("core", () => ({
  __esModule: true,
  default: {
    displayEvent: displayEventMock,
  },
}))

// DisplayProcessor: pass through unchanged so we can assert on the raw event.
jest.doMock("@/services/DisplayProcessor", () => ({
  __esModule: true,
  default: {
    processDisplayEvent: (e: Record<string, unknown>) => ({...e, _processed: true}),
  },
}))

// useDisplayStore: stub setDisplayEvent so we don't pull in zustand.
const setDisplayEventMock = jest.fn()
jest.doMock("@/stores/display", () => ({
  __esModule: true,
  useDisplayStore: {
    getState: () => ({setDisplayEvent: setDisplayEventMock}),
  },
}))

// Import AFTER mocks

const {LocalDisplayManager} = require("../LocalDisplayManager")

type Mgr = InstanceType<typeof LocalDisplayManager>

describe("LocalDisplayManager", () => {
  let mgr: Mgr
  let now = 1_000_000

  const advance = (ms: number) => {
    now += ms
    jest.advanceTimersByTime(ms)
  }

  const displayCalls = () =>
    displayEventMock.mock.calls.map(([event]: any[]) => ({
      pkg: (event.layout?.layoutType as string) ?? "?",
      view: event.view,
      layout: event.layout,
      durationMs: event.durationMs,
    }))

  const lastLayoutType = (): string | undefined => {
    const calls = displayEventMock.mock.calls
    if (calls.length === 0) return undefined
    return calls[calls.length - 1][0].layout?.layoutType
  }

  const lastText = (): string | undefined => {
    const calls = displayEventMock.mock.calls
    if (calls.length === 0) return undefined
    return calls[calls.length - 1][0].layout?.text
  }

  beforeEach(() => {
    jest.useFakeTimers()
    displayEventMock.mockClear()
    setDisplayEventMock.mockClear()
    now = 1_000_000
    // Fresh singleton per test.
    mgr = LocalDisplayManager.getInstance()
    mgr._resetForTest()
    mgr._setNowForTest(() => now)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  // ==========================================================================
  // Boot window
  // ==========================================================================

  describe("boot window", () => {
    test("onMount sends 'Starting <name>…' immediately", () => {
      mgr.onMount("com.app.foo", "Foo")
      expect(displayEventMock).toHaveBeenCalledTimes(1)
      expect(lastLayoutType()).toBe("text_wall")
      expect(lastText()).toBe("Starting Foo…")
    })

    test("display requests during boot are queued until timeout", () => {
      mgr.onCoreAppChange("com.app.foo")
      mgr.onMount("com.app.foo", "Foo")
      displayEventMock.mockClear() // drop the boot message

      // A request from a different (non-booting) app during boot — queued.
      mgr.request("com.app.bar", {
        layout: {layoutType: "text_wall", text: "bar"},
      })
      expect(displayEventMock).not.toHaveBeenCalled()

      // Still nothing after 1000ms.
      advance(1000)
      expect(displayEventMock).not.toHaveBeenCalled()

      // Boot timer elapses at 1500ms → drain.
      advance(500)
      // "bar" was queued but core app is com.app.foo (didn't queue). Since bar
      // is NOT core, it would take a bg lock and send.
      expect(displayEventMock).toHaveBeenCalledTimes(1)
      expect(lastText()).toBe("bar")
    })

    test("booting app's own first display ends boot early and renders immediately", () => {
      mgr.onCoreAppChange("com.app.foo")
      mgr.onMount("com.app.foo", "Foo")
      displayEventMock.mockClear()

      mgr.request("com.app.foo", {
        layout: {layoutType: "text_wall", text: "ready"},
      })
      // No advance — should render right away.
      expect(displayEventMock).toHaveBeenCalledTimes(1)
      expect(lastText()).toBe("ready")
      expect(mgr._peekForTest().isBooting).toBe(false)
    })

    test("boot timeout with no queued displays clears the boot text for the core app", () => {
      mgr.onCoreAppChange("com.app.foo")
      mgr.onMount("com.app.foo", "Foo")
      displayEventMock.mockClear()
      advance(1500)
      // Clear sent.
      expect(lastLayoutType()).toBe("clear_view")
    })

    test("mounting a second app cancels the first boot", () => {
      mgr.onCoreAppChange("com.app.foo")
      mgr.onMount("com.app.foo", "Foo")
      mgr.onMount("com.app.bar", "Bar")
      // Second mount kicks off its own boot message.
      expect(lastText()).toBe("Starting Bar…")
      expect(mgr._peekForTest().isBooting).toBe(true)
    })
  })

  // ==========================================================================
  // Throttle
  // ==========================================================================

  describe("throttle", () => {
    beforeEach(() => {
      mgr.onCoreAppChange("com.app.foo")
      mgr.onMount("com.app.foo", "Foo")
      // Consume the boot message so timing is clean.
      mgr.request("com.app.foo", {
        layout: {layoutType: "text_wall", text: "boot-flush"},
      })
      displayEventMock.mockClear()
    })

    test("5 rapid-fire requests → 2 sends (leading + trailing, last wins)", () => {
      // Leading send fires immediately at t=0 (lastSendAt from boot-flush above
      // was set; advance past the throttle window first so this is truly a
      // fresh burst).
      advance(THROTTLE_MS)
      displayEventMock.mockClear()

      for (let i = 0; i < 5; i++) {
        mgr.request("com.app.foo", {
          layout: {layoutType: "text_wall", text: `msg${i}`},
        })
        advance(30)
      }

      // After the burst: leading send of "msg0" happened; msg1..msg4 are pending.
      expect(displayEventMock.mock.calls.length).toBe(1)
      expect(lastText()).toBe("msg0")

      // Flush the trailing timer.
      advance(THROTTLE_MS)
      expect(displayEventMock.mock.calls.length).toBe(2)
      expect(lastText()).toBe("msg4")
    })

    test("later request from same app replaces pending one", () => {
      advance(THROTTLE_MS)
      displayEventMock.mockClear()

      mgr.request("com.app.foo", {
        layout: {layoutType: "text_wall", text: "a"},
      })
      advance(50)
      mgr.request("com.app.foo", {
        layout: {layoutType: "text_wall", text: "b"},
      })
      mgr.request("com.app.foo", {
        layout: {layoutType: "text_wall", text: "c"},
      })
      // Leading send: "a"
      expect(lastText()).toBe("a")
      // Trailing flush: "c" wins.
      advance(THROTTLE_MS)
      expect(lastText()).toBe("c")
    })
  })

  // ==========================================================================
  // Duration expiry
  // ==========================================================================

  describe("durationMs expiry", () => {
    beforeEach(() => {
      mgr.onCoreAppChange("com.app.foo")
      mgr.onMount("com.app.foo", "Foo")
    })

    test("display clears when durationMs elapses", () => {
      mgr.request("com.app.foo", {
        layout: {layoutType: "text_wall", text: "hi"},
        durationMs: 500,
      })
      displayEventMock.mockClear()
      advance(500)
      expect(lastLayoutType()).toBe("clear_view")
    })

    test("new request before expiry cancels the clear", () => {
      mgr.request("com.app.foo", {
        layout: {layoutType: "text_wall", text: "hi"},
        durationMs: 500,
      })
      advance(200)
      advance(THROTTLE_MS) // make sure throttle is clear
      mgr.request("com.app.foo", {
        layout: {layoutType: "text_wall", text: "hi2"},
      })
      displayEventMock.mockClear()
      advance(1000)
      // No clear_view should have been triggered.
      const hasClear = displayEventMock.mock.calls.some(([e]: any[]) => e.layout?.layoutType === "clear_view")
      expect(hasClear).toBe(false)
    })
  })

  // ==========================================================================
  // Core vs background arbitration
  // ==========================================================================

  describe("core vs background arbitration", () => {
    beforeEach(() => {
      mgr.onCoreAppChange("com.app.core")
      mgr.onMount("com.app.core", "Core")
      // Drain boot
      advance(1500)
      displayEventMock.mockClear()
    })

    test("background app acquires lock when core isn't displaying", () => {
      advance(THROTTLE_MS)
      mgr.request("com.app.bg1", {
        layout: {layoutType: "text_wall", text: "bg1"},
      })
      expect(lastText()).toBe("bg1")
      expect(mgr._peekForTest().bgLockPkg).toBe("com.app.bg1")
    })

    test("second background app is blocked while first holds lock and displays", () => {
      advance(THROTTLE_MS)
      mgr.request("com.app.bg1", {
        layout: {layoutType: "text_wall", text: "bg1"},
      })
      displayEventMock.mockClear()
      advance(THROTTLE_MS)
      mgr.request("com.app.bg2", {
        layout: {layoutType: "text_wall", text: "bg2"},
      })
      expect(displayEventMock).not.toHaveBeenCalled()
    })

    test("core app is blocked while bg lock-holder is actively on the glasses", () => {
      advance(THROTTLE_MS)
      mgr.request("com.app.bg1", {
        layout: {layoutType: "text_wall", text: "bg1"},
      })
      displayEventMock.mockClear()
      advance(THROTTLE_MS)

      // Core tries to render — blocked.
      mgr.request("com.app.core", {
        layout: {layoutType: "text_wall", text: "core-wants"},
      })
      expect(displayEventMock).not.toHaveBeenCalled()
    })

    test("when bg holder's display expires, core's saved display is restored", () => {
      // Core sets a long-lived display, then bg preempts with short duration.
      advance(THROTTLE_MS)
      mgr.request("com.app.core", {
        layout: {layoutType: "text_wall", text: "core-saved"},
        durationMs: 10_000,
      })
      displayEventMock.mockClear()

      advance(THROTTLE_MS)
      mgr.request("com.app.bg1", {
        layout: {layoutType: "text_wall", text: "bg1"},
        durationMs: 200,
      })
      // Core was blocked; bg is on glasses.
      expect(lastText()).toBe("bg1")
      displayEventMock.mockClear()

      // Bg expires → core restored.
      advance(200)
      expect(lastText()).toBe("core-saved")
    })

    test("unmounting the lock holder releases the lock and restores core", () => {
      advance(THROTTLE_MS)
      mgr.request("com.app.core", {
        layout: {layoutType: "text_wall", text: "core-saved"},
        durationMs: 10_000,
      })
      advance(THROTTLE_MS)
      mgr.request("com.app.bg1", {
        layout: {layoutType: "text_wall", text: "bg1"},
      })
      displayEventMock.mockClear()

      mgr.onUnmount("com.app.bg1")
      // Lock released, core restored.
      expect(mgr._peekForTest().bgLockPkg).toBeNull()
      expect(lastText()).toBe("core-saved")
    })
  })

  // ==========================================================================
  // Foreground flip
  // ==========================================================================

  describe("onCoreAppChange", () => {
    test("flipping core drops pending throttled request from previous core", () => {
      mgr.onCoreAppChange("com.app.a")
      mgr.onMount("com.app.a", "A")
      advance(1500)
      advance(THROTTLE_MS)
      displayEventMock.mockClear()

      // Start a burst to create a pending trailing send for com.app.a
      mgr.request("com.app.a", {layout: {layoutType: "text_wall", text: "a1"}})
      mgr.request("com.app.a", {layout: {layoutType: "text_wall", text: "a2"}})
      // Leading "a1" has fired; "a2" is pending.
      expect(lastText()).toBe("a1")

      // Core flips to a different app.
      mgr.onCoreAppChange("com.app.b")

      // Trailing timer fires — should NOT send "a2" because a is no longer core.
      displayEventMock.mockClear()
      advance(THROTTLE_MS)
      expect(displayEventMock).not.toHaveBeenCalled()
    })
  })
})

// Keep in sync with THROTTLE_MS in LocalDisplayManager.ts.
const THROTTLE_MS = 300
