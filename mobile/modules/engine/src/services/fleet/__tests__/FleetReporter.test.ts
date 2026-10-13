/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import {readdirSync, readFileSync} from "node:fs"
import {FleetRecordSchema, type FleetRecord, type FleetReport} from "@mentra/cloud-protocol"
import {create} from "zustand"
import {subscribeWithSelector} from "zustand/middleware"

import {cloudClientService} from "../../__tests__/cloudClientServiceTestMock"
import {reactNative, reactNativeAppState} from "../../__tests__/reactNativeTestMock"
import type {CoreSession, CoreSessionChange, FleetSendOutcome} from "../../CloudClientService"
import {fakeCreateMMKV, resetFakeMmkv} from "./fakeMmkv"
import {MemoryFleetStore} from "./memoryFleetStore"

// --- fakes ------------------------------------------------------------------------------------------------------

/** Wall clock and monotonic clock, advanced together. */
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
  timers.set(id, {id, at: clock.mono + Math.max(0, delay), every, run})
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
mock.module("react-native-mmkv", () => ({createMMKV: fakeCreateMMKV}))
mock.module("expo-constants", () => ({
  default: {nativeAppVersion: "3.4.5", nativeBuildVersion: "345", expoConfig: {version: "3.4.5"}},
}))
mock.module("expo-device", () => ({modelName: "Pixel 9"}))

const GLASSES_IDLE = {
  connection: {state: "disconnected"} as {state: string; fullyBooted?: boolean},
  deviceModel: "",
  serialNumber: "",
  bluetoothMacAddress: "",
  leftMacAddress: "",
  bluetoothName: "",
  appVersion: "",
  buildNumber: "",
  mtkFirmwareVersion: "",
  besFirmwareVersion: "",
  androidVersion: "",
  firmwareVersion: "",
  batteryLevel: -1,
  charging: false,
}
const glassesStore = create<typeof GLASSES_IDLE>()(subscribeWithSelector(() => ({...GLASSES_IDLE})))
mock.module("../../../stores/glasses", () => ({useGlassesStore: glassesStore}))

const appStateListeners = new Set<(state: string) => void>()
function setAppState(state: string): void {
  reactNativeAppState.currentState = state
  for (const listener of [...appStateListeners]) listener(state)
}

const {createFleetQueue, partitionKey} = await import("../fleetQueue")
type FleetQueue = ReturnType<typeof createFleetQueue>
const {createFleetCollector} = await import("../fleetCollector")
type FleetCollector = ReturnType<typeof createFleetCollector>
const {fleetEvents} = await import("../fleetEvents")
const {miniappRunningRegistry} = await import("../../MiniappRunningRegistry")
const {backoffDelayMs, createFleetReporter} = await import("../FleetReporter")

// --- the phone's Core client --------------------------------------------------------------------------------------

const CORE_X = "https://core.x.example"
const CORE_Y = "https://core.y.example"
const A = "user-a"
const B = "user-b"

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

type Expected = {coreUrl: string; mentraUserId: string}
interface Call {
  /** Who the reporter asked to send as. */
  as: Expected
  records: FleetRecord[]
  signal?: AbortSignal
  at: number
  /** Who the client spoke for when the reporter asked. */
  clientSession: CoreSession | null
}

/**
 * The engine's Core client as the reporter sees it. `session` is who the client speaks for. `reportAs` behaves like
 * the real guard: a request as anyone else is refused without sending. `calls` is every request the reporter made;
 * `sent` is the ones that went out.
 */
const core = {
  session: {coreUrl: CORE_X, mentraUserId: A} as CoreSession | null,
  listeners: new Set<(change: CoreSessionChange) => void>(),
  calls: [] as Call[],
  sent: [] as Call[],
  respond: ((records: FleetRecord[]) => acceptAll(records)) as (
    records: FleetRecord[],
    call: Call,
  ) => FleetSendOutcome | Promise<FleetSendOutcome>,
}

function installFakeCloud(): void {
  Object.assign(cloudClientService, {
    getCoreSession: () => (core.session ? {...core.session} : null),
    resolveCoreSession: async () => (core.session ? {...core.session} : null),
    onCoreSessionChanged: (listener: (change: CoreSessionChange) => void) => {
      core.listeners.add(listener)
      return () => {
        core.listeners.delete(listener)
      }
    },
    core: {
      fleet: {
        reportAs: async (expected: Expected, batch: FleetReport, opts?: {signal?: AbortSignal}) => {
          const call: Call = {
            as: {...expected},
            records: batch.records,
            signal: opts?.signal,
            at: clock.wall,
            clientSession: core.session ? {...core.session} : null,
          }
          core.calls.push(call)
          if (
            !core.session ||
            core.session.coreUrl !== expected.coreUrl ||
            core.session.mentraUserId !== expected.mentraUserId
          ) {
            return {kind: "session_changed"}
          }
          core.sent.push(call)
          return core.respond(batch.records, call)
        },
      },
    },
  })
}

