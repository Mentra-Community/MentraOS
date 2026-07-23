/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, jest, mock, test} from "bun:test"

/**
 * Unit tests for LocalDisplayManager.
 *
 * Covers boot window, pass-through (pacing now lives in the native per-device
 * queue, not here), durationMs expiry, and core-vs-background arbitration.
 * Uses jest fake timers + an injected clock.
 */

const displayEventMock = mock(() => {})

// DisplayProcessor: pass through unchanged so we can assert on the raw event.
mock.module("../DisplayProcessor", () => ({
  __esModule: true,
  default: {
    processDisplayEvent: (e: Record<string, unknown>) => ({...e, _processed: true}),
  },
}))

mock.module("@mentra/bluetooth-sdk/internal", () => ({
  __esModule: true,
  default: {
    displayEvent: displayEventMock,
  },
}))

// The store ports (SceneRenderer reads settings/glasses; attachToRuntime
// subscribes to the glasses store) pull native modules bun can't parse —
// stub the stores like the PhonePhotoCoordinator suite does.
mock.module("../../stores/settings", () => ({
  SETTINGS: {default_wearable: {key: "default_wearable"}},
  useSettingsStore: {
    // No device model: keeps these suites on the legacy (non-scene) path, the
    // same effective condition they ran under on dev (unset runtime hooks).
    getState: () => ({getSetting: () => undefined}),
  },
}))
mock.module("../../stores/glasses", () => ({
  useGlassesStore: {
    getState: () => ({connection: {state: "connected", fullyBooted: true}, deviceModel: undefined}),
    subscribe: () => () => {},
  },
}))
mock.module("../GlassesReadiness", () => ({
  isGlassesConnected: (connection: {state?: string} | undefined) => connection?.state === "connected",
}))

