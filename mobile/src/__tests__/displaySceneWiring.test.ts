/**
 * Scene wiring integration tests — LocalDisplayManager + SceneRenderer against
 * the island stores + mocked Bluetooth SDK (dev wrote these against the
 * since-removed runtime hooks; island reads its own stores and sends via
 * BluetoothSdk.displayEvent directly). Locks the contract the SDK's render()
 * relies on: exactly-once resolvers (displayed/blocked), legacy sugar→scene
 * conversion on positioning devices, degrade routing on non-positioning
 * devices, and restore/replay emitting create-based frames.
 */

const mockSentEvents: Record<string, unknown>[] = []

jest.mock("../../modules/engine/src/utils/timers", () => ({
  BgTimer: {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
  },
}))

import localDisplayManager from "../../modules/engine/src/services/LocalDisplayManager"
import type {DisplayRequestResult} from "../../modules/engine/src/services/LocalDisplayManager"
import {useGlassesStore} from "../../modules/engine/src/stores/glasses"
import {useSettingsStore, SETTINGS} from "../../modules/engine/src/stores/settings"
import {bluetoothSdkMock} from "../test-utils/mockBluetoothSdk"
import {flushDisplayCoalesceForTests, useDisplayStore} from "@mentra/engine-host-internal"

function setDeviceModel(model: string) {
  useSettingsStore.getState().setSetting(SETTINGS.default_wearable.key, model, false)
}

function setGlassesConnected(connected: boolean) {
  useGlassesStore
    .getState()
    .setGlassesInfo({connection: connected ? {state: "connected", fullyBooted: true} : {state: "disconnected"}})
}

function lastScene(): Record<string, unknown> {
  const withScene = mockSentEvents.filter((e) => e.scene)
  return (withScene[withScene.length - 1]?.scene ?? {}) as Record<string, unknown>
}

beforeEach(() => {
  jest.useFakeTimers()
  mockSentEvents.length = 0
  ;(bluetoothSdkMock.displayEvent as jest.Mock).mockImplementation((event: Record<string, unknown>) => {
    mockSentEvents.push(event)
    return Promise.resolve()
  })
  setDeviceModel("Even Realities G2")
  setGlassesConnected(true)
  localDisplayManager._resetForTest()
  useDisplayStore.setState({
    currentEvent: {},
    dashboardEvent: {},
    mainEvent: {},
    view: "main",
  })
})

afterEach(() => {
  localDisplayManager._resetForTest()
  jest.useRealTimers()
})

