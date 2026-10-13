/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import {readdirSync, readFileSync} from "node:fs"
import {FLEET_CAPABILITIES, FleetRecordSchema, type FleetRecord} from "@mentra/cloud-protocol"
import {create} from "zustand"
import {subscribeWithSelector} from "zustand/middleware"

import {reactNative, reactNativeAppState} from "../../__tests__/reactNativeTestMock"
import {fakeCreateMMKV, resetFakeMmkv} from "./fakeMmkv"
import {MemoryFleetStore} from "./memoryFleetStore"

// --- fakes ------------------------------------------------------------------------------------------------------

/** Wall clock and monotonic clock, advanced together by `advance` and separately by the tests that break them apart. */
const clock = {wall: Date.UTC(2026, 9, 13, 12, 0, 0), mono: 50_000}

interface FakeTimer {
  id: number
  at: number
  every: number | null
  run: () => void
}
const timers = new Map<number, FakeTimer>()
let nextTimerId = 1

function schedule(run: () => void, delay: number, every: number | null): number {
  const id = nextTimerId++
  timers.set(id, {id, at: clock.mono + delay, every, run})
  return id
}

mock.module("../../../utils/timers", () => ({
  BgTimer: {
    setTimeout: (run: () => void, delay: number) => schedule(run, delay, null),
    setInterval: (run: () => void, delay: number) => schedule(run, delay, delay),
    clearTimeout: (id: number) => timers.delete(id),
    clearInterval: (id: number) => timers.delete(id),
  },
}))

/** Moves both clocks forward, running every timer that falls due on the way, in order. */
function advance(ms: number): void {
  const target = clock.mono + ms
  for (;;) {
    const due = [...timers.values()].filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
    if (!due) break
    clock.wall += due.at - clock.mono
    clock.mono = due.at
    if (due.every === null) timers.delete(due.id)
    else due.at += due.every
    due.run()
  }
  clock.wall += target - clock.mono
  clock.mono = target
}

mock.module("react-native-mmkv", () => ({createMMKV: fakeCreateMMKV}))
mock.module("expo-constants", () => ({
  default: {nativeAppVersion: "3.4.5", nativeBuildVersion: "345", expoConfig: {version: "3.4.5"}},
}))
mock.module("expo-device", () => ({modelName: "Pixel 9"}))

const IDENTITY_CLEARED = {
  deviceModel: "",
  serialNumber: "",
  bluetoothMacAddress: "",
  leftMacAddress: "",
  bluetoothName: "",
}
const GLASSES_IDLE = {
  connection: {state: "disconnected"} as {state: string; fullyBooted?: boolean},
  ...IDENTITY_CLEARED,
  appVersion: "",
  buildNumber: "",
  mtkFirmwareVersion: "",
  besFirmwareVersion: "",
  androidVersion: "",
  firmwareVersion: "",
  batteryLevel: -1,
  charging: false,
  // Fields Fleet must never read or report.
  wifi: {state: "disconnected"} as Record<string, unknown>,
  wifiMacAddress: "",
  rightMacAddress: "",
}
const LIVE = {
  connection: {state: "connected", fullyBooted: true},
  deviceModel: "Mentra Live",
  serialNumber: "SN-LIVE-1",
  bluetoothMacAddress: "AA:BB:CC:DD:EE:FF",
  bluetoothName: "MENTRA_LIVE_BLE_1234",
  appVersion: "live-2",
  buildNumber: "200",
  mtkFirmwareVersion: "mtk-1",
  besFirmwareVersion: "bes-1",
  androidVersion: "14",
  firmwareVersion: "1.2.3",
  batteryLevel: 80,
  charging: false,
  wifi: {state: "connected", ssid: "Private Wi-Fi", localIp: "192.0.2.10"},
  wifiMacAddress: "12:34:56:78:9A:BC",
  rightMacAddress: "11:22:33:44:55:66",
}

const glassesStore = create<typeof GLASSES_IDLE>()(subscribeWithSelector(() => ({...GLASSES_IDLE})))
mock.module("../../../stores/glasses", () => ({useGlassesStore: glassesStore}))

function connectLive(extra: Partial<typeof LIVE> = {}): void {
  glassesStore.setState({...LIVE, ...extra})
}
/** What the native layer does on disconnect: identifiers are cleared, battery is not. */
function disconnectLive(): void {
  glassesStore.setState({connection: {state: "disconnected"}, ...IDENTITY_CLEARED})
}

let appStateListener: ((state: string) => void) | null = null
function setAppState(state: string, notify = true): void {
  reactNativeAppState.currentState = state
  if (notify) appStateListener?.(state)
}

const {miniappRunningRegistry} = await import("../../MiniappRunningRegistry")
const {createFleetQueue} = await import("../fleetQueue")
const {phoneDeviceId} = await import("../fleetIds")
const {fleetEvents} = await import("../fleetEvents")
const {createFleetCollector} = await import("../fleetCollector")

const ENGINE_VERSION = (require("../../../../package.json") as {version: string}).version
const SDK_VERSION = (require("@mentra/bluetooth-sdk/package.json") as {version: string}).version

// --- harness ----------------------------------------------------------------------------------------------------

const PARTITION = "partition-a"
const OTHER_PARTITION = "partition-b"
const SESSION = "COLLECTOR-SESSION-1"

let queue: ReturnType<typeof createFleetQueue>
let collector: ReturnType<typeof createFleetCollector>

type Kind<K extends FleetRecord["kind"]> = Extract<FleetRecord, {kind: K}>
type Checkpoint = Kind<"usage_checkpoint">["payload"]["sessions"][number]

function all(partition = PARTITION): FleetRecord[] {
  return queue.nextBatch(partition, 100_000, Number.MAX_SAFE_INTEGER).map((record) => FleetRecordSchema.parse(record))
}
function ofKind<K extends FleetRecord["kind"]>(kind: K, partition = PARTITION): Kind<K>[] {
  return all(partition).filter((record): record is Kind<K> => record.kind === kind)
}
const checkpoints = (partition = PARTITION) => ofKind("usage_checkpoint", partition)
const snapshots = (partition = PARTITION) => ofKind("snapshot", partition)
const gaps = (partition = PARTITION) => ofKind("coverage_gap", partition)