mock.module("../../utils/timers", () => ({
  BgTimer: {
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay) as unknown as number,
    clearTimeout: (timeoutId: number) => clearTimeout(timeoutId),
    setInterval: (callback: () => void, delay: number) => setInterval(callback, delay) as unknown as number,
    clearInterval: (intervalId: number) => clearInterval(intervalId),
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

    // Production wires onMount (from LocalMiniappRuntime.registerApp) but NOT
    // onCoreAppChange, so coreApp is null. The boot text must still clear on
    // timeout, or a miniapp that never renders would strand "Starting …".
    test("boot timeout clears the boot text even when no core app is wired", () => {
      mgr.onMount("com.app.foo", "Foo")
      expect(lastText()).toBe("Starting Foo…")
      displayEventMock.mockClear()
      advance(1500)
      expect(lastLayoutType()).toBe("clear_view")
    })

    // The common case: a single foreground display app, onMount only. The boot
    // message shows, then the app's first render replaces it — no core wiring
    // needed.
    test("booting app's first display replaces the boot text with no core app wired", () => {
      mgr.onMount("com.app.foo", "Foo")
      expect(lastText()).toBe("Starting Foo…")
      mgr.request("com.app.foo", {layout: {layoutType: "text_wall", text: "ready"}})
      expect(lastText()).toBe("ready")
      expect(mgr._peekForTest().isBooting).toBe(false)
    })

    // registerApp fires onMount for EVERY spawn (background app, crash-respawn),
    // so a second app's boot must not blank whatever the first app is showing.
    // On timeout with nothing rendered, the prior frame is restored, not cleared.
    test("a second app's boot that times out restores the prior frame, not a blank", () => {
      // App A renders content (its own boot ends early on first display).
      mgr.onMount("com.app.a", "A")
      mgr.request("com.app.a", {layout: {layoutType: "text_wall", text: "A-content"}})
      expect(lastText()).toBe("A-content")

      // App B spawns and never renders.
      mgr.onMount("com.app.b", "B")
      expect(lastText()).toBe("Starting B…")
      displayEventMock.mockClear()

      advance(1500)
      // B never rendered → A's frame restored, glasses not blanked.
      expect(lastLayoutType()).not.toBe("clear_view")
      expect(lastText()).toBe("A-content")
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
  // Pass-through (no JS-side throttle)
  // ==========================================================================
  //
  // Display pacing + last-wins coalescing now live in the native per-device
  // queue (e.g. G2's event-driven EvenHub queue), not here — a JS throttle could
  // not flush on schedule while the iOS app was suspended, so updates bursted on
  // the next wake. This class forwards every request straight through.

  describe("pass-through", () => {
    beforeEach(() => {
      mgr.onCoreAppChange("com.app.foo")
      mgr.onMount("com.app.foo", "Foo")
      // Consume the boot message so counts are clean.
      mgr.request("com.app.foo", {
        layout: {layoutType: "text_wall", text: "boot-flush"},
      })
      displayEventMock.mockClear()
    })

    test("5 rapid-fire requests → 5 sends, no time advance, in order", () => {
      for (let i = 0; i < 5; i++) {
        mgr.request("com.app.foo", {
          layout: {layoutType: "text_wall", text: `msg${i}`},
        })
      }

      // Every request forwarded immediately — no throttle, no coalescing here.
      expect(displayEventMock.mock.calls.length).toBe(5)
      expect(lastText()).toBe("msg4")

      // Nothing deferred to a trailing timer.
      advance(THROTTLE_MS)
      expect(displayEventMock.mock.calls.length).toBe(5)
    })

    test("each request renders immediately without waiting for a window", () => {
      mgr.request("com.app.foo", {
        layout: {layoutType: "text_wall", text: "a"},
      })
      expect(lastText()).toBe("a")
      mgr.request("com.app.foo", {
        layout: {layoutType: "text_wall", text: "b"},
      })
      expect(lastText()).toBe("b")
      mgr.request("com.app.foo", {
        layout: {layoutType: "text_wall", text: "c"},
      })
      expect(lastText()).toBe("c")
      expect(displayEventMock.mock.calls.length).toBe(3)
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

    test("dismissing a temporary background display restores core", () => {
      mgr.request("com.app.core", {
        layout: {layoutType: "text_wall", text: "core-saved"},
      })
      mgr.request("cloud.augmentos.notify", {
        layout: {layoutType: "reference_card", title: "Messages", text: "Hello"},
        durationMs: 5_000,
      })
      expect(lastLayoutType()).toBe("reference_card")
      displayEventMock.mockClear()

      mgr.dismiss("cloud.augmentos.notify")

      expect(mgr._peekForTest().bgLockPkg).toBeNull()
      expect(lastText()).toBe("core-saved")
    })
  })

  // ==========================================================================
  // Foreground flip
  // ==========================================================================

  describe("onCoreAppChange", () => {
    test("flipping core to null drops the saved core display", () => {
      mgr.onCoreAppChange("com.app.a")
      mgr.onMount("com.app.a", "A")
      advance(1500)
      displayEventMock.mockClear()

      mgr.request("com.app.a", {
        layout: {layoutType: "text_wall", text: "a1"},
        durationMs: 10_000,
      })
      expect(lastText()).toBe("a1")

      // Core goes away → saved frame is dropped so it can't flicker back later.
      mgr.onCoreAppChange(null)
      expect(mgr._peekForTest().coreApp).toBeNull()

      // A bg app can now take the screen; the old core frame is not restored
      // when that bg app later unmounts.
      mgr.request("com.app.bg", {layout: {layoutType: "text_wall", text: "bg"}})
      expect(lastText()).toBe("bg")
      displayEventMock.mockClear()
      mgr.onUnmount("com.app.bg")
      const restoredOldCore = displayEventMock.mock.calls.some(
        ([e]: any[]) => e.layout?.text === "a1",
      )
      expect(restoredOldCore).toBe(false)
    })
  })

  // ==========================================================================
  // Boot-strand and clear-forfeit regressions (bug hunt 2026-07-22)
  // ==========================================================================

  describe("boot-strand and clear-forfeit regressions", () => {
    test("chained boots never restore a stale 'Starting…' frame", () => {
      mgr.onCoreAppChange("com.app.core")
      mgr.request("com.app.core", {layout: {layoutType: "text_wall", text: "core content"}})

      // Back-to-back mounts (autostart restore): the second boot starts while
      // the first's "Starting A…" is still on the glasses.
      mgr.onMount("com.app.a", "A")
      mgr.onMount("com.app.b", "B")

      // Neither app renders; the boot window times out.
      advance(1500)

      // Must restore the ORIGINAL pre-boot frame — not "Starting A…".
      expect(lastText()).toBe("core content")
    })

    test("boot text clears when the glasses were empty and the app never renders", () => {
      mgr.onMount("com.app.a", "A")
      mgr.onMount("com.app.b", "B")
      advance(1500)
      expect(lastLayoutType()).toBe("clear_view")
    })

    test("unmounting the booting app does not strand its boot text", () => {
      mgr.onCoreAppChange("com.app.core")
      mgr.request("com.app.core", {layout: {layoutType: "text_wall", text: "core content"}})

      mgr.onMount("com.app.a", "A")
      expect(lastText()).toBe("Starting A…")

      mgr.onUnmount("com.app.a")
      expect(lastText()).toBe("core content")
    })

    test("a background app's clear forfeits the lock and restores the core display", () => {
      mgr.onCoreAppChange("com.app.core")
      mgr.request("com.app.core", {layout: {layoutType: "text_wall", text: "core content"}})

      mgr.request("com.app.bg", {layout: {layoutType: "text_wall", text: "bg overlay"}})
      expect(lastText()).toBe("bg overlay")

      // Clear = "I'm done": core comes back and the lock is free immediately.
      mgr.request("com.app.bg", {layout: {layoutType: "clear_view"}})
      expect(lastText()).toBe("core content")

      mgr.request("com.app.bg2", {layout: {layoutType: "text_wall", text: "bg2 overlay"}})
      expect(lastText()).toBe("bg2 overlay")
    })

    test("an empty scene render (render([])) is a forfeit too", () => {
      mgr.onCoreAppChange("com.app.core")
      mgr.request("com.app.core", {layout: {layoutType: "text_wall", text: "core content"}})

      mgr.request("com.app.bg", {layout: {layoutType: "text_wall", text: "bg overlay"}})
      expect(lastText()).toBe("bg overlay")

      mgr.request("com.app.bg", {view: "main", scene: []})
      expect(lastText()).toBe("core content")
    })

    test("a context teardown (respawn) does not release the core claim", () => {
      // The coreApp pointer is derived from the apps store; a liveness/crash
      // respawn tears the context down with NO store change (the app is
      // still "running"), so the claim must survive the unmount. Only the
      // saved frame is dropped (it belongs to the dead context).
      mgr.onCoreAppChange("com.app.core")
      mgr.request("com.app.core", {layout: {layoutType: "text_wall", text: "core content"}, durationMs: 10_000})

      mgr.onUnmount("com.app.core")
      expect(mgr._peekForTest().coreApp).toBe("com.app.core")

      // The respawned context's first render must arbitrate as CORE: a bg
      // overlay that then expires restores it.
      mgr.onMount("com.app.core", "Core")
      advance(1500)
      mgr.request("com.app.core", {layout: {layoutType: "text_wall", text: "respawned"}, durationMs: 10_000})
      mgr.request("com.app.bg", {layout: {layoutType: "text_wall", text: "bg overlay"}, durationMs: 1000})
      advance(1000)
      expect(lastText()).toBe("respawned")
    })

    test("a clear queued during boot forfeits the pre-boot frame (no resurrection)", () => {
      mgr.onCoreAppChange("com.app.core")
      mgr.request("com.app.core", {layout: {layoutType: "text_wall", text: "core content"}})

      // An app boots; while its "Starting…" is up, the core CLEARS. The clear
      // parks in the boot queue; endBoot must not restore the forfeited frame.
      mgr.onMount("com.app.b", "B")
      mgr.request("com.app.core", {layout: {layoutType: "clear_view"}})
      advance(1500)

      expect(lastLayoutType()).toBe("clear_view")
    })

    test("a clear queued during boot also blocks the unmount-mid-boot restore", () => {
      mgr.onCoreAppChange("com.app.core")
      mgr.request("com.app.core", {layout: {layoutType: "text_wall", text: "core content"}})

      mgr.onMount("com.app.b", "B")
      mgr.request("com.app.core", {layout: {layoutType: "clear_view"}})
      mgr.onUnmount("com.app.b")

      expect(lastLayoutType()).toBe("clear_view")
    })

    test("the core app's own clear forgets its snapshot so it cannot resurrect", () => {
      mgr.onCoreAppChange("com.app.core")
      mgr.request("com.app.core", {layout: {layoutType: "text_wall", text: "core content"}})

      mgr.request("com.app.core", {layout: {layoutType: "clear_view"}})
      expect(lastLayoutType()).toBe("clear_view")

      // A bg overlay that later expires must NOT bring the cleared frame back.
      mgr.request("com.app.bg", {layout: {layoutType: "text_wall", text: "bg overlay"}, durationMs: 1000})
      expect(lastText()).toBe("bg overlay")
      advance(1000)
      expect(lastLayoutType()).toBe("clear_view")
    })
  })
})

// Generic "let some time pass" amount for arbitration/expiry tests. The JS
// throttle this once mirrored is gone; pacing now lives in the native queue.
const THROTTLE_MS = 300
