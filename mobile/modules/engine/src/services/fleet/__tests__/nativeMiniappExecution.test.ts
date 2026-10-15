/// <reference types="bun-types" />

/**
 * The run time of the Mentra App's native built-in miniapps, end to end: the real apps store opens, minimizes and
 * closes them the way the Home screen, the app switcher and the capsule do, and the real collector turns that into
 * Fleet records.
 */
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import {FleetRecordSchema, type FleetRecord} from "@mentra/cloud-protocol"
import {result as Res} from "typesafe-ts"
import {create} from "zustand"
import {subscribeWithSelector} from "zustand/middleware"

import {reactNativeAppState} from "../../__tests__/reactNativeTestMock"
import {configure, resetForTests} from "../../../runtime/bootstrap"
import type {ClientApp} from "../../../types/applet"
import {fakeCreateMMKV, resetFakeMmkv} from "./fakeMmkv"
import {MemoryFleetStore} from "./memoryFleetStore"

// --- fakes ------------------------------------------------------------------------------------------------------

const clock = {wall: Date.UTC(2026, 9, 14, 9, 0, 0), mono: 10_000}
const timers = new Map<number, {at: number; run: () => void}>()
let nextTimerId = 1

mock.module("../../../utils/timers", () => ({
  BgTimer: {
    setTimeout: (run: () => void, delay: number) => {
      const id = nextTimerId++
      timers.set(id, {at: clock.mono + delay, run})
      return id
    },
    clearTimeout: (id: number) => timers.delete(id),
  },
}))

/** Moves both clocks forward, running every timer that falls due on the way, in order. */
function advance(ms: number): void {
  const target = clock.mono + ms
  for (;;) {
    const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
    if (!due) break
    const [id, timer] = due
    clock.wall += timer.at - clock.mono
    clock.mono = timer.at
    timers.delete(id)
    timer.run()
  }
  clock.wall += target - clock.mono
  clock.mono = target
}

/** Every AppState listener, the apps store's as well as the collector's: a change reaches all of them. */
const appStateListeners = new Set<(state: string) => void>()
reactNativeAppState.addEventListener = ((_type: string, listener: (state: string) => void) => {
  appStateListeners.add(listener)
  return {remove: () => appStateListeners.delete(listener)}
}) as never
function setAppState(state: string): void {
  reactNativeAppState.currentState = state
  for (const listener of [...appStateListeners]) listener(state)
}

mock.module("react-native-mmkv", () => ({createMMKV: fakeCreateMMKV}))
mock.module("expo-constants", () => ({default: {expoConfig: {version: "3.4.5"}}}))
mock.module("expo-application", () => ({nativeApplicationVersion: "3.4.5", nativeBuildVersion: "345"}))
mock.module("expo-device", () => ({modelName: "Pixel 9"}))
mock.module("../../../stores/glasses", () => ({
  useGlassesStore: create(subscribeWithSelector(() => ({connection: {state: "disconnected"}, deviceModel: ""}))),
}))

// The apps store's own dependencies, stubbed as in appsLaunchTrigger.test.ts. The running-miniapp registry is the
// real one: the collector reads it too.
const compatible = {isCompatible: true, missingRequired: [], missingOptional: [], warnings: []}
mock.module("../../AppRegistry", () => ({
  default: {
    getInstalledMiniapps: async () => [],
    uninstall: async () => Res.ok(undefined),
    requiresLocalSttModel: () => false,
    subscribe: () => () => {},
  },
}))
mock.module("../../MiniappLauncher", () => ({miniappLauncher: {ensureRunning: async () => ({}), stop: async () => {}}}))
mock.module("../../LocalDisplayManager", () => ({default: {onCoreAppChange: () => {}}}))
mock.module("../../NotificationsEmitter", () => ({islandNotifications: {emit: () => {}}}))
mock.module("../../STTModelManager", () => ({default: {isModelAvailable: async () => true}}))
mock.module("../../SystemMiniappPolicy", () => ({isStoreMiniappPackage: () => false}))
mock.module("../../../utils/hardware/hardware", () => ({HardwareCompatibility: {checkCompatibility: () => compatible}}))
mock.module("../../../types/hardware", () => ({getModelCapabilities: () => ({})}))
mock.module("../../../utils/storage/storage", () => ({
  storage: {load: () => ({is_ok: () => false}), save: () => ({is_ok: () => true})},
}))
mock.module("@mentra/bluetooth-sdk", () => ({default: {clearDisplay: () => {}}}))
mock.module("../../../stores/settings", () => ({
  SETTINGS: {default_wearable: {key: "wearable"}, has_ever_activated_app: {key: "activated"}},
  useSettingsStore: {getState: () => ({getSetting: () => null, setSetting: () => {}}), subscribe: () => () => {}},
}))