function emit(change: CoreSessionChange): void {
  for (const listener of [...core.listeners]) listener(change)
}
function signOut(): void {
  core.session = core.session ? {coreUrl: core.session.coreUrl, mentraUserId: null} : null
  emit({reason: "signed_out", coreUrl: core.session?.coreUrl ?? null, mentraUserId: null})
}
/** The real event carries no identity yet (the engine forgot it); the reporter must resolve it. */
function signIn(user: string, coreUrl = core.session?.coreUrl ?? CORE_X): void {
  core.session = {coreUrl, mentraUserId: user}
  emit({reason: "signed_in", coreUrl, mentraUserId: null})
}
function reconnectTo(coreUrl: string): void {
  core.session = {coreUrl, mentraUserId: core.session?.mentraUserId ?? null}
  emit({reason: "reconnect", coreUrl, mentraUserId: core.session.mentraUserId})
}

type ResultStatus = "accepted" | "duplicate" | "retryable" | "rejected"
type ResultSpec =
  | ResultStatus
  | {status: ResultStatus; retryAfterSeconds?: number; reasonCode?: "outside_replay_window" | "schema_invalid"}

function answer(records: FleetRecord[], specs: ResultSpec[]): FleetSendOutcome {
  return {
    kind: "results",
    ack: {
      schemaVersion: 1,
      results: records.map((record, index) => {
        const spec = specs[index] ?? "accepted"
        const {status, ...rest} = typeof spec === "string" ? {status: spec} : spec
        return {
          index,
          recordId: record.recordId,
          status,
          ...rest,
          ...(status === "rejected" && !("reasonCode" in rest) ? {reasonCode: "schema_invalid" as const} : {}),
        }
      }),
    },
  }
}
function acceptAll(records: FleetRecord[]): FleetSendOutcome {
  return answer(records, [])
}
const unavailable = (retryAfterSeconds: number | null = null): FleetSendOutcome => ({
  kind: "unavailable",
  retryAfterSeconds,
})

// --- a collector the tests drive ------------------------------------------------------------------------------------

interface StubCollector extends FleetCollector {
  queue: FleetQueue
  runs: Array<{partition: string; collectorSessionId: string}>
  stops: string[]
  flushes: number
  active: {partition: string; collectorSessionId: string} | null
}

function stubCollector(queue: FleetQueue): StubCollector {
  const stub: StubCollector = {
    queue,
    runs: [],
    stops: [],
    flushes: 0,
    active: null,
    start(ctx) {
      stub.runs.push({...ctx})
      stub.active = {...ctx}
    },
    stop(reason) {
      if (!stub.active) return
      stub.stops.push(reason)
      stub.active = null
    },
    flushCheckpoint() {
      stub.flushes += 1
    },
  }
  return stub
}

// --- harness ----------------------------------------------------------------------------------------------------

let store: MemoryFleetStore
let queue: FleetQueue
let collector: StubCollector
let random: () => number
let reporter: ReturnType<typeof createFleetReporter>
/** Where each test record was queued, so every request can be checked against its partition. */
const origin = new Map<string, string>()
let recordCounter = 0

function iso(wall: number): string {
  return new Date(wall).toISOString()
}

function launchRecord(observedAt = iso(clock.wall)): FleetRecord {
  recordCounter += 1
  return {
    schemaVersion: 1,
    recordId: `REC-${String(recordCounter).padStart(6, "0")}`,
    phoneDeviceId: "PHONE-1",
    collectorSessionId: "SESSION-T",
    sequence: recordCounter,
    observedAt,
    capabilities: ["engine_active"],
    kind: "miniapp_launch",
    payload: {packageName: "com.example.app", start: "user", outcome: "started"},
  }
}

/** The collector records `count` observations in the partition it is running in, through the reporter's queue. */
function observe(count: number, observedAt?: string): FleetRecord[] {
  const active = collector.active
  if (!active) throw new Error("the collector is not running")
  const records: FleetRecord[] = []
  for (let i = 0; i < count; i += 1) {
    const record = launchRecord(observedAt)
    origin.set(record.recordId, active.partition)
    collector.queue.enqueue(active.partition, record)
    records.push(record)
  }
  return records
}

/** Records waiting for an account on a Core, straight from the queue. */
function queued(coreUrl: string, user: string): FleetRecord[] {
  return queue.nextBatch(partitionKey(coreUrl, user), 100_000, Number.MAX_SAFE_INTEGER)
}
const ids = (records: FleetRecord[]) => records.map((record) => record.recordId)

/** Lets every pending promise and continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** Moves both clocks forward, running each timer that falls due, in order, and letting its work finish. */
async function advance(ms: number): Promise<void> {
  const target = clock.mono + ms
  await settle()
  for (let fired = 0; ; fired += 1) {
    // A reporter that keeps rescheduling itself at once would spin forever on a real phone too.
    if (fired > 5_000) throw new Error("timers keep firing without time passing")
    const due = [...timers.values()].filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
    if (!due) break
    clock.wall += due.at - clock.mono
    clock.mono = due.at
    if (due.every === null) timers.delete(due.id)
    else due.at += due.every
    due.run()
    await settle()
  }
  clock.wall += target - clock.mono
  clock.mono = target
  await settle()
}

/** Runs timers until the reporter makes another request; returns how long that took. */
async function untilNextCall(limit = 2 * HOUR): Promise<number> {
  const before = core.calls.length
  const started = clock.wall
  while (core.calls.length === before) {
    const next = [...timers.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0]
    if (!next || next.at - clock.mono > limit) throw new Error("no further request is scheduled")
    await advance(next.at - clock.mono)
  }
  return core.calls[core.calls.length - 1].at - started
}