function entry(record: Kind<"usage_checkpoint">, activity: string, packageName?: string): Checkpoint | undefined {
  return record.payload.sessions.find((s) => s.activity === activity && (!packageName || s.packageName === packageName))
}
function iso(wall: number): string {
  return new Date(wall).toISOString()
}

function start(partition = PARTITION, collectorSessionId = SESSION): void {
  collector.start({partition, collectorSessionId})
}

beforeEach(() => {
  clock.wall = Date.UTC(2026, 9, 13, 12, 0, 0)
  clock.mono = 50_000
  timers.clear()
  resetFakeMmkv()
  glassesStore.setState({...GLASSES_IDLE}, true)
  for (const packageName of miniappRunningRegistry.getAll()) miniappRunningRegistry.remove(packageName)
  Object.assign(reactNative.Platform as object, {OS: "android", Version: 35, constants: {Release: "15"}})
  appStateListener = null
  reactNativeAppState.currentState = "background"
  reactNativeAppState.addEventListener = ((_type: string, listener: (state: string) => void) => {
    appStateListener = listener
    return {
      remove: () => {
        if (appStateListener === listener) appStateListener = null
      },
    }
  }) as never
  queue = createFleetQueue(new MemoryFleetStore(), {now: () => clock.wall})
  collector = createFleetCollector({queue, now: () => clock.wall, monotonic: () => clock.mono})
})

afterEach(() => {
  collector.stop("engine_stopped")
  // Every record any test queued is valid under the wire contract, with a unique ID and in sequence.
  for (const partition of [PARTITION, OTHER_PARTITION]) {
    const records = all(partition)
    expect(new Set(records.map((r) => r.recordId)).size).toBe(records.length)
    const bySession = new Map<string, number[]>()
    for (const r of records)
      bySession.set(r.collectorSessionId, [...(bySession.get(r.collectorSessionId) ?? []), r.sequence])
    for (const sequences of bySession.values()) {
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
      expect(new Set(sequences).size).toBe(sequences.length)
    }
  }
})

// --- sessions and checkpoints -----------------------------------------------------------------------------------

describe("start", () => {
  test("takes a snapshot and opens the engine session, and writes no checkpoint yet", () => {
    start()
    const records = all()
    expect(records.map((r) => r.kind)).toEqual(["snapshot"])
    expect(records[0]).toMatchObject({collectorSessionId: SESSION, sequence: 0, phoneDeviceId: phoneDeviceId()})
    expect(records[0].observedAt).toBe(iso(clock.wall))

    collector.flushCheckpoint()
    const [checkpoint] = checkpoints()
    expect(checkpoint.payload.sessions.map((s) => s.activity)).toEqual(["engine_active"])
  })

  test("opens the foreground session when the Mentra App is in the foreground", () => {
    setAppState("active", false)
    start()
    collector.flushCheckpoint()
    expect(checkpoints()[0].payload.sessions.map((s) => s.activity)).toEqual(["engine_active", "app_foreground"])
  })

  test("opens a session for glasses already connected and for miniapps already running", () => {
    connectLive()
    miniappRunningRegistry.add("com.mentra.notes")
    start()
    collector.flushCheckpoint()
    const [checkpoint] = checkpoints()
    expect(checkpoint.payload.sessions.map((s) => [s.activity, s.packageName])).toEqual([
      ["engine_active", undefined],
      ["glasses_connection", undefined],
      ["miniapp_execution", "com.mentra.notes"],
    ])
    expect(entry(checkpoint, "glasses_connection")?.deviceBinding).toEqual({
      kind: "serial",
      manufacturer: "Mentra",
      product: "Mentra Live",
      serial: "SN-LIVE-1",
    })
  })

  test("does not count glasses that are only scanning or connecting", () => {
    glassesStore.setState({connection: {state: "connecting"}, deviceModel: "Mentra Live"})
    start()
    collector.flushCheckpoint()
    expect(checkpoints()[0].payload.sessions.map((s) => s.activity)).toEqual(["engine_active"])
  })

  test("starting again closes the first run into its own partition", () => {
    start(PARTITION, "COLLECTOR-SESSION-1")
    advance(10_000)
    start(OTHER_PARTITION, "COLLECTOR-SESSION-2")
    const [closing] = checkpoints(PARTITION)
    expect(closing.payload.sessions).toEqual([
      expect.objectContaining({activity: "engine_active", elapsedMs: 10_000, ended: true}),
    ])
    expect(snapshots(OTHER_PARTITION)).toHaveLength(1)
    expect(checkpoints(OTHER_PARTITION)).toHaveLength(0)
  })
})