describe("scene requests through arbitration", () => {
  it("sends a SceneFrame and resolves displayed", () => {
    let result: DisplayRequestResult | undefined
    localDisplayManager.request(
      "com.app.a",
      {view: "main", scene: [{type: "text", id: "t", box: {x: 0, y: 0, w: 100, h: 40}, text: "hi"}]},
      (r) => (result = r),
    )
    expect(result).toEqual({status: "displayed", degraded: false, dropped: []})
    const scene = lastScene()
    expect(scene.appId).toBe("com.app.a")
    expect((scene.elements as unknown[]).length).toBe(1)
  })

  it("publishes the full positioned scene to the glasses mirror store", () => {
    localDisplayManager.request("com.app.a", {
      view: "main",
      scene: [
        {type: "text", id: "title", box: {x: 12, y: 20, w: 300, h: 50}, text: "mirror me"},
        {type: "rect", id: "outline", box: {x: 0, y: 0, w: 576, h: 288}, style: {border: 2}},
      ],
    })
    flushDisplayCoalesceForTests()

    const event = useDisplayStore.getState().currentEvent
    expect(event.view).toBe("main")
    expect(event.layout).toMatchObject({
      layoutType: "scene",
      width: 576,
      height: 288,
    })
    expect(event.layout.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({id: "title", type: "text", text: "mirror me"}),
        expect.objectContaining({id: "outline", type: "rect"}),
      ]),
    )
  })

  it("reports degraded + dropped for over-budget scenes", () => {
    let result: DisplayRequestResult | undefined
    const els = Array.from({length: 8}, (_, i) => ({
      type: "text" as const,
      id: `t${i}`,
      box: {x: 0, y: i * 30, w: 100, h: 25},
      text: `line${i}`,
    }))
    localDisplayManager.request("com.app.a", {view: "main", scene: els}, (r) => (result = r))
    expect(result?.status).toBe("displayed")
    expect(result?.degraded).toBe(true)
    expect(result?.dropped).toEqual(["t6", "t7"])
  })

  it("blocks a second background app while another holds the lock", () => {
    localDisplayManager.request("com.app.a", {
      view: "main",
      scene: [{type: "text", id: "t", box: {x: 0, y: 0, w: 100, h: 40}, text: "a"}],
    })
    let result: DisplayRequestResult | undefined
    localDisplayManager.request(
      "com.app.b",
      {view: "main", scene: [{type: "text", id: "t", box: {x: 0, y: 0, w: 100, h: 40}, text: "b"}]},
      (r) => (result = r),
    )
    expect(result?.status).toBe("blocked")
    expect(result?.reason).toContain("background app")
  })

  it("converts legacy sugar layouts to scenes on positioning devices", () => {
    localDisplayManager.request("com.app.a", {
      view: "main",
      layout: {layoutType: "text_wall", text: "caption line"},
    })
    const scene = lastScene()
    const els = scene.elements as {id: string; type: string; box: {w: number; h: number}; text?: string}[]
    expect(els).toHaveLength(1)
    expect(els[0].type).toBe("text")
    expect(els[0].id).toBe("sugar:wall")
    // Full G2 canvas (576×288 from the capability file).
    expect(els[0].box.w).toBe(576)
    expect(els[0].box.h).toBe(288)
  })

  it("stable sugar ids diff as content updates, not recreates", () => {
    localDisplayManager.request("com.app.a", {view: "main", layout: {layoutType: "text_wall", text: "one"}})
    localDisplayManager.request("com.app.a", {view: "main", layout: {layoutType: "text_wall", text: "two"}})
    const els = lastScene().elements as {change: string}[]
    expect(els[0].change).toBe("updated")
  })

  it("degrades scenes to legacy layouts on non-positioning devices (G1)", () => {
    setDeviceModel("Even Realities G1")
    let result: DisplayRequestResult | undefined
    localDisplayManager.request(
      "com.app.a",
      {
        view: "main",
        scene: [
          {type: "text", id: "t", box: {x: 0, y: 0, w: 500, h: 100}, text: "hello"},
          {type: "image", id: "map", box: {x: 0, y: 100, w: 100, h: 100}, data: "AAAA"},
        ],
      },
      (r) => (result = r),
    )
    // Image dropped + reported (G1 renders no images); text rides the legacy path.
    expect(result).toEqual({status: "displayed", degraded: true, dropped: ["map"]})
    const legacy = mockSentEvents.filter((e) => !e.scene)
    const layout = (legacy[legacy.length - 1] as {layout?: {layoutType?: string; text?: string}}).layout
    expect(layout?.layoutType).toBe("text_wall")
    expect(layout?.text).toContain("hello")
  })

  it("replays the current scene create-based after a reconnect", () => {
    localDisplayManager.attachToRuntime()
    localDisplayManager.request("com.app.a", {
      view: "main",
      scene: [{type: "text", id: "t", box: {x: 0, y: 0, w: 100, h: 40}, text: "hi"}],
    })
    const before = mockSentEvents.length

    setGlassesConnected(false)
    setGlassesConnected(true)

    expect(mockSentEvents.length).toBeGreaterThan(before)
    const replay = lastScene()
    expect(replay.replay).toBe(true)
    expect((replay.elements as {change: string}[]).every((e) => e.change === "created")).toBe(true)
  })

  it("restores the core app's scene when a background app's duration expires", () => {
    localDisplayManager.onCoreAppChange("com.app.core")
    localDisplayManager.request("com.app.core", {
      view: "main",
      scene: [{type: "text", id: "core", box: {x: 0, y: 0, w: 100, h: 40}, text: "core content"}],
    })
    localDisplayManager.request("com.app.bg", {
      view: "main",
      durationMs: 1000,
      scene: [{type: "text", id: "bg", box: {x: 0, y: 0, w: 100, h: 40}, text: "toast"}],
    })
    const before = mockSentEvents.length

    jest.advanceTimersByTime(1500)

    expect(mockSentEvents.length).toBeGreaterThan(before)
    const restored = lastScene()
    expect(restored.appId).toBe("com.app.core")
    expect(restored.replay).toBe(true)
  })

  it.each(["NIMO", "Even Realities G2"])(
    "restores the latest blocked core scene after a notification expires on %s",
    (model) => {
      setDeviceModel(model)
      localDisplayManager.onCoreAppChange("com.app.core")
      localDisplayManager.request("com.app.core", {
        view: "main",
        scene: [{type: "text", id: "core", box: {x: 0, y: 0, w: 300, h: 40}, text: "core A"}],
      })
      const initialEpoch = lastScene().sceneEpoch as number

      localDisplayManager.request("com.app.notify", {
        view: "main",
        durationMs: 5000,
        layout: {layoutType: "reference_card", title: "Notify", text: "notification"},
      })
      expect(lastScene().appId).toBe("com.app.notify")
      const beforeExpiry = mockSentEvents.length
      const resolve = jest.fn()

      for (const text of ["core B", "core C"]) {
        localDisplayManager.request(
          "com.app.core",
          {view: "main", scene: [{type: "text", id: "core", box: {x: 0, y: 0, w: 300, h: 40}, text}]},
          resolve,
        )
      }
      expect(resolve.mock.calls).toEqual([
        [{status: "blocked", reason: "a background app holds the display"}],
        [{status: "blocked", reason: "a background app holds the display"}],
      ])
      expect(mockSentEvents).toHaveLength(beforeExpiry)

      jest.advanceTimersByTime(4999)
      expect(mockSentEvents).toHaveLength(beforeExpiry)
      jest.advanceTimersByTime(1)

      expect(mockSentEvents).toHaveLength(beforeExpiry + 1)
      expect(resolve).toHaveBeenCalledTimes(2)
      const restored = lastScene()
      expect(restored.appId).toBe("com.app.core")
      expect(restored.replay).toBe(true)
      expect(restored.sceneEpoch).toBeGreaterThan(initialEpoch)
      expect(restored.elements).toEqual([
        expect.objectContaining({id: "core", type: "text", text: "core C", change: "created"}),
      ])
    },
  )

  it.each(["NIMO", "Even Realities G1"])(
    "restores the latest blocked core legacy layout after a notification expires on %s",
    (model) => {
      setDeviceModel(model)
      localDisplayManager.onCoreAppChange("com.app.core")
      localDisplayManager.request("com.app.core", {
        view: "main",
        layout: {layoutType: "text_wall", text: "core A"},
      })
      const initialEpoch = lastScene().sceneEpoch as number
      localDisplayManager.request("com.app.notify", {
        view: "main",
        durationMs: 5000,
        layout: {layoutType: "reference_card", title: "Notify", text: "notification"},
      })
      const beforeExpiry = mockSentEvents.length
      const resolve = jest.fn()
      localDisplayManager.request(
        "com.app.core",
        {view: "main", layout: {layoutType: "text_wall", text: "core B"}},
        resolve,
      )
      expect(resolve).toHaveBeenCalledWith({status: "blocked", reason: "a background app holds the display"})
      expect(mockSentEvents).toHaveLength(beforeExpiry)
      jest.advanceTimersByTime(4999)
      expect(mockSentEvents).toHaveLength(beforeExpiry)
      jest.advanceTimersByTime(1)

      expect(mockSentEvents).toHaveLength(beforeExpiry + 1)
      expect(resolve).toHaveBeenCalledTimes(1)
      if (model === "NIMO") {
        expect(mockSentEvents[mockSentEvents.length - 1]).toMatchObject({
          view: "main",
          scene: {appId: "com.app.core", replay: true},
        })
        const restored = lastScene()
        expect(restored.sceneEpoch).toBeGreaterThan(initialEpoch)
        expect(restored.elements).toEqual([
          expect.objectContaining({id: "sugar:wall", type: "text", text: "core B", change: "created"}),
        ])
      } else {
        expect(mockSentEvents[mockSentEvents.length - 1]).toMatchObject({
          view: "main",
          layout: {layoutType: "text_wall", text: "core B"},
        })
      }
    },
  )

  describe("pending core display lifecycle", () => {
    function requestCore(text: string, durationMs?: number) {
      localDisplayManager.request("com.app.core", {
        view: "main",
        durationMs,
        scene: [{type: "text", id: "core", box: {x: 0, y: 0, w: 300, h: 40}, text}],
      })
    }

    function coverCore(model = "NIMO") {
      setDeviceModel(model)
      localDisplayManager.onCoreAppChange("com.app.core")
      requestCore("core A")
      localDisplayManager.request("com.app.notify", {
        view: "main",
        durationMs: 5000,
        layout: {layoutType: "reference_card", title: "Notify", text: "notification"},
      })
    }

    it.each(["dismiss", "unmount", "clear"])("restores the pending scene when the notification ends by %s", (end) => {
      coverCore()
      requestCore("core B")
      jest.advanceTimersByTime(1000)
      const beforeRelease = mockSentEvents.length
      if (end === "dismiss") localDisplayManager.dismiss("com.app.notify")
      else if (end === "unmount") localDisplayManager.onUnmount("com.app.notify")
      else localDisplayManager.request("com.app.notify", {view: "main", scene: []})

      expect(mockSentEvents).toHaveLength(beforeRelease + 1)
      expect(lastScene()).toMatchObject({
        appId: "com.app.core",
        replay: true,
        elements: [expect.objectContaining({id: "core", text: "core B", change: "created"})],
      })
      jest.advanceTimersByTime(4000)
      expect(mockSentEvents).toHaveLength(beforeRelease + 1)
    })

    it.each(["clear", "unmount", "deselect"])("does not resurrect a pending scene after core %s", (end) => {
      coverCore()
      requestCore("core B")
      const beforeForfeit = mockSentEvents.length
      if (end === "clear") localDisplayManager.request("com.app.core", {view: "main", scene: []})
      else if (end === "unmount") localDisplayManager.onUnmount("com.app.core")
      else localDisplayManager.onCoreAppChange(null)

      expect(mockSentEvents).toHaveLength(beforeForfeit)
      jest.advanceTimersByTime(5000)
      expect(mockSentEvents).toHaveLength(beforeForfeit + 1)
      expect(mockSentEvents[mockSentEvents.length - 1]).toMatchObject({layout: {layoutType: "clear_view"}})
    })

    it("restores a pending scene only until its original deadline", () => {
      coverCore()
      jest.advanceTimersByTime(1000)
      requestCore("core B", 6000)
      jest.advanceTimersByTime(4000)
      expect(lastScene()).toMatchObject({
        appId: "com.app.core",
        replay: true,
        elements: [expect.objectContaining({text: "core B", change: "created"})],
      })
      const afterRestore = mockSentEvents.length
      jest.advanceTimersByTime(1999)
      expect(mockSentEvents).toHaveLength(afterRestore)
      jest.advanceTimersByTime(1)
      expect(mockSentEvents).toHaveLength(afterRestore + 1)
      expect(mockSentEvents[mockSentEvents.length - 1]).toMatchObject({layout: {layoutType: "clear_view"}})
    })

    it("does not restore a pending scene whose deadline elapsed under the notification", () => {
      coverCore()
      jest.advanceTimersByTime(1000)
      requestCore("core B", 2000)
      const beforeExpiry = mockSentEvents.length
      jest.advanceTimersByTime(4000)
      expect(mockSentEvents).toHaveLength(beforeExpiry + 1)
      expect(mockSentEvents[mockSentEvents.length - 1]).toMatchObject({layout: {layoutType: "clear_view"}})
    })

    it("does not make a pending display unlimited when its deadline passes during restore", () => {
      coverCore()
      requestCore("core B", 1000)
      const deadline = Date.now() + 1000
      let clockReads = 0
      localDisplayManager._setNowForTest(() => (clockReads++ === 0 ? deadline - 1 : deadline))
      const beforeRelease = mockSentEvents.length

      localDisplayManager.dismiss("com.app.notify")
      jest.advanceTimersByTime(6000)

      expect(localDisplayManager.getDiagnosticSnapshot().currentDisplayPackageName).toBeNull()
      expect(mockSentEvents.slice(beforeRelease)).toEqual([
        expect.objectContaining({layout: {layoutType: "clear_view"}}),
      ])
    })

    it.each([2000, 6000])("preserves the original %i ms pending legacy deadline on G1", (durationMs) => {
      coverCore("Even Realities G1")
      jest.advanceTimersByTime(1000)
      localDisplayManager.request("com.app.core", {
        view: "main",
        layout: {layoutType: "text_wall", text: "core B"},
        durationMs,
      })
      const beforeExpiry = mockSentEvents.length
      jest.advanceTimersByTime(4000)
      expect(mockSentEvents).toHaveLength(beforeExpiry + 1)

      if (durationMs > 4000) {
        expect(mockSentEvents[mockSentEvents.length - 1]).toMatchObject({
          layout: {layoutType: "text_wall", text: "core B"},
          durationMs: 2000,
        })
        jest.advanceTimersByTime(1999)
        expect(mockSentEvents).toHaveLength(beforeExpiry + 1)
        jest.advanceTimersByTime(1)
        expect(mockSentEvents).toHaveLength(beforeExpiry + 2)
      }
      expect(mockSentEvents[mockSentEvents.length - 1]).toMatchObject({layout: {layoutType: "clear_view"}})
      expect(localDisplayManager.getDiagnosticSnapshot().currentDisplayPackageName).toBeNull()
    })

    it("replays the ordinary scene sent after a pending restore when a second notification ends", () => {
      coverCore()
      requestCore("core B")
      localDisplayManager.dismiss("com.app.notify")
      expect(lastScene().elements).toEqual([expect.objectContaining({text: "core B", change: "created"})])
      const restoredEpoch = lastScene().sceneEpoch as number

      requestCore("core C")
      expect(lastScene().sceneEpoch).toBe(restoredEpoch)
      expect(lastScene().replay).toBeUndefined()
      expect(lastScene().elements).toEqual([expect.objectContaining({text: "core C", change: "updated"})])
      localDisplayManager.request("com.app.notify", {
        view: "main",
        durationMs: 5000,
        layout: {layoutType: "reference_card", title: "Notify", text: "second notification"},
      })
      const beforeRelease = mockSentEvents.length
      localDisplayManager.dismiss("com.app.notify")

      expect(mockSentEvents).toHaveLength(beforeRelease + 1)
      expect(lastScene()).toMatchObject({
        appId: "com.app.core",
        replay: true,
        elements: [expect.objectContaining({text: "core C", change: "created"})],
      })
      expect(lastScene().sceneEpoch).toBeGreaterThan(restoredEpoch)
    })

    it("degrades the pending scene when the selected device becomes non-positioning", () => {
      coverCore()
      requestCore("core B")
      setDeviceModel("Even Realities G1")
      const beforeExpiry = mockSentEvents.length
      jest.advanceTimersByTime(5000)
      expect(mockSentEvents).toHaveLength(beforeExpiry + 1)
      expect(mockSentEvents[mockSentEvents.length - 1]).toMatchObject({
        view: "main",
        layout: {layoutType: "text_wall", text: "core B"},
      })
    })

    it("leaves the display blank when a pending all-image scene degrades to empty on G1", () => {
      coverCore()
      localDisplayManager.request("com.app.core", {
        view: "main",
        scene: [{type: "image", id: "image", box: {x: 0, y: 0, w: 100, h: 100}, data: "AAAA"}],
      })
      setDeviceModel("Even Realities G1")
      const beforeRelease = mockSentEvents.length
      localDisplayManager.dismiss("com.app.notify")

      expect(mockSentEvents.length).toBeGreaterThan(beforeRelease)
      expect(mockSentEvents.slice(beforeRelease).every((event) => !event.scene)).toBe(true)
      expect(mockSentEvents[mockSentEvents.length - 1]).toMatchObject({layout: {layoutType: "clear_view"}})
      expect(localDisplayManager.getDiagnosticSnapshot().currentDisplayPackageName).toBeNull()
    })

    it("keeps the pending scene available after a no-display restore attempt", () => {
      coverCore()
      requestCore("core B")
      setDeviceModel("Mentra Live")
      localDisplayManager.dismiss("com.app.notify")
      expect(localDisplayManager.getDiagnosticSnapshot().currentDisplayPackageName).toBeNull()
      expect(mockSentEvents[mockSentEvents.length - 1]).toMatchObject({layout: {layoutType: "clear_view"}})

      setDeviceModel("NIMO")
      localDisplayManager.request("com.app.notify", {
        view: "main",
        durationMs: 5000,
        layout: {layoutType: "reference_card", title: "Notify", text: "second notification"},
      })
      const beforeRelease = mockSentEvents.length
      localDisplayManager.dismiss("com.app.notify")
      expect(mockSentEvents).toHaveLength(beforeRelease + 1)
      expect(lastScene()).toMatchObject({
        appId: "com.app.core",
        replay: true,
        elements: [expect.objectContaining({text: "core B", change: "created"})],
      })
    })
  })
})