function makeReporter(createCollector?: (queue: FleetQueue) => FleetCollector): ReturnType<typeof createFleetReporter> {
  return createFleetReporter({
    queue,
    now: () => clock.wall,
    random: () => random(),
    createCollector:
      createCollector ??
      ((q) => {
        collector = stubCollector(q)
        return collector
      }),
  })
}

beforeEach(() => {
  clock.wall = Date.UTC(2026, 9, 13, 12, 0, 0)
  clock.mono = 50_000
  timers.clear()
  resetFakeMmkv()
  origin.clear()
  core.session = {coreUrl: CORE_X, mentraUserId: A}
  core.listeners.clear()
  core.calls = []
  core.sent = []
  core.respond = (records) => acceptAll(records)
  installFakeCloud()
  glassesStore.setState({...GLASSES_IDLE}, true)
  for (const packageName of miniappRunningRegistry.getAll()) miniappRunningRegistry.remove(packageName)
  Object.assign(reactNative.Platform as object, {OS: "android", Version: 35, constants: {Release: "15"}})
  appStateListeners.clear()
  reactNativeAppState.currentState = "active"
  reactNativeAppState.addEventListener = ((_type: string, listener: (state: string) => void) => {
    appStateListeners.add(listener)
    return {remove: () => appStateListeners.delete(listener)}
  }) as never
  store = new MemoryFleetStore()
  queue = createFleetQueue(store, {now: () => clock.wall})
  random = () => 0.5
  reporter = makeReporter()
})

afterEach(async () => {
  await reporter.stop()
  // Isolation, for every test: the reporter only ever asked to send as the account the client spoke for, and each
  // record it put in a request was queued in that account's partition on that Core.
  for (const call of core.calls) {
    expect(call.as).toEqual(call.clientSession as Expected)
    const partition = partitionKey(call.as.coreUrl, call.as.mentraUserId)
    for (const record of call.records) {
      const from = origin.get(record.recordId)
      if (from !== undefined)
        expect({record: record.recordId, partition: from}).toEqual({record: record.recordId, partition})
    }
  }
})

// --- tests ------------------------------------------------------------------------------------------------------