describe("checkpoints", () => {
  test("glasses connected for 150 s with checkpoints at 60 s and 120 s give three checkpoints, the last one ended", () => {
    start()
    const connectedAt = clock.wall
    connectLive()
    advance(60_000)
    advance(60_000)
    advance(30_000)
    disconnectLive()

    const list = checkpoints()
    expect(list).toHaveLength(3)
    expect(list.map((c) => entry(c, "glasses_connection")?.elapsedMs)).toEqual([60_000, 120_000, 150_000])
    expect(list.map((c) => entry(c, "glasses_connection")?.ended)).toEqual([false, false, true])
    expect(list.map((c) => c.observedAt)).toEqual([
      iso(connectedAt + 60_000),
      iso(connectedAt + 120_000),
      iso(connectedAt + 150_000),
    ])
    // The engine session is still open at the last checkpoint; every checkpoint packs every open session.
    expect(list.map((c) => entry(c, "engine_active")?.ended)).toEqual([false, false, false])
    expect(list.map((c) => entry(c, "engine_active")?.elapsedMs)).toEqual([60_000, 120_000, 150_000])
    // One session across the three checkpoints, started when the glasses connected.
    const ids = list.map((c) => entry(c, "glasses_connection")?.activitySessionId)
    expect(new Set(ids).size).toBe(1)
    expect(entry(list[0], "glasses_connection")?.startedAt).toBe(iso(connectedAt))
    // The binding survives the native layer clearing the serial on disconnect.
    expect(entry(list[2], "glasses_connection")?.deviceBinding).toEqual(
      entry(list[0], "glasses_connection")?.deviceBinding,
    )
  })

  test("with only the engine active, a checkpoint comes every 15 minutes and not before", () => {
    start()
    advance(14 * 60_000 + 59_000)
    expect(checkpoints()).toHaveLength(0)
    advance(1_000)
    expect(checkpoints()).toHaveLength(1)
    expect(entry(checkpoints()[0], "engine_active")?.elapsedMs).toBe(15 * 60_000)
    advance(15 * 60_000)
    expect(checkpoints()).toHaveLength(2)
    expect(entry(checkpoints()[1], "engine_active")?.elapsedMs).toBe(30 * 60_000)
  })

  test("a checkpoint comes every 60 s while the Mentra App is in the foreground", () => {
    setAppState("active", false)
    start()
    advance(60_000)
    advance(60_000)
    expect(checkpoints().map((c) => entry(c, "app_foreground")?.elapsedMs)).toEqual([60_000, 120_000])
  })

  test("a checkpoint comes every 60 s while a miniapp is executing", () => {
    start()
    miniappRunningRegistry.add("com.mentra.notes")
    advance(60_000)
    advance(60_000)
    expect(checkpoints().map((c) => entry(c, "miniapp_execution", "com.mentra.notes")?.elapsedMs)).toEqual([
      60_000, 120_000,
    ])
  })

  test("a session that ends is checkpointed at once with ended true, and the other sessions carry on", () => {
    start()
    miniappRunningRegistry.add("com.a")
    advance(10_000)
    miniappRunningRegistry.add("com.b")
    advance(20_000)
    miniappRunningRegistry.remove("com.a")

    const [closing] = checkpoints()
    expect(closing.observedAt).toBe(iso(clock.wall))
    expect(entry(closing, "miniapp_execution", "com.a")).toMatchObject({elapsedMs: 30_000, ended: true})
    expect(entry(closing, "miniapp_execution", "com.b")).toMatchObject({elapsedMs: 20_000, ended: false})
    expect(entry(closing, "engine_active")).toMatchObject({elapsedMs: 30_000, ended: false})
  })

  test("every miniapp that stops is closed", () => {
    start()
    miniappRunningRegistry.add("com.a")
    miniappRunningRegistry.add("com.b")
    advance(5_000)
    miniappRunningRegistry.remove("com.a")
    miniappRunningRegistry.remove("com.b")
    const closed = checkpoints().flatMap((c) => c.payload.sessions.filter((s) => s.ended).map((s) => s.packageName))
    expect(closed.sort()).toEqual(["com.a", "com.b"])
  })

  test("the cadence goes back to 15 minutes once the last fast activity has ended", () => {
    setAppState("active", false)
    start()
    advance(30_000)
    setAppState("background") // the foreground session ends: an immediate checkpoint
    expect(checkpoints()).toHaveLength(1)
    expect(entry(checkpoints()[0], "app_foreground")).toMatchObject({elapsedMs: 30_000, ended: true})
    advance(14 * 60_000 + 59_000)
    expect(checkpoints()).toHaveLength(1)
    advance(1_000)
    expect(checkpoints()).toHaveLength(2)
  })

  test("the foreground session follows the app state", () => {
    start()
    setAppState("active")
    advance(20_000)
    setAppState("inactive")
    setAppState("active")
    advance(10_000)
    setAppState("background")
    const sessions = checkpoints().flatMap((c) => c.payload.sessions.filter((s) => s.activity === "app_foreground"))
    const ended = sessions.filter((s) => s.ended)
    expect(ended.map((s) => s.elapsedMs)).toEqual([20_000, 10_000])
    expect(new Set(ended.map((s) => s.activitySessionId)).size).toBe(2)
  })

  test("flushCheckpoint writes one packed checkpoint for every open session", () => {
    connectLive()
    miniappRunningRegistry.add("com.a")
    miniappRunningRegistry.add("com.b")
    start()
    advance(7_000)
    collector.flushCheckpoint()
    const list = checkpoints()
    expect(list).toHaveLength(1)
    expect(list[0].payload.sessions).toHaveLength(4)
    expect(list[0].payload.sessions.every((s) => s.elapsedMs === 7_000 && !s.ended)).toBe(true)
  })

  test("more than 32 open sessions are packed into several checkpoints of at most 32", () => {
    start()
    for (let index = 0; index < 33; index += 1) miniappRunningRegistry.add(`com.mentra.app${index}`)
    advance(1_000)
    collector.flushCheckpoint()
    const list = checkpoints()
    expect(list.map((c) => c.payload.sessions.length)).toEqual([32, 2])
    const ids = list.flatMap((c) => c.payload.sessions.map((s) => s.activitySessionId))
    expect(ids).toHaveLength(34)
    expect(new Set(ids).size).toBe(34)
  })

  test("elapsed time never goes backwards between checkpoints", () => {
    start()
    miniappRunningRegistry.add("com.a")
    const seen: number[] = []
    for (let index = 0; index < 5; index += 1) {
      advance(13_000)
      collector.flushCheckpoint()
      seen.push(entry(checkpoints().at(-1) as Kind<"usage_checkpoint">, "miniapp_execution", "com.a")?.elapsedMs ?? -1)
    }
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
    expect(seen[0]).toBe(13_000)
  })

  test("flushCheckpoint before start does nothing", () => {
    expect(() => collector.flushCheckpoint()).not.toThrow()
    expect(all()).toHaveLength(0)
  })
})