const {useAppStatusStore: apps, installAppStoreHooks} = await import("../../../stores/apps")
const {miniappRunningRegistry} = await import("../../MiniappRunningRegistry")
const {createFleetQueue} = await import("../fleetQueue")
const {createFleetCollector} = await import("../fleetCollector")

// --- the built-ins, as the Mentra App registers them -------------------------------------------------------------

function nativeBuiltIn(packageName: string, name: string, extra: Partial<ClientApp>): ClientApp {
  return {
    packageName,
    name,
    webviewUrl: "",
    logoUrl: "",
    type: "background",
    permissions: [],
    running: false,
    healthy: true,
    hardwareRequirements: [],
    offline: true,
    offlineRoute: `/${name.toLowerCase()}`,
    loading: false,
    local: false,
    hidden: false,
    compatibility: compatible,
    ...extra,
  }
}

const gallery = nativeBuiltIn("com.mentra.camera", "Gallery", {type: "standard", nativeExecution: "open"})
const mirror = nativeBuiltIn("com.mentra.mirror", "Mirror", {nativeExecution: "open"})
const notify = nativeBuiltIn("cloud.augmentos.notify", "Notify", {nativeExecution: "running"})
const settings = nativeBuiltIn("com.mentra.settings", "Settings", {})
const feedback = nativeBuiltIn("com.mentra.feedback", "Feedback", {})
const developer = nativeBuiltIn("com.mentra.miniappdev", "Miniapp Developer", {type: "standard"})
/** The built-ins the Mentra App shows on a screen of their own, in the Compositor overlay. */
const SCREENS = new Set([gallery, mirror, settings, feedback].map((app) => app.packageName))

// --- harness ----------------------------------------------------------------------------------------------------

const PARTITION = "partition-a"
let queue: ReturnType<typeof createFleetQueue>
let collector: ReturnType<typeof createFleetCollector>
let quiet: Array<{mockRestore: () => void}> = []

type Kind<K extends FleetRecord["kind"]> = Extract<FleetRecord, {kind: K}>

function records(): FleetRecord[] {
  return queue.nextBatch(PARTITION, 100_000, Number.MAX_SAFE_INTEGER).map((record) => FleetRecordSchema.parse(record))
}
function ofKind<K extends FleetRecord["kind"]>(kind: K): Kind<K>[] {
  return records().filter((record): record is Kind<K> => record.kind === kind)
}
/** Every miniapp execution reported so far, last report first: package, elapsed time and whether it ended. */
function executions(): Array<{packageName?: string; id: string; elapsedMs: number; ended: boolean}> {
  return ofKind("usage_checkpoint")
    .flatMap((record) => record.payload.sessions)
    .filter((session) => session.activity === "miniapp_execution")
    .map(({packageName, activitySessionId, elapsedMs, ended}) => ({
      packageName,
      id: activitySessionId,
      elapsedMs,
      ended,
    }))
    .reverse()
}