describe("starting", () => {
  test("starts the collector at once, in the account's partition on its Core, with a new session, and flushes once", () => {
    reporter.start()
    expect(collector.runs).toEqual([{partition: partitionKey(CORE_X, A), collectorSessionId: expect.any(String)}])
    expect(collector.runs[0].collectorSessionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(collector.flushes).toBe(1)
  })

  test("every start is a new collector session", async () => {
    reporter.start()
    await reporter.stop()
    reporter.start()
    expect(collector.runs).toHaveLength(2)
    expect(collector.runs[1].collectorSessionId).not.toBe(collector.runs[0].collectorSessionId)
    expect(collector.runs[1].partition).toBe(collector.runs[0].partition)
  })

  test("start is idempotent and stop without start is harmless", async () => {
    await reporter.stop()
    reporter.start()
    reporter.start()
    expect(collector.runs).toHaveLength(1)
    expect(core.listeners.size).toBe(1)
  })

  test("without an account it collects nothing until a sign-in", async () => {
    core.session = {coreUrl: CORE_X, mentraUserId: null}
    reporter.start()
    await advance(10 * MINUTE)
    expect(collector.runs).toEqual([])
    expect(core.calls).toEqual([])
    signIn(A)
    await settle()
    expect(collector.runs.map((run) => run.partition)).toEqual([partitionKey(CORE_X, A)])
  })

  test("without a Core it collects nothing", async () => {
    core.session = null
    reporter.start()
    await advance(10 * MINUTE)
    expect(collector.runs).toEqual([])
  })

  test("an account that is only known once the token arrives still starts collection", async () => {
    cloudClientService.getCoreSession = () => ({coreUrl: CORE_X, mentraUserId: null})
    reporter.start()
    expect(collector.runs).toEqual([])
    await settle()
    expect(collector.runs.map((run) => run.partition)).toEqual([partitionKey(CORE_X, A)])
  })

  test("sweeps expired partitions at start, then at most hourly", async () => {
    const sweep = spyOn(queue, "sweepExpired")
    reporter.start()
    expect(sweep).toHaveBeenCalledTimes(1)
    observe(1)
    await advance(59 * MINUTE)
    expect(sweep).toHaveBeenCalledTimes(1)
    await advance(MINUTE)
    expect(sweep).toHaveBeenCalledTimes(2)
    await advance(59 * MINUTE)
    expect(sweep).toHaveBeenCalledTimes(2)
    await advance(MINUTE)
    expect(sweep).toHaveBeenCalledTimes(3)
  })
})

describe("uploading", () => {
  test("sends a minute after records arrive, as the account to its Core, and removes accepted and duplicate records", async () => {
    reporter.start()
    const records = observe(3)
    core.respond = (rs) => answer(rs, ["accepted", "duplicate", "accepted"])
    await advance(MINUTE - 1)
    expect(core.calls).toHaveLength(0)
    await advance(1)
    expect(core.calls).toHaveLength(1)
    expect(core.calls[0].as).toEqual({coreUrl: CORE_X, mentraUserId: A})
    expect(ids(core.calls[0].records)).toEqual(ids(records))
    expect(queued(CORE_X, A)).toEqual([])
  })

  test("an empty queue sends nothing", async () => {
    reporter.start()
    await advance(3 * HOUR)
    expect(core.calls).toEqual([])
  })

  test("100 queued records go at once, without waiting for the minute", async () => {
    reporter.start()
    observe(99)
    await advance(10 * SECOND)
    expect(core.calls).toHaveLength(0)
    observe(1)
    await advance(0)
    expect(core.calls).toHaveLength(1)
    expect(core.calls[0].records).toHaveLength(100)
  })

  test("a backlog drains 500 records at a time, at most 1 MB of them", async () => {
    const partition = partitionKey(CORE_X, A)
    for (let i = 0; i < 1_200; i += 1) {
      const record = launchRecord()
      origin.set(record.recordId, partition)
      queue.enqueue(partition, record)
    }
    const nextBatch = spyOn(queue, "nextBatch")
    reporter.start()
    await advance(0)
    expect(core.calls.map((call) => call.records.length)).toEqual([500, 500, 200])
    for (const args of nextBatch.mock.calls) {
      expect(args[0]).toBe(partition)
      expect(args[1]).toBeLessThanOrEqual(500)
      expect(args[2]).toBeLessThanOrEqual(1_000_000)
    }
    expect(queued(CORE_X, A)).toEqual([])
  })

  test("a retryable record stays queued and is retried after its Retry-After", async () => {
    reporter.start()
    const [kept] = observe(2)
    core.respond = (rs) => answer(rs, [{status: "retryable", retryAfterSeconds: 120}, "accepted"])
    await advance(MINUTE)
    expect(ids(queued(CORE_X, A))).toEqual([kept.recordId])
    core.respond = (rs) => acceptAll(rs)
    await advance(120 * SECOND - 1)
    expect(core.calls).toHaveLength(1)
    await advance(1)
    expect(core.calls).toHaveLength(2)
    expect(ids(core.calls[1].records)).toEqual([kept.recordId])
    expect(queued(CORE_X, A)).toEqual([])
  })

  test("a record the answer does not mention stays queued", async () => {
    reporter.start()
    const [first, second] = observe(2)
    core.respond = () => ({
      kind: "results",
      ack: {schemaVersion: 1, results: [{index: 0, recordId: first.recordId, status: "accepted"}]},
    })
    await advance(MINUTE)
    expect(ids(queued(CORE_X, A))).toEqual([second.recordId])
  })

  test("a result whose record ID does not match its index changes nothing", async () => {
    reporter.start()
    const records = observe(2)
    core.respond = () => ({
      kind: "results",
      ack: {schemaVersion: 1, results: [{index: 0, recordId: records[1].recordId, status: "accepted"}]},
    })
    await advance(MINUTE)
    expect(ids(queued(CORE_X, A))).toEqual(ids(records))
  })

  test("an answer that settles nothing counts as no answer, so a large queue backs off instead of spinning", async () => {
    reporter.start()
    observe(150)
    core.respond = () => ({kind: "results", ack: {schemaVersion: 1, results: []}})
    expect(await untilNextCall()).toBe(0)
    expect(await untilNextCall()).toBe(30 * SECOND)
    expect(await untilNextCall()).toBe(60 * SECOND)
    expect(queued(CORE_X, A)).toHaveLength(150)
  })

  test("a rejected record is removed, and a record_rejected gap covers its observation time", async () => {
    reporter.start()
    const observedAt = "2026-10-01T08:00:00.000Z"
    const [rejected] = observe(1, observedAt)
    core.respond = (rs) => answer(rs, [{status: "rejected", reasonCode: "outside_replay_window"}])
    await advance(MINUTE)
    const left = queued(CORE_X, A)
    expect(left.map((record) => record.recordId)).not.toContain(rejected.recordId)
    expect(left).toHaveLength(1)
    const gap = FleetRecordSchema.parse(left[0])
    expect(gap).toMatchObject({
      kind: "coverage_gap",
      collectorSessionId: collector.runs[0].collectorSessionId,
      observedAt: iso(clock.wall),
      payload: {reason: "record_rejected", from: observedAt, to: observedAt, droppedRecordCount: 1},
    })
  })

  test("a rejected gap is dropped without a further gap, so rejection cannot loop", async () => {
    reporter.start()
    observe(1)
    core.respond = (rs) =>
      answer(
        rs,
        rs.map(() => ({status: "rejected" as const, reasonCode: "schema_invalid" as const})),
      )
    await advance(MINUTE)
    expect(queued(CORE_X, A).map((record) => record.kind)).toEqual(["coverage_gap"])
    await advance(MINUTE)
    expect(queued(CORE_X, A)).toEqual([])
    await advance(HOUR)
    expect(core.calls).toHaveLength(2)
  })
})

describe("not installed", () => {
  test("stops collection, clears the partition, and probes again only after a sign-in", async () => {
    reporter.start()
    observe(3)
    core.respond = () => ({kind: "not_installed"})
    await advance(MINUTE)
    expect(collector.stops).toEqual(["not_installed"])
    const partition = partitionKey(CORE_X, A)
    expect(store.keys().filter((key) => key.includes(partition))).toEqual([])

    await advance(3 * HOUR)
    expect(core.calls).toHaveLength(1)
    // A rebuilt client for the same account on the same Core is not a new authenticated session.
    reconnectTo(CORE_X)
    await advance(HOUR)
    expect(collector.runs).toHaveLength(1)
    expect(core.calls).toHaveLength(1)

    core.respond = (rs) => acceptAll(rs)
    signIn(A)
    await settle()
    expect(collector.runs).toHaveLength(2)
    expect(collector.runs[1].partition).toBe(partition)
    expect(collector.runs[1].collectorSessionId).not.toBe(collector.runs[0].collectorSessionId)
    observe(1)
    await advance(MINUTE)
    expect(core.calls).toHaveLength(2)
  })

  test("the next engine start probes again", async () => {
    reporter.start()
    observe(1)
    core.respond = () => ({kind: "not_installed"})
    await advance(MINUTE)
    await reporter.stop()
    reporter.start()
    expect(collector.runs).toHaveLength(2)
    observe(1)
    await advance(MINUTE)
    expect(core.calls).toHaveLength(2)
  })

  test("another Core is collected for even while this one has no Fleet", async () => {
    reporter.start()
    observe(1)
    core.respond = () => ({kind: "not_installed"})
    await advance(MINUTE)
    reconnectTo(CORE_Y)
    await settle()
    expect(collector.runs.map((run) => run.partition)).toEqual([partitionKey(CORE_X, A), partitionKey(CORE_Y, A)])
  })
})

describe("backing off", () => {
  test("the backoff is min(30 min, 30 s * 2^n) with 20% jitter either way", () => {
    for (let n = 0; n < 20; n += 1) {
      const base = Math.min(30 * MINUTE, 30 * SECOND * 2 ** n)
      expect(backoffDelayMs(n, () => 0)).toBe(Math.round(base * 0.8))
      expect(backoffDelayMs(n, () => 0.5)).toBe(base)
      expect(backoffDelayMs(n, () => 0.999_999)).toBeLessThanOrEqual(base * 1.2)
      expect(backoffDelayMs(n, () => 0.999_999)).toBeGreaterThan(base * 1.19)
    }
  })

  test("unavailable keeps the queue and backs off with growing, jittered delays up to 30 minutes", async () => {
    const draws = [0, 0.999_999, 0.25, 0.75, 0, 0.999_999, 0.5, 0, 0.999_999, 0.3]
    const used = [...draws]
    random = () => draws.shift() ?? 0.5
    reporter.start()
    observe(2)
    core.respond = () => unavailable()
    await advance(MINUTE)
    for (let n = 0; n < used.length; n += 1) {
      const waited = await untilNextCall()
      const base = Math.min(30 * MINUTE, 30 * SECOND * 2 ** n)
      expect(waited).toBe(Math.round(base * (0.8 + 0.4 * used[n])))
      expect(waited).toBeGreaterThanOrEqual(base * 0.8)
      expect(waited).toBeLessThanOrEqual(base * 1.2)
    }
    expect(queued(CORE_X, A)).toHaveLength(2)
  })

  test("Retry-After is honored as given, capped at 30 minutes, and 0 counts as an answer", async () => {
    reporter.start()
    observe(1)
    core.respond = () => unavailable(45)
    await advance(MINUTE)
    core.respond = () => unavailable(7_200)
    expect(await untilNextCall()).toBe(45 * SECOND)
    core.respond = () => unavailable(0)
    expect(await untilNextCall()).toBe(30 * MINUTE)
    core.respond = () => unavailable()
    const afterZero = await untilNextCall()
    // Not the exponential backoff, which would be at least 0.8 * 30 s * 2^3 by now.
    expect(afterZero).toBe(SECOND)
    expect(queued(CORE_X, A)).toHaveLength(1)
  })

  test("a results answer resets the backoff", async () => {
    random = () => 0.5
    reporter.start()
    observe(1)
    core.respond = () => unavailable()
    await advance(MINUTE)
    expect(await untilNextCall()).toBe(30 * SECOND)
    expect(await untilNextCall()).toBe(60 * SECOND)
    core.respond = (rs) => acceptAll(rs)
    expect(await untilNextCall()).toBe(120 * SECOND)
    observe(1)
    core.respond = () => unavailable()
    expect(await untilNextCall()).toBe(MINUTE)
    expect(await untilNextCall()).toBe(30 * SECOND)
  })

  test("forbidden keeps the queue and waits about 30 minutes", async () => {
    random = () => 0
    reporter.start()
    observe(1)
    core.respond = () => ({kind: "forbidden"})
    await advance(MINUTE)
    // The wait after each answer is drawn when the answer arrives.
    random = () => 0.999_999
    expect(await untilNextCall()).toBe(24 * MINUTE)
    const waited = await untilNextCall(3 * HOUR)
    expect(waited).toBeGreaterThan(35 * MINUTE)
    expect(waited).toBeLessThanOrEqual(36 * MINUTE)
    expect(queued(CORE_X, A)).toHaveLength(1)
  })

  test("an authentication failure never discards records and backs off", async () => {
    reporter.start()
    const records = observe(2)
    core.respond = () => ({kind: "unauthorized"})
    await advance(MINUTE)
    expect(ids(queued(CORE_X, A))).toEqual(ids(records))
    expect(await untilNextCall()).toBe(30 * SECOND)
    expect(await untilNextCall()).toBe(60 * SECOND)
    expect(ids(queued(CORE_X, A))).toEqual(ids(records))
  })

  test("the loop survives an unexpected failure", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      reporter.start()
      observe(1)
      core.respond = () => {
        throw new Error("unexpected")
      }
      await advance(MINUTE)
      const nextBatch = spyOn(queue, "nextBatch").mockImplementationOnce(() => {
        throw new Error("storage")
      })
      // 30 s to the attempt the storage failure stops before sending, then 60 s to the next.
      expect(await untilNextCall()).toBe(30 * SECOND + 60 * SECOND)
      expect(nextBatch).toHaveBeenCalled()
      core.respond = (rs) => acceptAll(rs)
      await untilNextCall()
      expect(queued(CORE_X, A)).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })
})

