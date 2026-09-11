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
})