describe("glasses binding in checkpoints", () => {
  test("a serial that arrives after the connection but before the first report is the binding", () => {
    start()
    connectLive({serialNumber: ""})
    advance(1_000)
    glassesStore.setState({serialNumber: "SN-LATE"})
    advance(59_000)
    const [first] = checkpoints()
    expect(entry(first, "glasses_connection")?.deviceBinding).toMatchObject({kind: "serial", serial: "SN-LATE"})
    // No record anywhere names the provisional stand-in for these glasses.
    expect(JSON.stringify(all())).not.toContain("provisional")
  })

  test("glasses without a serial are reported with a provisional binding", () => {
    start()
    connectLive({serialNumber: "0000000000"})
    advance(60_000)
    expect(entry(checkpoints()[0], "glasses_connection")?.deviceBinding).toMatchObject({
      kind: "provisional",
      product: "Mentra Live",
    })
  })

  test("a serial that arrives after the first report does not change the session's binding", () => {
    start()
    connectLive({serialNumber: ""})
    advance(60_000)
    glassesStore.setState({serialNumber: "SN-VERY-LATE"})
    advance(60_000)
    const [first, second] = checkpoints()
    expect(entry(second, "glasses_connection")?.deviceBinding).toEqual(
      entry(first, "glasses_connection")?.deviceBinding,
    )
    expect(entry(second, "glasses_connection")?.activitySessionId).toBe(
      entry(first, "glasses_connection")?.activitySessionId as string,
    )
  })

  test("glasses that connect just as another session ends are not reported before they are identified", () => {
    setAppState("active", false)
    start()
    // The foreground session ends and the glasses connect in the same moment, with no serial yet.
    reactNativeAppState.currentState = "background"
    connectLive({serialNumber: ""})
    expect(checkpoints().map((c) => c.payload.sessions.map((s) => s.activity))).toEqual([
      ["engine_active", "app_foreground"],
    ])
    glassesStore.setState({serialNumber: "SN-SETTLED"})
    advance(60_000)
    const latest = checkpoints().at(-1) as Kind<"usage_checkpoint">
    expect(entry(latest, "glasses_connection")?.deviceBinding).toMatchObject({kind: "serial", serial: "SN-SETTLED"})
  })

  test("a connection that ends before its glasses were ever identified is not reported", () => {
    start()
    glassesStore.setState({connection: {state: "connected", fullyBooted: false}})
    advance(5_000)
    glassesStore.setState({connection: {state: "disconnected"}})
    for (const c of checkpoints()) expect(entry(c, "glasses_connection")).toBeUndefined()
  })
})

// --- clock changes and suspension -------------------------------------------------------------------------------