/** A tap on the Home screen (what `useStart` gives it): a user start, which shows the built-in's screen if it has one. */
async function openFromHome(app: ClientApp): Promise<boolean> {
  return apps.getState().start(app, {trigger: "user"})
}
/** The back gesture: the screen goes, the built-in stays in the switcher. */
function minimize(): void {
  apps.getState().clearForeground()
}
/** The capsule's close button, or a swipe off the switcher. */
async function close(packageName: string): Promise<void> {
  apps.getState().clearForeground()
  await apps.getState().stop(packageName)
}

beforeAll(() => {
  installAppStoreHooks({
    onUpdateBlocked: () => {},
    onIncompatibleBlocked: () => {},
    // What BuiltInMiniappCatalog does: a built-in with a screen of its own is shown in the overlay; Notify's
    // settings are a pushed route, which leaves nothing foregrounded.
    onOpenRequested: (app) => {
      if (SCREENS.has(app.packageName)) void apps.getState().setForeground(app.packageName)
    },
  })
})

afterAll(resetForTests)

beforeEach(() => {
  clock.wall = Date.UTC(2026, 9, 14, 9, 0, 0)
  clock.mono = 10_000
  timers.clear()
  resetFakeMmkv()
  resetForTests()
  configure({auth: {}})
  // A tap on Home happens with the Mentra App in the foreground.
  reactNativeAppState.currentState = "active"
  for (const packageName of miniappRunningRegistry.getAll()) miniappRunningRegistry.remove(packageName)
  apps.setState({
    apps: [gallery, mirror, notify, settings, feedback, developer],
    updatingPackages: new Set(),
    foregroundedPackage: null,
  })
  queue = createFleetQueue(new MemoryFleetStore(), {now: () => clock.wall})
  collector = createFleetCollector({queue, now: () => clock.wall, monotonic: () => clock.mono})
  collector.start({partition: PARTITION, collectorSessionId: "COLLECTOR-SESSION-1"})
  quiet = [spyOn(console, "log").mockImplementation(() => {})]
})

afterEach(() => {
  collector.stop("engine_stopped")
  for (const spy of quiet) spy.mockRestore()
})

describe("a built-in with a screen of its own", () => {
  test("opening and closing Gallery is one execution of com.mentra.camera, as long as it was open", async () => {
    expect(await openFromHome(gallery)).toBe(true)
    advance(90_000)
    await close(gallery.packageName)

    expect(ofKind("miniapp_launch").map((record) => record.payload)).toEqual([
      {packageName: "com.mentra.camera", miniappName: "Gallery", start: "user", outcome: "started"},
    ])
    const [last, ...earlier] = executions()
    expect(last).toMatchObject({packageName: "com.mentra.camera", elapsedMs: 90_000, ended: true})
    // The 60-second checkpoint on the way reported the same session, still open.
    expect(earlier).toEqual([{packageName: "com.mentra.camera", id: last.id, elapsedMs: 60_000, ended: false}])
  })

  test("minimized to the switcher it stops executing, and reopened it runs again as a new session", async () => {
    await openFromHome(mirror)
    advance(20_000)
    minimize()
    expect(apps.getState().apps.find((app) => app.packageName === mirror.packageName)?.running).toBe(true)
    expect(executions()).toEqual([
      expect.objectContaining({packageName: "com.mentra.mirror", elapsedMs: 20_000, ended: true}),
    ])

    advance(5 * 60_000)
    // The switcher reopens a running app by bringing it to the foreground.
    await apps.getState().setForeground(mirror.packageName)
    advance(10_000)
    collector.flushCheckpoint()
    const [reopened, first] = executions()
    expect(reopened).toMatchObject({packageName: "com.mentra.mirror", elapsedMs: 10_000, ended: false})
    expect(reopened.id).not.toBe(first.id)
  })

  test("it stops executing when the Mentra App goes to the background, and runs again when it comes back", async () => {
    await openFromHome(gallery)
    advance(20_000)
    // Locking the phone or switching apps leaves Gallery foregrounded in the store, but nobody can see it.
    setAppState("background")
    expect(apps.getState().foregroundedPackage).toBe(gallery.packageName)
    expect(executions()).toEqual([
      expect.objectContaining({packageName: "com.mentra.camera", elapsedMs: 20_000, ended: true}),
    ])

    advance(60 * 60_000)
    expect(executions()).toHaveLength(1)

    setAppState("active")
    advance(5_000)
    collector.flushCheckpoint()
    const [back] = executions()
    const first = executions().find((execution) => execution.ended)
    expect(back).toMatchObject({packageName: "com.mentra.camera", elapsedMs: 5_000, ended: false})
    expect(back.id).not.toBe(first?.id as string)
  })

  test("opened while the Mentra App is in the background, it is not executing until the app is in front", async () => {
    setAppState("background")
    await openFromHome(mirror)
    advance(10_000)
    collector.flushCheckpoint()
    expect(executions()).toEqual([])
    setAppState("active")
    advance(10_000)
    collector.flushCheckpoint()
    expect(executions()[0]).toMatchObject({packageName: "com.mentra.mirror", elapsedMs: 10_000, ended: false})
  })

  test("one left running in the switcher from before is not executing until it is opened", async () => {
    collector.stop("engine_stopped")
    apps.setState({apps: [{...gallery, running: true}, notify], foregroundedPackage: null})
    collector.start({partition: PARTITION, collectorSessionId: "COLLECTOR-SESSION-2"})
    advance(30 * 60_000)
    collector.flushCheckpoint()
    expect(executions()).toEqual([])
  })
})