describe("batch size", () => {
  test("a 413 halves the batch until it fits, and the size grows back", async () => {
    reporter.start()
    const records = observe(8)
    core.respond = (rs) => (rs.length > 2 ? {kind: "batch_too_large"} : acceptAll(rs))
    await advance(MINUTE)
    expect(core.calls.map((call) => call.records.length)).toEqual([8, 4, 2])
    await advance(10 * MINUTE)
    // Each success doubles the limit again (2 -> 4), which this Core refuses once more.
    expect(core.calls.map((call) => call.records.length).slice(3)).toEqual([4, 2, 4, 2, 2])
    expect(queued(CORE_X, A)).toEqual([])
    expect(new Set(core.sent.filter((c) => c.records.length <= 2).flatMap((c) => ids(c.records)))).toEqual(
      new Set(ids(records)),
    )
  })

  test("a single record still too large is removed with a record_rejected gap", async () => {
    reporter.start()
    const [big, small] = observe(2)
    core.respond = (rs) => (ids(rs).includes(big.recordId) ? {kind: "batch_too_large"} : acceptAll(rs))
    await advance(MINUTE)
    expect(core.calls.map((call) => call.records.length)).toEqual([2, 1])
    const left = queued(CORE_X, A)
    expect(ids(left)).toEqual([small.recordId, expect.any(String)])
    expect(left[1]).toMatchObject({
      kind: "coverage_gap",
      payload: {reason: "record_rejected", from: big.observedAt, to: big.observedAt},
    })
    // One record per request now, doubling again with each success.
    await advance(5 * MINUTE)
    expect(core.calls.map((call) => call.records.length).slice(2)).toEqual([1, 1])
    expect(queued(CORE_X, A)).toEqual([])
  })

  test("batch_invalid halves like a 413; a single refused record is removed with a gap, and it is logged once", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      reporter.start()
      const [okA, okB, bad, okC] = observe(4)
      core.respond = (rs) =>
        ids(rs).includes(bad.recordId) ? {kind: "batch_invalid", code: "invalid_batch"} : acceptAll(rs)
      await advance(MINUTE)
      expect(core.calls.map((call) => ids(call.records))).toEqual([ids([okA, okB, bad, okC]), ids([okA, okB])])
      await advance(MINUTE)
      expect(core.calls.map((call) => call.records.length).slice(2)).toEqual([2, 1])
      const left = queued(CORE_X, A)
      expect(ids(left)).not.toContain(bad.recordId)
      expect(left.map((record) => record.kind)).toEqual(["miniapp_launch", "coverage_gap"])
      expect(left[1]).toMatchObject({payload: {reason: "record_rejected", from: bad.observedAt, to: bad.observedAt}})
      await advance(5 * MINUTE)
      expect(queued(CORE_X, A)).toEqual([])
      const logged = warn.mock.calls.filter((args) => args.join(" ").includes("invalid_batch"))
      expect(logged).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe("queue losses", () => {
  test("drops and expiries become one coverage gap, queued in the same tick as takeLosses", async () => {
    reporter.start()
    observe(1)
    const seenInSameTick: boolean[] = []
    spyOn(queue, "takeLosses").mockImplementationOnce(() => {
      queueMicrotask(() => seenInSameTick.push(queued(CORE_X, A).some((record) => record.kind === "coverage_gap")))
      return {dropped: 3, expired: 2, from: "2026-10-12T01:00:00.000Z", to: "2026-10-12T02:00:00.000Z"}
    })
    await advance(MINUTE)
    expect(seenInSameTick).toEqual([true])
    const gaps = core.calls.flatMap((call) => call.records).filter((record) => record.kind === "coverage_gap")
    expect(gaps).toHaveLength(1)
    expect(FleetRecordSchema.parse(gaps[0])).toMatchObject({
      collectorSessionId: collector.runs[0].collectorSessionId,
      payload: {
        reason: "queue_dropped",
        from: "2026-10-12T01:00:00.000Z",
        to: "2026-10-12T02:00:00.000Z",
        droppedRecordCount: 5,
      },
    })
  })

  test("expiries alone are queue_expired", async () => {
    reporter.start()
    observe(1)
    spyOn(queue, "takeLosses").mockImplementationOnce(() => ({
      dropped: 0,
      expired: 4,
      from: "2026-10-05T01:00:00.000Z",
      to: "2026-10-06T02:00:00.000Z",
    }))
    await advance(MINUTE)
    const gap = core.calls[0].records.find((record) => record.kind === "coverage_gap")
    expect(gap).toMatchObject({payload: {reason: "queue_expired", droppedRecordCount: 4}})
  })

  test("a loss with no readable observation time covers the 7 days before now", async () => {
    reporter.start()
    observe(1)
    spyOn(queue, "takeLosses").mockImplementationOnce(() => ({dropped: 2, expired: 0, from: null, to: null}))
    await advance(MINUTE)
    const gap = core.calls[0].records.find((record) => record.kind === "coverage_gap")
    expect(gap).toMatchObject({
      payload: {reason: "queue_dropped", from: iso(clock.wall - 7 * DAY), to: iso(clock.wall), droppedRecordCount: 2},
    })
  })

  test("records that expired while the engine was stopped come back as a gap at the next start", async () => {
    reporter.start()
    const [old] = observe(1)
    core.respond = () => unavailable()
    await advance(MINUTE)
    await reporter.stop()
    clock.wall += 8 * DAY
    core.respond = (rs) => acceptAll(rs)
    reporter.start()
    observe(1)
    await advance(MINUTE)
    const gap = core.calls.at(-1)!.records.find((record) => record.kind === "coverage_gap")
    expect(gap).toMatchObject({
      payload: {reason: "queue_expired", from: old.observedAt, to: old.observedAt, droppedRecordCount: 1},
    })
    expect(ids(core.calls.at(-1)!.records)).not.toContain(old.recordId)
  })
})

describe("account isolation", () => {
  test("A's records are never sent while B is signed in, and go out once A signs in again", async () => {
    reporter.start()
    const fromA = observe(3)
    core.respond = () => unavailable()
    await advance(MINUTE)

    signOut()
    expect(collector.stops).toEqual(["account_changed"])
    await advance(HOUR)
    signIn(B)
    await settle()
    expect(collector.active?.partition).toBe(partitionKey(CORE_X, B))
    core.respond = (rs) => acceptAll(rs)
    const fromB = observe(2)
    const callsBefore = core.calls.length
    await advance(2 * HOUR)
    const whileB = core.calls.slice(callsBefore)
    expect(whileB.length).toBeGreaterThan(0)
    for (const call of whileB) {
      expect(call.as).toEqual({coreUrl: CORE_X, mentraUserId: B})
      for (const id of ids(fromA)) expect(ids(call.records)).not.toContain(id)
    }
    expect(ids(whileB.flatMap((call) => call.records))).toEqual(expect.arrayContaining(ids(fromB)))
    expect(ids(queued(CORE_X, A))).toEqual(ids(fromA))

    signOut()
    signIn(A)
    await settle()
    await advance(MINUTE)
    const last = core.calls.at(-1)!
    expect(last.as).toEqual({coreUrl: CORE_X, mentraUserId: A})
    expect(ids(last.records)).toEqual(expect.arrayContaining(ids(fromA)))
    expect(queued(CORE_X, A)).toEqual([])
  })

  test("a Core switch keeps each Core's records for that Core", async () => {
    reporter.start()
    const onX = observe(2)
    core.respond = () => unavailable()
    await advance(MINUTE)

    reconnectTo(CORE_Y)
    expect(collector.stops).toEqual(["account_changed"])
    await settle()
    expect(collector.active?.partition).toBe(partitionKey(CORE_Y, A))
    core.respond = (rs) => acceptAll(rs)
    const onY = observe(2)
    const callsBefore = core.calls.length
    await advance(2 * HOUR)
    const whileY = core.calls.slice(callsBefore)
    expect(whileY.length).toBeGreaterThan(0)
    for (const call of whileY) {
      expect(call.as).toEqual({coreUrl: CORE_Y, mentraUserId: A})
      for (const id of ids(onX)) expect(ids(call.records)).not.toContain(id)
    }
    expect(ids(whileY.flatMap((call) => call.records))).toEqual(expect.arrayContaining(ids(onY)))
    expect(ids(queued(CORE_X, A))).toEqual(ids(onX))

    reconnectTo(CORE_X)
    await settle()
    await advance(MINUTE)
    expect(core.calls.at(-1)!.as).toEqual({coreUrl: CORE_X, mentraUserId: A})
    expect(queued(CORE_X, A)).toEqual([])
  })

  test("an upload in flight when the account changes is abandoned and its late answer changes nothing", async () => {
    reporter.start()
    const records = observe(2)
    let release: (outcome: FleetSendOutcome) => void = () => {}
    core.respond = () => new Promise((resolve) => (release = resolve))
    await advance(MINUTE)
    const signal = core.calls[0].signal
    expect(signal?.aborted).toBe(false)
    signOut()
    expect(signal?.aborted).toBe(true)
    release(acceptAll(records))
    await settle()
    expect(ids(queued(CORE_X, A))).toEqual(ids(records))
    expect(timers.size).toBe(0)
  })

  test("a rebuilt client for the same account keeps the same collector session", async () => {
    reporter.start()
    reconnectTo(CORE_X)
    await settle()
    expect(collector.runs).toHaveLength(1)
    expect(collector.stops).toEqual([])
  })

  test("when the client turns out to speak for another account, nothing is sent and the reporter switches", async () => {
    reporter.start()
    const fromA = observe(2)
    // The client now holds B's token, and no event said so.
    core.session = {coreUrl: CORE_X, mentraUserId: B}
    await advance(MINUTE)
    expect(core.sent).toEqual([])
    expect(collector.stops).toEqual(["account_changed"])
    expect(collector.active?.partition).toBe(partitionKey(CORE_X, B))
    expect(ids(queued(CORE_X, A))).toEqual(ids(fromA))
    // The refused attempt is the only one made as A.
    expect(core.calls.filter((call) => call.as.mentraUserId === A)).toHaveLength(1)
    core.calls = core.calls.filter((call) => call.as.mentraUserId !== A)
  })
})

describe("iOS background", () => {
  test("going to the background flushes a checkpoint and attempts one upload", async () => {
    ;(reactNative.Platform as {OS: string}).OS = "ios"
    reporter.start()
    observe(1)
    expect(collector.flushes).toBe(1)
    setAppState("inactive")
    expect(collector.flushes).toBe(1)
    setAppState("background")
    expect(collector.flushes).toBe(2)
    await settle()
    expect(core.calls).toHaveLength(1)
    expect(queued(CORE_X, A)).toEqual([])
  })

  test("while backing off, going to the background sends nothing", async () => {
    ;(reactNative.Platform as {OS: string}).OS = "ios"
    reporter.start()
    observe(1)
    core.respond = () => unavailable(600)
    await advance(MINUTE)
    setAppState("background")
    await settle()
    expect(core.calls).toHaveLength(1)
    expect(collector.flushes).toBe(2)
  })

  test("on Android, going to the background changes nothing", async () => {
    reporter.start()
    observe(1)
    setAppState("background")
    await settle()
    expect(collector.flushes).toBe(1)
    expect(core.calls).toHaveLength(0)
  })
})

describe("stopping", () => {
  test("ends collection as engine_stopped and leaves no timer or listener behind", async () => {
    reporter.start()
    observe(1)
    await reporter.stop()
    expect(collector.stops).toEqual(["engine_stopped"])
    expect(timers.size).toBe(0)
    expect(core.listeners.size).toBe(0)
    expect(appStateListeners.size).toBe(0)
    await advance(HOUR)
    expect(core.calls).toEqual([])
  })

  test("an answer that arrives after stop changes nothing", async () => {
    reporter.start()
    const records = observe(1)
    let release: (outcome: FleetSendOutcome) => void = () => {}
    core.respond = () => new Promise((resolve) => (release = resolve))
    await advance(MINUTE)
    await reporter.stop()
    expect(core.calls[0].signal?.aborted).toBe(true)
    release(acceptAll(records))
    await settle()
    expect(ids(queued(CORE_X, A))).toEqual(ids(records))
    expect(timers.size).toBe(0)
  })
})

describe("with the real collector", () => {
  beforeEach(() => {
    reporter = makeReporter((q) => createFleetCollector({queue: q, now: () => clock.wall, monotonic: () => clock.mono}))
  })

  test("a launch reported right after start() is recorded: the collector listens before the host restores miniapps", () => {
    reporter.start()
    fleetEvents.launch({packageName: "com.mentra.notes", start: "automatic", outcome: "started"})
    expect(queued(CORE_X, A).filter((record) => record.kind === "miniapp_launch")).toHaveLength(1)
  })

  test("not_installed stops collection and drops what was queued", async () => {
    reporter.start()
    core.respond = () => ({kind: "not_installed"})
    await advance(MINUTE)
    const partition = partitionKey(CORE_X, A)
    expect(store.keys().filter((key) => key.includes(partition))).toEqual([])
    fleetEvents.launch({packageName: "com.mentra.notes", start: "user", outcome: "started"})
    await advance(2 * HOUR)
    expect(queue.size(partition)).toBe(0)
    expect(core.calls).toHaveLength(1)
  })

  test("an account change ends A's sessions in A's partition and opens B's in B's", async () => {
    reporter.start()
    core.respond = () => unavailable(3_600)
    await advance(2 * MINUTE)
    signOut()
    signIn(B)
    await settle()
    const ended = queued(CORE_X, A)
      .filter((record) => record.kind === "usage_checkpoint")
      .flatMap((record) => (record.kind === "usage_checkpoint" ? record.payload.sessions : []))
      .filter((session) => session.ended)
    expect(ended.map((session) => session.activity)).toContain("engine_active")
    expect(queued(CORE_X, B).some((record) => record.kind === "snapshot")).toBe(true)
  })
})

describe("what the reporter reads", () => {
  const folder = new URL("..", import.meta.url)
  const source = readFileSync(new URL("FleetReporter.ts", folder), "utf8")

  test("it is one of the Fleet sources the telemetry-independence check reads", () => {
    expect(readdirSync(folder)).toContain("FleetReporter.ts")
  })

  test("telemetry off in the host changes nothing: the reporter imports nothing that could carry the switch", () => {
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]).sort()
    expect(imports).toEqual(
      [
        "@mentra/cloud-protocol",
        "react-native",
        "../../utils/timers",
        "../CloudClientService",
        "./fleetCollector",
        "./fleetIds",
        "./fleetQueue",
      ].sort(),
    )
    for (const forbidden of ["deploymentStore", "isTelemetryAllowed", "getConfigValues", "isFeatureEnabled"]) {
      expect(source.includes(forbidden)).toBe(false)
    }
  })
})