describe("clock changes and suspension", () => {
  function connectedAndCheckpointed() {
    start()
    connectLive()
    miniappRunningRegistry.add("com.a")
    advance(60_000) // checkpoint 1
    advance(30_000)
    return {firstCheckpointAt: clock.wall - 30_000}
  }

  test("a 10-minute wall-clock jump closes the sessions at their last checkpoint and enqueues one clock_untrusted gap", () => {
    setAppState("active", false)
    const {firstCheckpointAt} = connectedAndCheckpointed()
    const before = checkpoints()
    expect(before).toHaveLength(1)
    const firstIds = before[0].payload.sessions.map((s) => s.activitySessionId)

    clock.wall += 10 * 60_000 // somebody changed the phone's clock; the monotonic clock did not move
    advance(30_000) // the next checkpoint falls due

    const list = checkpoints()
    expect(list).toHaveLength(2)
    const closing = list[1]
    // Closed where they were last confirmed: not at 90 s, and not 10 minutes later.
    expect(closing.observedAt).toBe(iso(firstCheckpointAt))
    expect(closing.payload.sessions.map((s) => [s.activity, s.packageName, s.elapsedMs, s.ended])).toEqual([
      ["engine_active", undefined, 60_000, true],
      ["app_foreground", undefined, 60_000, true],
      ["glasses_connection", undefined, 60_000, true],
      ["miniapp_execution", "com.a", 60_000, true],
    ])
    expect(closing.payload.sessions.map((s) => s.activitySessionId)).toEqual(firstIds)

    expect(gaps()).toHaveLength(1)
    expect(gaps()[0].payload).toMatchObject({
      reason: "clock_untrusted",
      from: iso(firstCheckpointAt),
      to: iso(clock.wall),
    })
  })

  test("the sessions that are still active start again with new IDs, counting from the clock change", () => {
    const {firstCheckpointAt} = connectedAndCheckpointed()
    const firstIds = checkpoints()[0].payload.sessions.map((s) => s.activitySessionId)
    clock.wall += 10 * 60_000
    advance(30_000)
    const reopenedAt = clock.wall
    advance(60_000)

    const latest = checkpoints().at(-1) as Kind<"usage_checkpoint">
    expect(latest.payload.sessions.map((s) => s.activity).sort()).toEqual([
      "engine_active",
      "glasses_connection",
      "miniapp_execution",
    ])
    for (const session of latest.payload.sessions) {
      expect(session.ended).toBe(false)
      expect(session.elapsedMs).toBe(60_000)
      expect(session.startedAt).toBe(iso(reopenedAt))
      expect(firstIds).not.toContain(session.activitySessionId)
    }
    expect(gaps()).toHaveLength(1)
    expect(gaps()[0].payload.from).toBe(iso(firstCheckpointAt))
  })

  test("a session that has not been checkpointed yet is not closed, but is started again", () => {
    start()
    advance(60_000 * 15) // checkpoint of the engine session
    miniappRunningRegistry.add("com.late")
    clock.wall += 10 * 60_000
    collector.flushCheckpoint()
    const closing = checkpoints()[1]
    expect(closing.payload.sessions.map((s) => s.activity)).toEqual(["engine_active"])
    collector.flushCheckpoint()
    const reopened = checkpoints().at(-1) as Kind<"usage_checkpoint">
    expect(entry(reopened, "miniapp_execution", "com.late")).toMatchObject({elapsedMs: 0, ended: false})
  })

  test("a clock set back is clock_untrusted, and the gap never ends before it starts", () => {
    connectedAndCheckpointed()
    clock.wall -= 3 * 60_000 * 60 // three hours back
    advance(30_000)
    expect(gaps()).toHaveLength(1)
    expect(gaps()[0].payload.reason).toBe("clock_untrusted")
    // The span is what the monotonic clock measured since the last confirmation (60 s), not the wall clock's.
    expect(Date.parse(gaps()[0].payload.to) - Date.parse(gaps()[0].payload.from)).toBe(60_000)
    for (const c of checkpoints()) for (const s of c.payload.sessions) expect(s.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  test("time the phone spent suspended with the app in the background is a reporter_stopped gap", () => {
    const {firstCheckpointAt} = connectedAndCheckpointed()
    setAppState("background")
    clock.wall += 10 * 60_000 // the process slept: the monotonic clock stood still while the wall clock ran
    advance(30_000)
    expect(gaps()).toHaveLength(1)
    expect(gaps()[0].payload).toMatchObject({
      reason: "reporter_stopped",
      from: iso(firstCheckpointAt),
      to: iso(clock.wall),
    })
  })

  test("a reporter that fell silent for minutes with both clocks agreeing is a reporter_stopped gap", () => {
    connectedAndCheckpointed()
    // Both clocks ran on, but no timer fired and nothing observed anything: the process was suspended.
    clock.wall += 10 * 60_000
    clock.mono += 10 * 60_000
    setAppState("active")
    expect(gaps()).toHaveLength(1)
    expect(gaps()[0].payload.reason).toBe("reporter_stopped")
    expect(checkpoints()[1].payload.sessions.every((s) => s.elapsedMs === 60_000 && s.ended)).toBe(true)
  })

  test("a drift under two minutes is tolerated, and usage still counts monotonic time", () => {
    connectedAndCheckpointed()
    clock.wall += 119_000
    advance(30_000)
    expect(gaps()).toHaveLength(0)
    expect(
      checkpoints()
        .flatMap((c) => c.payload.sessions)
        .some((s) => s.ended),
    ).toBe(false)
    // The second checkpoint fell due 120 s after the glasses connected; the wall clock says 239 s.
    expect(entry(checkpoints()[1], "glasses_connection")?.elapsedMs).toBe(120_000)
  })

  test("a state change after a clock change is judged against the old checkpoint first", () => {
    connectedAndCheckpointed()
    clock.wall += 10 * 60_000
    miniappRunningRegistry.remove("com.a") // the first thing to notice is a miniapp stopping
    expect(gaps()).toHaveLength(1)
    // The jump is handled before the stop: nothing is attributed across it, and the stopped miniapp is not reopened.
    const latest = checkpoints().at(-1) as Kind<"usage_checkpoint">
    expect(latest.payload.sessions.every((s) => s.ended)).toBe(true)
    collector.flushCheckpoint()
    const afterwards = checkpoints().at(-1) as Kind<"usage_checkpoint">
    expect(entry(afterwards, "miniapp_execution", "com.a")).toBeUndefined()
    expect(entry(afterwards, "glasses_connection")).toBeDefined()
  })

  test("usage never exceeds the monotonic time it was observed for", () => {
    connectedAndCheckpointed()
    clock.wall += 6 * 60 * 60_000
    advance(30_000)
    advance(60_000)
    const maxElapsed = Math.max(...checkpoints().flatMap((c) => c.payload.sessions.map((s) => s.elapsedMs)))
    expect(maxElapsed).toBeLessThanOrEqual(90_000)
  })
})

// --- stop -------------------------------------------------------------------------------------------------------

describe("stop", () => {
  test.each(["engine_stopped", "account_changed", "not_installed"] as const)(
    "stop(%s) ends every session in the partition it started with",
    (reason) => {
      start()
      connectLive()
      miniappRunningRegistry.add("com.a")
      setAppState("active")
      advance(25_000)
      collector.stop(reason)

      const closing = checkpoints().at(-1) as Kind<"usage_checkpoint">
      expect(closing.payload.sessions.map((s) => [s.activity, s.elapsedMs, s.ended])).toEqual([
        ["engine_active", 25_000, true],
        ["glasses_connection", 25_000, true],
        ["miniapp_execution", 25_000, true],
        ["app_foreground", 25_000, true],
      ])
    },
  )

  test("stopping writes its final checkpoint to the partition it was started with, even after another start", () => {
    start(PARTITION, "COLLECTOR-SESSION-1")
    miniappRunningRegistry.add("com.a")
    advance(10_000)
    collector.stop("account_changed")
    const inFirst = all(PARTITION).length
    start(OTHER_PARTITION, "COLLECTOR-SESSION-2")
    advance(10_000)
    collector.stop("engine_stopped")
    expect(all(PARTITION)).toHaveLength(inFirst)
    expect(all(OTHER_PARTITION).length).toBeGreaterThan(0)
    expect(all(OTHER_PARTITION).every((r) => r.collectorSessionId === "COLLECTOR-SESSION-2")).toBe(true)
  })

  test("nothing is recorded after stop: events, timers, store and app state are all ignored", () => {
    start()
    collector.stop("engine_stopped")
    const count = all().length
    miniappRunningRegistry.add("com.a")
    connectLive()
    setAppState("active")
    fleetEvents.launch({packageName: "com.a", start: "user", outcome: "started"})
    fleetEvents.photo({operationId: "op1", stage: "requested"})
    advance(2 * 60 * 60_000)
    collector.flushCheckpoint()
    expect(all()).toHaveLength(count)
    expect(timers.size).toBe(0)
    expect(appStateListener).toBeNull()
  })

  test("stop before start, and stop twice, do nothing", () => {
    expect(() => collector.stop("engine_stopped")).not.toThrow()
    start()
    collector.stop("engine_stopped")
    const count = all().length
    collector.stop("account_changed")
    expect(all()).toHaveLength(count)
  })

  test("a later start has no memory of the earlier one", () => {
    start(PARTITION, "COLLECTOR-SESSION-1")
    miniappRunningRegistry.add("com.a")
    advance(30_000)
    collector.stop("account_changed")
    miniappRunningRegistry.remove("com.a")
    start(OTHER_PARTITION, "COLLECTOR-SESSION-2")
    collector.flushCheckpoint()
    const [only] = checkpoints(OTHER_PARTITION)
    expect(only.payload.sessions.map((s) => s.activity)).toEqual(["engine_active"])
    expect(only.sequence).toBe(1) // after the snapshot, counting from 0 in the new collector session
    const firstEngineId = entry(
      checkpoints(PARTITION).at(-1) as Kind<"usage_checkpoint">,
      "engine_active",
    )?.activitySessionId
    expect(only.payload.sessions[0].activitySessionId).not.toBe(firstEngineId as string)
  })
})

// --- snapshots --------------------------------------------------------------------------------------------------

describe("snapshots", () => {
  test("the snapshot at start describes the phone and, with no glasses known, nothing else", () => {
    start()
    const [snapshot] = snapshots()
    expect(snapshot.payload).toEqual({
      phone: {
        model: "Pixel 9",
        os: "android",
        osVersion: "15",
        appVersion: "3.4.5",
        appBuild: "345",
        engineVersion: ENGINE_VERSION,
        sdkVersion: SDK_VERSION,
      },
    })
    expect(snapshot.deviceBinding).toBeUndefined()
  })

  test("on iOS the OS version is the platform version", () => {
    Object.assign(reactNative.Platform as object, {OS: "ios", Version: "26.0"})
    start()
    expect(snapshots()[0].payload.phone).toMatchObject({os: "ios", osVersion: "26.0"})
  })

  test("a platform Fleet cannot describe gets no snapshot, and nothing breaks", () => {
    Object.assign(reactNative.Platform as object, {OS: "web"})
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(() => start()).not.toThrow()
      expect(snapshots()).toHaveLength(0)
      collector.flushCheckpoint()
      expect(checkpoints()).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  test("connected glasses are described, with the serial binding and the battery that was measured", () => {
    connectLive()
    start()
    const [snapshot] = snapshots()
    expect(snapshot.deviceBinding).toEqual({
      kind: "serial",
      manufacturer: "Mentra",
      product: "Mentra Live",
      serial: "SN-LIVE-1",
    })
    expect(snapshot.payload.glasses).toEqual({
      model: "Mentra Live",
      firmware: {apk: "live-2 (200)", mtk: "mtk-1", bes: "bes-1", os: "14"},
      connection: {state: "connected", observedAt: iso(clock.wall)},
      battery: {state: "measured", observedAt: iso(clock.wall), level: 80, charging: false},
    })
  })

  test("a battery level of -1 is unknown", () => {
    connectLive({batteryLevel: -1})
    start()
    expect(snapshots()[0].payload.glasses?.battery).toEqual({state: "unknown", observedAt: iso(clock.wall)})
  })

  test("an unknown battery keeps the time it was first seen as unknown", () => {
    connectLive({batteryLevel: -1})
    start()
    const seenAt = clock.wall
    advance(15 * 60_000)
    expect((snapshots().at(-1) as Kind<"snapshot">).payload.glasses?.battery).toEqual({
      state: "unknown",
      observedAt: iso(seenAt),
    })
  })

  test("firmware falls back to the glasses firmware version where there is no Android version", () => {
    connectLive({androidVersion: "", firmwareVersion: "1.4.5", mtkFirmwareVersion: "", besFirmwareVersion: ""})
    start()
    expect(snapshots()[0].payload.glasses?.firmware).toEqual({apk: "live-2 (200)", os: "1.4.5"})
  })

  test("connection states other than connected and disconnected are reported as connecting", () => {
    glassesStore.setState({connection: {state: "bonding"}, deviceModel: "Mentra Live", serialNumber: "SN-1"})
    start()
    expect(snapshots()[0].payload.glasses?.connection.state).toBe("connecting")
  })

  test("nothing from the glasses beyond the contract is reported: no addresses, Wi-Fi or names", () => {
    connectLive()
    start()
    miniappRunningRegistry.add("com.a")
    advance(2_000)
    collector.flushCheckpoint()
    const everything = JSON.stringify(all())
    for (const secret of ["AA:BB:CC", "12:34:56", "11:22:33", "Private Wi-Fi", "192.0.2.10", "MENTRA_LIVE_BLE_1234"]) {
      expect(everything).not.toContain(secret)
    }
  })

  test("a connection change is a snapshot, once, after the changes settle", () => {
    start()
    connectLive()
    expect(snapshots()).toHaveLength(1)
    advance(1_999)
    expect(snapshots()).toHaveLength(1)
    advance(1)
    const list = snapshots()
    expect(list).toHaveLength(2)
    expect(list[1].payload.glasses?.connection).toEqual({state: "connected", observedAt: iso(clock.wall - 2_000)})
    expect(list[1].deviceBinding).toMatchObject({kind: "serial", serial: "SN-LIVE-1"})
  })

  test("changes close together are one snapshot", () => {
    start()
    glassesStore.setState({connection: {state: "connecting"}, deviceModel: "Mentra Live"})
    advance(300)
    connectLive()
    advance(300)
    glassesStore.setState({mtkFirmwareVersion: "mtk-2"})
    advance(5_000)
    expect(snapshots()).toHaveLength(2)
    expect(snapshots()[1].payload.glasses?.firmware?.mtk).toBe("mtk-2")
  })

  test("a steady stream of changes still produces a snapshot every two seconds, not none until it stops", () => {
    connectLive()
    start()
    for (let version = 2; version <= 7; version += 1) {
      advance(1_000)
      glassesStore.setState({mtkFirmwareVersion: `mtk-${version}`})
    }
    expect(snapshots().length).toBeGreaterThanOrEqual(3)
  })

  test("a move from scanning to connecting is not a new connection state", () => {
    glassesStore.setState({connection: {state: "scanning"}, deviceModel: "Mentra Live", serialNumber: "SN-1"})
    start()
    glassesStore.setState({connection: {state: "connecting"}})
    advance(5_000)
    expect(snapshots()).toHaveLength(1)
  })

  test("a battery change under five points is not a snapshot, five or more is, counted from the last snapshot", () => {
    connectLive({batteryLevel: 80})
    start()
    glassesStore.setState({batteryLevel: 77})
    advance(5_000)
    expect(snapshots()).toHaveLength(1)
    glassesStore.setState({batteryLevel: 75}) // five below the last snapshot
    advance(5_000)
    expect(snapshots()).toHaveLength(2)
    expect(snapshots()[1].payload.glasses?.battery).toMatchObject({state: "measured", level: 75})
    glassesStore.setState({batteryLevel: 76})
    advance(5_000)
    expect(snapshots()).toHaveLength(2)
  })

  test("a charging change is a snapshot", () => {
    connectLive({batteryLevel: 80})
    start()
    glassesStore.setState({charging: true})
    advance(5_000)
    expect(snapshots()).toHaveLength(2)
    expect(snapshots()[1].payload.glasses?.battery).toMatchObject({state: "measured", level: 80, charging: true})
  })

  test("a version change is a snapshot", () => {
    connectLive()
    start()
    glassesStore.setState({mtkFirmwareVersion: "mtk-2"})
    advance(5_000)
    expect(snapshots()).toHaveLength(2)
    glassesStore.setState({appVersion: "live-3"})
    advance(5_000)
    expect(snapshots()).toHaveLength(3)
    expect(snapshots()[2].payload.glasses?.firmware?.apk).toBe("live-3 (200)")
  })

  test("a version that merely goes blank when the glasses disconnect is not a version change", () => {
    connectLive()
    start()
    glassesStore.setState({connection: {state: "disconnected"}, ...IDENTITY_CLEARED, mtkFirmwareVersion: ""})
    advance(5_000)
    // one snapshot for the connection change; the blanked version added none of its own
    expect(snapshots()).toHaveLength(2)
    expect(snapshots()[1].payload.glasses?.firmware?.mtk).toBe("mtk-1")
  })

  test("glasses that have disconnected are still described, as disconnected, with the binding they had", () => {
    connectLive()
    start()
    advance(10_000)
    disconnectLive()
    advance(5_000)
    const latest = snapshots().at(-1) as Kind<"snapshot">
    expect(latest.payload.glasses?.model).toBe("Mentra Live")
    expect(latest.payload.glasses?.connection.state).toBe("disconnected")
    expect(latest.deviceBinding).toMatchObject({kind: "serial", serial: "SN-LIVE-1"})
  })

  test("a snapshot comes every 15 minutes", () => {
    start()
    advance(14 * 60_000 + 59_000)
    expect(snapshots()).toHaveLength(1)
    advance(1_000)
    expect(snapshots()).toHaveLength(2)
    advance(15 * 60_000)
    expect(snapshots()).toHaveLength(3)
  })

  test("a later snapshot does not make an old battery reading look fresh", () => {
    connectLive({batteryLevel: 80})
    start()
    const measuredAt = clock.wall
    advance(15 * 60_000)
    const latest = snapshots().at(-1) as Kind<"snapshot">
    expect(latest.observedAt).toBe(iso(clock.wall))
    expect(latest.payload.glasses?.battery).toMatchObject({level: 80, observedAt: iso(measuredAt)})
  })

  test("a battery reading taken on the way is dated when it was seen", () => {
    connectLive({batteryLevel: 80})
    start()
    advance(60_000)
    glassesStore.setState({batteryLevel: 78})
    const seenAt = clock.wall
    advance(15 * 60_000)
    expect((snapshots().at(-1) as Kind<"snapshot">).payload.glasses?.battery).toMatchObject({
      level: 78,
      observedAt: iso(seenAt),
    })
  })

  test("the last battery reading keeps its own time once the glasses have disconnected", () => {
    connectLive({batteryLevel: 80})
    start()
    const measuredAt = clock.wall
    advance(10 * 60_000)
    disconnectLive()
    advance(5_000)
    const latest = snapshots().at(-1) as Kind<"snapshot">
    expect(latest.payload.glasses?.connection.state).toBe("disconnected")
    expect(latest.payload.glasses?.battery).toEqual({
      state: "measured",
      observedAt: iso(measuredAt),
      level: 80,
      charging: false,
    })
  })
})

describe("capabilities", () => {
  test("with glasses connected the phone measures all seven", () => {
    connectLive()
    start()
    expect([...snapshots()[0].capabilities].sort()).toEqual([...FLEET_CAPABILITIES].sort())
    collector.flushCheckpoint()
    expect([...checkpoints()[0].capabilities].sort()).toEqual([...FLEET_CAPABILITIES].sort())
  })

  test("without glasses it lists only what it can measure, and never battery or versions", () => {
    start()
    collector.flushCheckpoint()
    for (const record of all()) {
      expect(record.capabilities).toContain("engine_active")
      expect(record.capabilities).toContain("app_foreground")
      expect(record.capabilities).toContain("miniapp_execution")
      expect(record.capabilities).not.toContain("glasses_battery")
      expect(record.capabilities).not.toContain("glasses_versions")
    }
  })
})

// --- launches and photos ----------------------------------------------------------------------------------------

describe("launches", () => {
  test("a user start and an automatic start are recorded as given", () => {
    start()
    fleetEvents.launch({
      packageName: "com.mentra.notes",
      miniappName: "Notes",
      versionName: "1.0.30",
      start: "user",
      outcome: "started",
    })
    fleetEvents.launch({packageName: "com.mentra.notes", start: "automatic", outcome: "started"})
    const [first, second] = ofKind("miniapp_launch")
    expect(first.payload).toEqual({
      packageName: "com.mentra.notes",
      miniappName: "Notes",
      versionName: "1.0.30",
      start: "user",
      outcome: "started",
    })
    expect(second.payload).toEqual({packageName: "com.mentra.notes", start: "automatic", outcome: "started"})
    expect(first.observedAt).toBe(iso(clock.wall))
  })

  test("a failed start is recorded as failed", () => {
    start()
    fleetEvents.launch({packageName: "com.a", start: "user", outcome: "failed"})
    expect(ofKind("miniapp_launch")[0].payload.outcome).toBe("failed")
  })

  test("a launch without a package is ignored", () => {
    start()
    fleetEvents.launch({packageName: "  ", start: "user", outcome: "started"})
    expect(ofKind("miniapp_launch")).toHaveLength(0)
  })

  test("launches are not recorded before start", () => {
    fleetEvents.launch({packageName: "com.a", start: "user", outcome: "started"})
    start()
    expect(ofKind("miniapp_launch")).toHaveLength(0)
  })
})

describe("photos", () => {
  test("the stages of one photo share one operation ID and the glasses' binding", () => {
    connectLive()
    start()
    fleetEvents.photo({operationId: "req-123", stage: "requested"})
    fleetEvents.photo({operationId: "req-123", stage: "captured"})
    fleetEvents.photo({operationId: "req-123", stage: "delivered"})
    const photos = ofKind("photo_operation")
    expect(photos.map((p) => p.payload.stage)).toEqual(["requested", "captured", "delivered"])
    expect(new Set(photos.map((p) => p.operationId))).toEqual(new Set(["req-123"]))
    for (const photo of photos) {
      expect(photo.deviceBinding).toEqual({
        kind: "serial",
        manufacturer: "Mentra",
        product: "Mentra Live",
        serial: "SN-LIVE-1",
      })
    }
  })

  test("a failure names the stage it reached", () => {
    connectLive()
    start()
    fleetEvents.photo({operationId: "req-9", stage: "requested"})
    fleetEvents.photo({operationId: "req-9", stage: "failed", failedStage: "requested"})
    const failed = ofKind("photo_operation")[1]
    expect(failed.payload).toEqual({stage: "failed", failedStage: "requested"})
  })

  test("a failure that does not say where defaults to the requested stage, and a failedStage on a success is dropped", () => {
    connectLive()
    start()
    fleetEvents.photo({operationId: "req-9", stage: "failed"})
    fleetEvents.photo({operationId: "req-10", stage: "captured", failedStage: "requested"})
    const [failed, captured] = ofKind("photo_operation")
    expect(failed.payload).toEqual({stage: "failed", failedStage: "requested"})
    expect(captured.payload).toEqual({stage: "captured"})
  })

  test("a photo with no glasses known is not recorded", () => {
    start()
    fleetEvents.photo({operationId: "req-1", stage: "requested"})
    expect(ofKind("photo_operation")).toHaveLength(0)
  })

  test("an operation ID the contract would refuse is not recorded", () => {
    connectLive()
    start()
    fleetEvents.photo({operationId: "has spaces", stage: "requested"})
    fleetEvents.photo({operationId: "x".repeat(129), stage: "requested"})
    fleetEvents.photo({operationId: "", stage: "requested"})
    expect(ofKind("photo_operation")).toHaveLength(0)
  })

  test("a photo taken just as the glasses disconnect still has the binding they had", () => {
    connectLive()
    start()
    disconnectLive()
    fleetEvents.photo({operationId: "req-5", stage: "failed", failedStage: "requested"})
    expect(ofKind("photo_operation")[0].deviceBinding).toMatchObject({kind: "serial", serial: "SN-LIVE-1"})
  })
})

// --- safety -----------------------------------------------------------------------------------------------------

describe("failures stay inside Fleet", () => {
  test("a queue that cannot store anything never throws into a caller", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const broken = {
      enqueue: () => {
        throw new Error("disk full")
      },
      nextSequence: () => {
        throw new Error("disk full")
      },
    } as unknown as ReturnType<typeof createFleetQueue>
    const fragile = createFleetCollector({queue: broken, now: () => clock.wall, monotonic: () => clock.mono})
    try {
      expect(() => fragile.start({partition: PARTITION, collectorSessionId: SESSION})).not.toThrow()
      expect(() => connectLive()).not.toThrow()
      expect(() => miniappRunningRegistry.add("com.a")).not.toThrow()
      expect(() => setAppState("active")).not.toThrow()
      expect(() => fleetEvents.launch({packageName: "com.a", start: "user", outcome: "started"})).not.toThrow()
      expect(() => fleetEvents.photo({operationId: "r1", stage: "requested"})).not.toThrow()
      expect(() => advance(2 * 60_000)).not.toThrow()
      expect(() => fragile.flushCheckpoint()).not.toThrow()
      expect(() => fragile.stop("engine_stopped")).not.toThrow()
    } finally {
      fragile.stop("engine_stopped")
      warn.mockRestore()
    }
  })

  test("a glasses store in a shape nobody expected never throws into whoever updates it", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      start()
      expect(() => glassesStore.setState({connection: undefined as never})).not.toThrow()
      expect(() =>
        glassesStore.setState({connection: {state: "connected"}, deviceModel: undefined as never}),
      ).not.toThrow()
      expect(() => glassesStore.setState({...GLASSES_IDLE})).not.toThrow()
      collector.flushCheckpoint()
      expect(checkpoints().length).toBeGreaterThan(0)
    } finally {
      warn.mockRestore()
    }
  })

  test("a failing clock never throws into a caller", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const bad = createFleetCollector({
      queue,
      now: () => Number.NaN,
      monotonic: () => clock.mono,
    })
    try {
      expect(() => bad.start({partition: PARTITION, collectorSessionId: SESSION})).not.toThrow()
      expect(() => fleetEvents.launch({packageName: "com.a", start: "user", outcome: "started"})).not.toThrow()
      expect(() => advance(2 * 60_000)).not.toThrow()
    } finally {
      bad.stop("engine_stopped")
      warn.mockRestore()
    }
  })

  test("what a warning says about a failure never includes the data", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const broken = {
      enqueue: () => {
        throw new Error("disk full")
      },
      nextSequence: () => 0,
    } as unknown as ReturnType<typeof createFleetQueue>
    const fragile = createFleetCollector({queue: broken, now: () => clock.wall, monotonic: () => clock.mono})
    try {
      connectLive()
      fragile.start({partition: PARTITION, collectorSessionId: SESSION})
      fleetEvents.launch({packageName: "com.secret.package", start: "user", outcome: "started"})
      const logged = JSON.stringify(warn.mock.calls)
      expect(logged).not.toContain("com.secret.package")
      expect(logged).not.toContain("SN-LIVE-1")
    } finally {
      fragile.stop("engine_stopped")
      warn.mockRestore()
    }
  })
})

describe("what Fleet reads", () => {
  const folder = new URL("..", import.meta.url)
  const sources = readdirSync(folder).filter((name) => name.endsWith(".ts"))

  test("the folder has sources to check", () => {
    expect(sources).toContain("fleetCollector.ts")
  })

  test.each(["deploymentStore", "isTelemetryAllowed", "posthog", "SupportProfileSync", "supportProfile"])(
    "nothing in the Fleet sources refers to %s",
    (forbidden) => {
      for (const name of sources) {
        const text = readFileSync(new URL(name, folder), "utf8")
        expect({file: name, found: text.toLowerCase().includes(forbidden.toLowerCase())}).toEqual({
          file: name,
          found: false,
        })
      }
    },
  )
})