describe("a built-in that works without a screen", () => {
  test("Notify executes for as long as it runs, with no screen and with the Mentra App in the background", async () => {
    expect(await openFromHome(notify)).toBe(true)
    expect(apps.getState().foregroundedPackage).toBeNull()
    advance(15_000)
    setAppState("background")
    advance(30_000)
    await close(notify.packageName)
    const [last] = executions()
    expect(last).toMatchObject({packageName: "cloud.augmentos.notify", elapsedMs: 45_000, ended: true})
    // One session throughout: the app leaving the foreground did not interrupt it.
    expect(new Set(executions().map((execution) => execution.id))).toEqual(new Set([last.id]))
  })

  test("Notify already running when the collector starts is executing from then on", async () => {
    collector.stop("engine_stopped")
    setAppState("background")
    apps.setState({apps: [{...notify, running: true}], foregroundedPackage: null})
    collector.start({partition: PARTITION, collectorSessionId: "COLLECTOR-SESSION-2"})
    advance(30_000)
    collector.flushCheckpoint()
    expect(executions()).toEqual([
      expect.objectContaining({packageName: "cloud.augmentos.notify", elapsedMs: 30_000, ended: false}),
    ])
  })
})

describe("the Mentra App's own screens", () => {
  test.each([
    ["Settings", settings],
    ["Feedback", feedback],
    ["the Miniapp Developer loader", developer],
  ])("%s is not a miniapp to Fleet: no launch and no run time", async (_name, app) => {
    expect(await openFromHome(app)).toBe(true)
    advance(90_000)
    await close(app.packageName)
    collector.flushCheckpoint()
    expect(ofKind("miniapp_launch")).toEqual([])
    expect(executions()).toEqual([])
  })
})

describe("local miniapps", () => {
  test("still execute through the running-miniapp registry, never through the store's flags", async () => {
    const notes: ClientApp = {...nativeBuiltIn("com.mentra.notes", "Notes", {}), offline: false, local: true}
    apps.setState({apps: [notes], foregroundedPackage: null})
    // A local miniapp the store calls running and foregrounded, with no JS context projected, does not execute.
    apps.setState({apps: [{...notes, running: true}], foregroundedPackage: notes.packageName})
    advance(10_000)
    collector.flushCheckpoint()
    expect(executions()).toEqual([])

    miniappRunningRegistry.add(notes.packageName)
    advance(10_000)
    collector.flushCheckpoint()
    expect(executions()[0]).toMatchObject({packageName: "com.mentra.notes", elapsedMs: 10_000})
  })
})
