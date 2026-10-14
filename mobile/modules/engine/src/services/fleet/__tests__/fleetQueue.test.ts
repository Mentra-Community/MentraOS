/// <reference types="bun-types" />

import {createHash} from "node:crypto"
import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import {FLEET_LIMITS, type FleetRecord} from "@mentra/cloud-protocol"
import {createMMKVCalls, DEFAULT_MMKV_ID, fakeCreateMMKV, mmkvInstances, resetFakeMmkv} from "./fakeMmkv"
import {MemoryFleetStore} from "./memoryFleetStore"

mock.module("react-native-mmkv", () => ({createMMKV: fakeCreateMMKV}))

const {createFleetQueue, partitionKey} = await import("../fleetQueue")

const A = "a".repeat(64)
const B = "b".repeat(64)
const START = Date.UTC(2026, 9, 13, 12, 0, 0)
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** 7 days and 1 minute: older than the queue keeps anything. */
const STALE = 7 * DAY + MINUTE

function at(minutes: number): string {
  return new Date(START + minutes * MINUTE).toISOString()
}

function gap(recordId: string, observedAt = at(0)): FleetRecord {
  return {
    schemaVersion: 1,
    recordId,
    phoneDeviceId: "PHONE",
    collectorSessionId: "SESSION",
    sequence: 0,
    observedAt,
    capabilities: [],
    kind: "coverage_gap",
    payload: {reason: "queue_dropped", from: observedAt, to: observedAt},
  }
}

function snapshot(recordId: string, model: string): FleetRecord {
  return {
    schemaVersion: 1,
    recordId,
    phoneDeviceId: "PHONE",
    collectorSessionId: "SESSION",
    sequence: 0,
    observedAt: at(0),
    capabilities: [],
    kind: "snapshot",
    payload: {phone: {model, os: "ios", osVersion: "26.0", appVersion: "1.0.0", appBuild: "1"}},
  }
}

function ids(records: FleetRecord[]): string[] {
  return records.map((record) => record.recordId)
}

function utf8Length(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

let store: MemoryFleetStore
let clock: number

function newQueue(target: MemoryFleetStore = store) {
  return createFleetQueue(target, {now: () => clock})
}

let warn: ReturnType<typeof spyOn<Console, "warn">>

beforeEach(() => {
  store = new MemoryFleetStore()
  clock = START
  resetFakeMmkv()
  warn = spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
})

describe("partitionKey", () => {
  const sha = (value: string) => createHash("sha256").update(value).digest("hex")

  test("is the sha256 hex of the normalized Core URL and the account", () => {
    expect(partitionKey("https://core.example.com", "user-1")).toBe(sha("https://core.example.com|user-1"))
    expect(partitionKey("https://core.example.com", "user-1")).toMatch(/^[0-9a-f]{64}$/)
  })

  test("hashes non-ASCII account IDs as UTF-8", () => {
    expect(partitionKey("https://core.example.com", "usér-電\u{1F4F1}")).toBe(
      sha("https://core.example.com|usér-電\u{1F4F1}"),
    )
  })

  test("gives one partition to every spelling of one Core", () => {
    const base = partitionKey("https://core.example.com", "u")
    for (const spelling of [
      "https://core.example.com/",
      "https://core.example.com///",
      "HTTPS://Core.Example.COM",
      "https://core.example.com:443",
      "  https://core.example.com  ",
      "https://core.example.com/?a=1#frag",
    ]) {
      expect(partitionKey(spelling, "u")).toBe(base)
    }
    expect(partitionKey("http://localhost:80/", "u")).toBe(partitionKey("http://localhost", "u"))
    expect(partitionKey("https://c.example.com/Core/", "u")).toBe(partitionKey("https://c.example.com/Core", "u"))
  })

  test("gives different Cores and different accounts different partitions", () => {
    const partitions = new Set([
      partitionKey("https://core.example.com", "u"),
      partitionKey("https://other.example.com", "u"),
      partitionKey("http://core.example.com", "u"),
      partitionKey("https://core.example.com:8443", "u"),
      partitionKey("https://core.example.com:80", "u"),
      partitionKey("https://core.example.com/api", "u"),
      partitionKey("https://c.example.com/Core", "u"),
      partitionKey("https://c.example.com/core", "u"),
      partitionKey("http://localhost:3000", "u"),
      partitionKey("http://localhost:3001", "u"),
      partitionKey("https://core.example.com", "U"),
      partitionKey("https://core.example.com", "v"),
    ])
    expect(partitions.size).toBe(12)
  })

  test("refuses a missing Core or account instead of sharing a partition", () => {
    expect(() => partitionKey("", "u")).toThrow()
    expect(() => partitionKey("   ", "u")).toThrow()
    expect(() => partitionKey("https://core.example.com", "")).toThrow()
  })
})

describe("FleetQueue storage layout", () => {
  test("keeps one key per record, plus an index with the count and the oldest and newest key", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("first"))
    clock += MINUTE
    queue.enqueue(A, gap("second", at(1)))

    const first = `q:${A}:0000000000000000:first`
    const second = `q:${A}:0000000000000001:second`
    expect(store.keys().sort()).toEqual([`i:${A}`, first, second].sort())
    expect(JSON.parse(store.values.get(first)!)).toEqual({enqueuedAt: START, record: gap("first")})
    expect(JSON.parse(store.values.get(second)!)).toEqual({enqueuedAt: START + MINUTE, record: gap("second", at(1))})
    expect(JSON.parse(store.values.get(`i:${A}`)!)).toMatchObject({count: 2, oldest: first, newest: second})
  })

  test("stores a snapshot of the record, not a reference", () => {
    const queue = newQueue()
    const record = gap("mutable")
    queue.enqueue(A, record)
    record.sequence = 99
    expect(queue.nextBatch(A, 10, 1_000_000)[0].sequence).toBe(0)
  })
})

describe("FleetQueue order and partitions", () => {
  test("returns records oldest first, and leaves them queued until they are removed", () => {
    const queue = newQueue()
    for (const id of ["r1", "r2", "r3", "r4"]) queue.enqueue(A, gap(id))
    expect(ids(queue.nextBatch(A, 10, 1_000_000))).toEqual(["r1", "r2", "r3", "r4"])
    expect(ids(queue.nextBatch(A, 10, 1_000_000))).toEqual(["r1", "r2", "r3", "r4"])
    expect(queue.size(A)).toBe(4)
  })

  test("stops at the record limit", () => {
    const queue = newQueue()
    for (let index = 0; index < 5; index += 1) queue.enqueue(A, gap(`r${index}`))
    expect(ids(queue.nextBatch(A, 3, 1_000_000))).toEqual(["r0", "r1", "r2"])
    expect(queue.nextBatch(A, 0, 1_000_000)).toEqual([])
    expect(queue.nextBatch(A, -1, 1_000_000)).toEqual([])
    expect(queue.nextBatch(A, Number.NaN, 1_000_000)).toEqual([])
    expect(queue.nextBatch("c".repeat(64), 10, 1_000_000)).toEqual([])
  })

  test("keeps order across more than ten records (sequence keys sort numerically)", () => {
    const queue = newQueue()
    const expected = Array.from({length: 120}, (_, index) => `r${index}`)
    for (const id of expected) queue.enqueue(A, gap(id))
    expect(ids(queue.nextBatch(A, 500, 10_000_000))).toEqual(expected)
  })

  test("never returns one account's records from another's partition", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("a1"))
    queue.enqueue(B, gap("b1"))
    queue.enqueue(A, gap("a2"))
    expect(ids(queue.nextBatch(A, 10, 1_000_000))).toEqual(["a1", "a2"])
    expect(ids(queue.nextBatch(B, 10, 1_000_000))).toEqual(["b1"])
    expect(queue.size(A)).toBe(2)
    expect(queue.size(B)).toBe(1)

    queue.remove(B, ["a1"])
    expect(ids(queue.nextBatch(A, 10, 1_000_000))).toEqual(["a1", "a2"])

    queue.remove(A, ["a1"])
    expect(ids(queue.nextBatch(A, 10, 1_000_000))).toEqual(["a2"])
    expect(ids(queue.nextBatch(B, 10, 1_000_000))).toEqual(["b1"])
  })

  test("does not mistake one partition for another that shares its start", () => {
    const queue = newQueue()
    queue.enqueue("p1", gap("one"))
    queue.enqueue("p10", gap("ten"))
    expect(ids(queue.nextBatch("p1", 10, 1_000_000))).toEqual(["one"])
    expect(ids(queue.nextBatch("p10", 10, 1_000_000))).toEqual(["ten"])
  })

  test("keeps losses, sizes and sequences per partition", () => {
    const queue = newQueue()
    for (let index = 0; index < FLEET_LIMITS.phoneQueueMaxRecords + 1; index += 1) queue.enqueue(A, gap(`a${index}`))
    queue.enqueue(B, gap("b1"))
    expect(queue.takeLosses(B, clock)).toEqual({dropped: 0, expired: 0, from: null, to: null})
    expect(queue.takeLosses(A, clock).dropped).toBe(1)
    expect(queue.nextSequence(A, "s")).toBe(0)
    expect(queue.nextSequence(B, "s")).toBe(0)
    expect(queue.nextSequence(A, "s")).toBe(1)
  })
})

describe("FleetQueue.remove", () => {
  test("removes the named records and keeps the others in order", () => {
    const queue = newQueue()
    for (const id of ["r1", "r2", "r3", "r4", "r5"]) queue.enqueue(A, gap(id))
    queue.remove(A, ["r2", "r4"])
    expect(ids(queue.nextBatch(A, 10, 1_000_000))).toEqual(["r1", "r3", "r5"])
    expect(queue.size(A)).toBe(3)
    expect(store.keys().filter((key) => key.startsWith(`q:${A}:`))).toHaveLength(3)
  })

  test("ignores IDs that are not queued, and an empty list", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("r1"))
    queue.remove(A, ["nope", "r1", "r1"])
    queue.remove(A, [])
    queue.remove(A, ["still-nope"])
    expect(queue.size(A)).toBe(0)
  })

  test("handles record IDs that contain colons", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("a:b:c"))
    queue.enqueue(A, gap("a:b"))
    queue.remove(A, ["a:b"])
    expect(ids(queue.nextBatch(A, 10, 1_000_000))).toEqual(["a:b:c"])
  })

  test("keeps the index in step so a restart sees the same queue", () => {
    const queue = newQueue()
    for (const id of ["r1", "r2", "r3"]) queue.enqueue(A, gap(id))
    queue.remove(A, ["r1", "r3"])
    const index = JSON.parse(store.values.get(`i:${A}`)!)
    expect(index).toMatchObject({count: 1, oldest: `q:${A}:0000000000000001:r2`, newest: `q:${A}:0000000000000001:r2`})
    expect(ids(newQueue(new MemoryFleetStore(store.values)).nextBatch(A, 10, 1_000_000))).toEqual(["r2"])
  })
})

describe("FleetQueue.nextBatch byte limit", () => {
  test("counts the JSON bytes of each record and stops before exceeding the limit", () => {
    const queue = newQueue()
    for (const id of ["r1", "r2", "r3"]) queue.enqueue(A, gap(id))
    const size = utf8Length(gap("r1"))
    expect(ids(queue.nextBatch(A, 500, size * 3))).toEqual(["r1", "r2", "r3"])
    expect(ids(queue.nextBatch(A, 500, size * 3 - 1))).toEqual(["r1", "r2"])
    expect(ids(queue.nextBatch(A, 500, size * 2))).toEqual(["r1", "r2"])
    expect(ids(queue.nextBatch(A, 500, size * 2 - 1))).toEqual(["r1"])
  })

  test("measures UTF-8 bytes, not string length", () => {
    const queue = newQueue()
    const model = "電".repeat(40)
    queue.enqueue(A, snapshot("s1", model))
    queue.enqueue(A, snapshot("s2", model))
    const record = snapshot("s1", model)
    const chars = JSON.stringify(record).length
    const bytes = utf8Length(record)
    expect(bytes).toBe(chars + 80)

    // Two records fit by character count but not by bytes.
    expect(ids(queue.nextBatch(A, 500, chars * 2 + 10))).toEqual(["s1"])
    expect(ids(queue.nextBatch(A, 500, bytes * 2))).toEqual(["s1", "s2"])
  })

  test("measures each record as it is serialized in the batch, not as it was stored", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("r1"))
    queue.enqueue(A, gap("r2"))
    const size = utf8Length(gap("r1"))
    // The stored value also carries enqueuedAt and the wrapper; none of that is sent.
    expect(utf8Length(JSON.parse(store.values.get(`q:${A}:0000000000000000:r1`)!))).toBeGreaterThan(size)
    expect(ids(queue.nextBatch(A, 500, size * 2))).toEqual(["r1", "r2"])
  })

  test("always offers the oldest record, so one oversize record cannot block the queue", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("r1"))
    queue.enqueue(A, gap("r2"))
    expect(ids(queue.nextBatch(A, 500, 1))).toEqual(["r1"])
  })

  test("fills a real 500-record, 1,000,000-byte batch from a long queue", () => {
    const queue = newQueue()
    for (let index = 0; index < 700; index += 1) queue.enqueue(A, gap(`r${String(index).padStart(4, "0")}`))
    const batch = queue.nextBatch(A, FLEET_LIMITS.maxRecordsPerBatch, 1_000_000)
    expect(batch).toHaveLength(500)
    expect(batch[0].recordId).toBe("r0000")
    expect(batch[499].recordId).toBe("r0499")
  })
})

describe("FleetQueue capacity", () => {
  test("drops the oldest record for the 10,001st and reports it with its time range", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("oldest", at(5)))
    for (let index = 1; index < FLEET_LIMITS.phoneQueueMaxRecords; index += 1) {
      queue.enqueue(A, gap(`r${index}`, at(100 + index)))
    }
    expect(queue.size(A)).toBe(10_000)
    expect(queue.takeLosses(A, clock)).toEqual({dropped: 0, expired: 0, from: null, to: null})

    queue.enqueue(A, gap("newest", at(20_000)))

    expect(queue.size(A)).toBe(10_000)
    expect(queue.takeLosses(A, clock)).toEqual({dropped: 1, expired: 0, from: at(5), to: at(5)})
    const batch = queue.nextBatch(A, 3, 1_000_000)
    expect(ids(batch)).toEqual(["r1", "r2", "r3"])
    expect(store.keys().some((key) => key.endsWith(":oldest"))).toBe(false)
    expect(store.keys().filter((key) => key.startsWith(`q:${A}:`))).toHaveLength(10_000)
    expect(queue.takeLosses(A, clock)).toEqual({dropped: 0, expired: 0, from: null, to: null})
  })

  test("covers every dropped record's observation time with the min and max, whatever their order", () => {
    const queue = newQueue()
    const observed = [at(30), at(10), at(50)]
    observed.forEach((observedAt, index) => queue.enqueue(A, gap(`early${index}`, observedAt)))
    for (let index = 0; index < FLEET_LIMITS.phoneQueueMaxRecords; index += 1)
      queue.enqueue(A, gap(`r${index}`, at(500)))
    const losses = queue.takeLosses(A, clock)
    expect(losses).toEqual({dropped: 3, expired: 0, from: at(10), to: at(50)})
    expect(queue.size(A)).toBe(10_000)
  })

  test("keeps the drop count across a restart until it is taken", () => {
    const queue = newQueue()
    for (let index = 0; index < FLEET_LIMITS.phoneQueueMaxRecords + 2; index += 1)
      queue.enqueue(A, gap(`r${index}`, at(index)))
    const restarted = newQueue(new MemoryFleetStore(store.values))
    expect(restarted.takeLosses(A, clock)).toEqual({dropped: 2, expired: 0, from: at(0), to: at(1)})
    expect(newQueue(new MemoryFleetStore(store.values)).takeLosses(A, clock).dropped).toBe(0)
  })
})

describe("FleetQueue expiry", () => {
  test("expires a record 7 days and 1 minute old, and keeps younger ones", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("old", at(0)))
    clock += 2 * MINUTE
    queue.enqueue(A, gap("fresh", at(2)))

    const losses = queue.takeLosses(A, START + FLEET_LIMITS.phoneQueueMaxAgeMs + MINUTE)

    expect(losses).toEqual({dropped: 0, expired: 1, from: at(0), to: at(0)})
    expect(ids(queue.nextBatch(A, 10, 1_000_000))).toEqual(["fresh"])
    expect(queue.size(A)).toBe(1)
    expect(store.keys().some((key) => key.endsWith(":old"))).toBe(false)
  })

  test("keeps a record that is exactly 7 days old", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("edge"))
    expect(queue.takeLosses(A, START + 7 * DAY)).toEqual({dropped: 0, expired: 0, from: null, to: null})
    expect(queue.size(A)).toBe(1)
    expect(queue.takeLosses(A, START + 7 * DAY + 1).expired).toBe(1)
  })

  test("reports expiries once, then resets", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("old"))
    const later = START + 8 * DAY
    expect(queue.takeLosses(A, later).expired).toBe(1)
    expect(queue.takeLosses(A, later)).toEqual({dropped: 0, expired: 0, from: null, to: null})
    expect(queue.size(A)).toBe(0)
    expect(JSON.parse(store.values.get(`i:${A}`)!)).toMatchObject({count: 0, oldest: null, newest: null})
  })

  test("reports expiries and drops together over one time range", () => {
    const queue = newQueue()
    for (let index = 0; index < FLEET_LIMITS.phoneQueueMaxRecords + 1; index += 1)
      queue.enqueue(A, gap(`r${index}`, at(index)))
    const losses = queue.takeLosses(A, START + FLEET_LIMITS.phoneQueueMaxAgeMs + MINUTE)
    expect(losses.dropped).toBe(1)
    expect(losses.expired).toBe(10_000)
    expect(losses.from).toBe(at(0))
    expect(losses.to).toBe(at(10_000))
    expect(queue.size(A)).toBe(0)
  })

  test("does nothing for a partition that has no records", () => {
    const queue = newQueue()
    expect(queue.takeLosses(A, START + 30 * DAY)).toEqual({dropped: 0, expired: 0, from: null, to: null})
    expect(store.keys()).toEqual([])
  })
})

describe("FleetQueue.sweepExpired", () => {
  const keysOf = (partition: string) => store.keys().filter((key) => key.split(":")[1] === partition)
  const restart = () => newQueue(new MemoryFleetStore(store.values))

  test("empties a partition untouched for 7 days and 1 minute and removes its keys", () => {
    const queue = newQueue()
    for (const id of ["r1", "r2", "r3"]) queue.enqueue(A, gap(id, at(1)))
    queue.nextSequence(A, "session")
    expect(keysOf(A).length).toBeGreaterThan(3)

    // A restarted process: the partition's account never came back, so nothing loaded it.
    const restarted = restart()
    restarted.sweepExpired(START + STALE)

    expect(keysOf(A).filter((key) => key.startsWith("q:"))).toEqual([])
    expect(keysOf(A).filter((key) => key.startsWith("i:") || key.startsWith("n:"))).toEqual([])
    expect(restarted.size(A)).toBe(0)
  })

  test("keeps the loss counters of a partition whose account returns within the window", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("r1", at(1)))
    queue.enqueue(A, gap("r2", at(3)))
    const swept = START + STALE
    restart().sweepExpired(swept)
    expect(keysOf(A)).toEqual([`l:${A}`])

    // The account signs in again two days later, on a restarted process.
    const returned = restart()
    expect(returned.takeLosses(A, swept + 2 * DAY)).toEqual({dropped: 0, expired: 2, from: at(1), to: at(3)})
    expect(keysOf(A)).toEqual([])
    expect(returned.takeLosses(A, swept + 2 * DAY)).toEqual({dropped: 0, expired: 0, from: null, to: null})
  })

  test("drops the loss counters too once they are older than 7 days", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("r1", at(1)))
    const swept = START + STALE
    restart().sweepExpired(swept)
    expect(keysOf(A)).toEqual([`l:${A}`])

    restart().sweepExpired(swept + 7 * DAY)
    expect(keysOf(A)).toEqual([`l:${A}`])
    restart().sweepExpired(swept + 7 * DAY + 1)
    expect(keysOf(A)).toEqual([])
    expect(store.keys()).toEqual([])
  })

  test("leaves a fresh partition untouched", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("old", at(0)))
    clock = START + 7 * DAY
    queue.enqueue(B, gap("fresh1", at(7 * 24 * 60)))
    queue.enqueue(B, gap("fresh2", at(7 * 24 * 60 + 1)))
    queue.nextSequence(B, "session")
    const before = new Map(
      store
        .keys()
        .filter((key) => keysOf(B).includes(key))
        .map((key) => [key, store.values.get(key)]),
    )

    restart().sweepExpired(START + STALE)

    expect(keysOf(A).filter((key) => key.startsWith("q:"))).toEqual([])
    expect(new Map(keysOf(B).map((key) => [key, store.values.get(key)]))).toEqual(before)
    expect(ids(restart().nextBatch(B, 10, 1_000_000))).toEqual(["fresh1", "fresh2"])
  })

  test("removes only the old records of a partition that has younger ones", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("old1", at(0)))
    queue.enqueue(A, gap("old2", at(1)))
    clock = START + 3 * DAY
    queue.enqueue(A, gap("young", at(3 * 24 * 60)))
    queue.nextSequence(A, "session")

    const restarted = restart()
    restarted.sweepExpired(START + STALE)

    expect(ids(restarted.nextBatch(A, 10, 1_000_000))).toEqual(["young"])
    expect(JSON.parse(store.values.get(`i:${A}`)!)).toMatchObject({count: 1})
    expect(store.values.has(`n:${A}`)).toBe(true)
    expect(restarted.takeLosses(A, START + STALE)).toEqual({dropped: 0, expired: 2, from: at(0), to: at(1)})
  })

  test("sweeps every partition in the store with a single scan", () => {
    const queue = newQueue()
    for (const partition of [A, B, "c".repeat(64), "p1", "p10"])
      queue.enqueue(partition, gap(`r-${partition.slice(0, 3)}`))
    queue.nextSequence(B, "session")

    const scanned = new MemoryFleetStore(store.values)
    const sweeper = newQueue(scanned)
    sweeper.sweepExpired(START + STALE)

    expect(scanned.getAllKeysCalls).toBe(1)
    expect(store.keys().filter((key) => key.startsWith("q:") || key.startsWith("i:") || key.startsWith("n:"))).toEqual(
      [],
    )
    sweeper.sweepExpired(START + STALE)
    expect(scanned.getAllKeysCalls).toBe(2)
  })

  test("does not scan again for partitions this process has already loaded", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("r1"))
    queue.enqueue(B, gap("r2"))
    expect(store.getAllKeysCalls).toBe(2)
    queue.sweepExpired(START + MINUTE)
    expect(store.getAllKeysCalls).toBe(3)
    expect(queue.size(A)).toBe(1)
    expect(queue.size(B)).toBe(1)
    expect(store.getAllKeysCalls).toBe(3)
  })

  test("expires records in a partition this process has loaded", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("r1", at(1)))
    queue.sweepExpired(START + STALE)
    expect(queue.size(A)).toBe(0)
    expect(queue.nextBatch(A, 10, 1_000_000)).toEqual([])
    expect(queue.takeLosses(A, START + STALE)).toEqual({dropped: 0, expired: 1, from: at(1), to: at(1)})
    // The queue stays usable, and does not reuse a key.
    queue.enqueue(A, gap("r2", at(2)))
    expect(ids(queue.nextBatch(A, 10, 1_000_000))).toEqual(["r2"])
    expect(store.keys()).toContain(`q:${A}:0000000000000001:r2`)
  })

  test("defaults to the queue's clock", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("r1", at(1)))
    queue.sweepExpired()
    expect(queue.size(A)).toBe(1)
    clock = START + STALE
    queue.sweepExpired()
    expect(queue.size(A)).toBe(0)
  })

  test("does not reset the sequence of a live collector session when it clears an empty partition", () => {
    const queue = newQueue()
    expect(queue.nextSequence(A, "session")).toBe(0)
    expect(queue.nextSequence(A, "session")).toBe(1)
    queue.sweepExpired(START)
    expect(store.values.has(`n:${A}`)).toBe(false)
    expect(queue.nextSequence(A, "session")).toBe(2)
    expect(store.values.has(`n:${A}`)).toBe(true)
  })

  test("removes loss counters it cannot read, and an index with nothing behind it", () => {
    store.values.set(`l:${A}`, "{not json")
    store.values.set(`i:${A}`, JSON.stringify({count: 0, nextSeq: 4, oldest: null, newest: null}))
    newQueue().sweepExpired(START)
    expect(keysOf(A)).toEqual([])
  })

  test("forgets losses that never reached the store once they are too old", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("r1", at(1)))
    store.failSetWhen = (key) => !key.startsWith("i:") || key.endsWith("r2")
    queue.enqueue(A, gap("r2", at(2)))
    store.failSetWhen = null
    queue.sweepExpired(START + STALE)
    expect(queue.takeLosses(A, START + STALE).dropped).toBe(0)
  })

  test("never throws, whatever the store does", () => {
    const queue = newQueue()
    for (const id of ["r1", "r2"]) queue.enqueue(A, gap(id, at(1)))
    queue.nextSequence(A, "session")

    // A fresh queue over the failing store, as after a restart.
    store.failGetAllKeys = true
    expect(() => newQueue(store).sweepExpired(START + STALE)).not.toThrow()
    store.failGetAllKeys = false

    store.failSetWhen = () => true
    store.failRemoveWhen = () => true
    expect(() => newQueue(store).sweepExpired(START + STALE)).not.toThrow()
    store.failSetWhen = null
    store.failRemoveWhen = null
    expect(warn).toHaveBeenCalled()

    // Once the store works again the sweep finishes the job.
    newQueue(store).sweepExpired(START + STALE)
    expect(keysOf(A).filter((key) => key.startsWith("q:"))).toEqual([])
  })

  test("sweeps the other partitions when one of them fails", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("a1", at(1)))
    queue.enqueue(B, gap("b1", at(1)))
    store.failRemoveWhen = (key) => key.includes(A)
    expect(() => newQueue(store).sweepExpired(START + STALE)).not.toThrow()
    store.failRemoveWhen = null
    expect(keysOf(B).filter((key) => key.startsWith("q:"))).toEqual([])
  })

  test("finds the partition in a record key whose record ID contains the key separators", () => {
    const queue = newQueue()
    queue.enqueue("acct-1", gap("x:0000000000000009:y", at(1)))
    restart().sweepExpired(START + STALE)
    expect(keysOf("acct-1")).toEqual([`l:acct-1`])
  })
})

describe("FleetQueue never throws after mutating state", () => {
  test("nextBatch, remove, takeLosses and clearPartition survive a store that refuses writes and removals", () => {
    const queue = newQueue()
    for (const id of ["r1", "r2", "r3"]) queue.enqueue(A, gap(id, at(1)))
    store.values.set(`q:${A}:0000000000000000:r1`, "{not json")
    store.failSetWhen = () => true
    store.failRemoveWhen = () => true

    expect(() => queue.nextBatch(A, 10, 1_000_000)).not.toThrow()
    expect(() => queue.remove(A, ["r2"])).not.toThrow()
    expect(() => queue.takeLosses(A, START + STALE)).not.toThrow()
    expect(() => queue.clearPartition(A)).not.toThrow()
    expect(warn).toHaveBeenCalled()
  })

  test("the in-memory queue follows what was asked even when the store would not take it", () => {
    const queue = newQueue()
    for (const id of ["r1", "r2", "r3"]) queue.enqueue(A, gap(id, at(1)))
    store.failSetWhen = (key) => key.startsWith("i:")
    store.failRemoveWhen = (key) => key.endsWith(":r2")
    queue.remove(A, ["r1", "r2"])
    store.failSetWhen = null
    store.failRemoveWhen = null
    expect(ids(queue.nextBatch(A, 10, 1_000_000))).toEqual(["r3"])
    expect(queue.size(A)).toBe(1)
  })

  test("takeLosses still reports when it cannot clear the counters, so nothing is lost", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("r1", at(1)))
    store.failRemoveWhen = (key) => key.startsWith("l:")
    const first = queue.takeLosses(A, START + 8 * DAY)
    expect(first).toEqual({dropped: 0, expired: 1, from: at(1), to: at(1)})
    store.failRemoveWhen = null
    // Reported again next time, rather than never.
    expect(queue.takeLosses(A, START + 8 * DAY).expired).toBe(1)
    expect(queue.takeLosses(A, START + 8 * DAY).expired).toBe(0)
  })

  test("a failed index write after an unreadable record is discarded does not throw", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("r1", at(1)))
    queue.enqueue(A, gap("r2", at(2)))
    store.values.set(`q:${A}:0000000000000000:r1`, "{not json")
    const restarted = newQueue(store)
    store.failSetWhen = (key) => key.startsWith("i:")
    expect(() => ids(restarted.nextBatch(A, 10, 1_000_000))).not.toThrow()
    store.failSetWhen = null
    expect(ids(restarted.nextBatch(A, 10, 1_000_000))).toEqual(["r2"])
  })

  test("a failed index repair on load does not throw", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("r1", at(1)))
    store.values.delete(`i:${A}`)
    store.failSetWhen = (key) => key.startsWith("i:")
    expect(() => newQueue(store).size(A)).not.toThrow()
    store.failSetWhen = null
  })
})

describe("FleetQueue.nextSequence", () => {
  test("increases for one collector session", () => {
    const queue = newQueue()
    expect([1, 2, 3, 4].map(() => queue.nextSequence(A, "session-1"))).toEqual([0, 1, 2, 3])
  })

  test("counts each collector session separately", () => {
    const queue = newQueue()
    expect(queue.nextSequence(A, "session-1")).toBe(0)
    expect(queue.nextSequence(A, "session-1")).toBe(1)
    expect(queue.nextSequence(A, "session-2")).toBe(0)
    expect(queue.nextSequence(A, "session-1")).toBe(2)
    expect(queue.nextSequence(A, "session-2")).toBe(1)
  })

  test("continues after a restart", () => {
    const queue = newQueue()
    queue.nextSequence(A, "session-1")
    queue.nextSequence(A, "session-1")
    const restarted = newQueue(new MemoryFleetStore(store.values))
    expect(restarted.nextSequence(A, "session-1")).toBe(2)
  })

  test("keeps only the most recent collector sessions", () => {
    const queue = newQueue()
    for (let index = 0; index < 40; index += 1) queue.nextSequence(A, `session-${index}`)
    const counters = store.keys().filter((key) => key.startsWith("n:"))
    expect(counters).toHaveLength(1)
    expect(JSON.parse(store.values.get(counters[0])!).length).toBeLessThanOrEqual(16)
    expect(queue.nextSequence(A, "session-39")).toBe(1)
  })
})

describe("FleetQueue.clearPartition", () => {
  test("removes everything held for the partition and nothing else", () => {
    const queue = newQueue()
    for (let index = 0; index < 5; index += 1) queue.enqueue(A, gap(`a${index}`))
    queue.enqueue(B, gap("b1"))
    queue.nextSequence(A, "s")
    queue.nextSequence(B, "s")
    for (let index = 0; index < FLEET_LIMITS.phoneQueueMaxRecords; index += 1) queue.enqueue(B, gap(`more${index}`))
    expect(queue.takeLosses(B, clock).dropped).toBe(1)
    queue.enqueue(A, gap("a-last"))

    queue.clearPartition(A)

    expect(queue.size(A)).toBe(0)
    expect(queue.nextBatch(A, 10, 1_000_000)).toEqual([])
    expect(store.keys().filter((key) => key.includes(A))).toEqual([])
    expect(queue.size(B)).toBe(10_000)
    expect(queue.nextSequence(B, "s")).toBe(1)
  })

  test("forgets pending losses too", () => {
    const queue = newQueue()
    for (let index = 0; index < FLEET_LIMITS.phoneQueueMaxRecords + 1; index += 1) queue.enqueue(A, gap(`r${index}`))
    queue.clearPartition(A)
    expect(queue.takeLosses(A, clock)).toEqual({dropped: 0, expired: 0, from: null, to: null})
  })

  test("leaves the partition ready for new records", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("old"))
    queue.clearPartition(A)
    queue.enqueue(A, gap("new"))
    expect(ids(queue.nextBatch(A, 10, 1_000_000))).toEqual(["new"])
    expect(ids(newQueue(new MemoryFleetStore(store.values)).nextBatch(A, 10, 1_000_000))).toEqual(["new"])
  })
})

describe("FleetQueue durability", () => {
  test("a restarted queue sees the same records in the same order and appends after them", () => {
    const queue = newQueue()
    for (const id of ["r1", "r2", "r3"]) queue.enqueue(A, gap(id))
    queue.remove(A, ["r2"])

    const restarted = newQueue(new MemoryFleetStore(store.values))
    expect(ids(restarted.nextBatch(A, 10, 1_000_000))).toEqual(["r1", "r3"])
    restarted.enqueue(A, gap("r4"))
    expect(ids(restarted.nextBatch(A, 10, 1_000_000))).toEqual(["r1", "r3", "r4"])
    expect(ids(newQueue(new MemoryFleetStore(store.values)).nextBatch(A, 10, 1_000_000))).toEqual(["r1", "r3", "r4"])
  })

  test("never reuses a sequence number, even when the queue was emptied before a restart", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("r1"))
    queue.remove(A, ["r1"])
    const restarted = newQueue(new MemoryFleetStore(store.values))
    restarted.enqueue(A, gap("r2"))
    expect(store.keys()).toContain(`q:${A}:0000000000000001:r2`)
  })

  test("rebuilds the index when it is missing, stale or unreadable", () => {
    for (const damage of [
      () => store.values.delete(`i:${A}`),
      () => store.values.set(`i:${A}`, "{not json"),
      () => store.values.set(`i:${A}`, JSON.stringify({count: 1, nextSeq: 1, oldest: "x", newest: "y"})),
    ]) {
      store = new MemoryFleetStore()
      const queue = newQueue()
      for (const id of ["r1", "r2", "r3"]) queue.enqueue(A, gap(id))
      damage()

      const restarted = newQueue(new MemoryFleetStore(store.values))
      expect(ids(restarted.nextBatch(A, 10, 1_000_000))).toEqual(["r1", "r2", "r3"])
      expect(restarted.size(A)).toBe(3)
      restarted.enqueue(A, gap("r4"))
      expect(ids(restarted.nextBatch(A, 10, 1_000_000))).toEqual(["r1", "r2", "r3", "r4"])
      expect(JSON.parse(store.values.get(`i:${A}`)!)).toMatchObject({
        count: 4,
        nextSeq: 4,
        oldest: `q:${A}:0000000000000000:r1`,
        newest: `q:${A}:0000000000000003:r4`,
      })
    }
  })

  test("drops a record it cannot read and counts it as lost", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("r1"))
    queue.enqueue(A, gap("r2", at(2)))
    store.values.set(`q:${A}:0000000000000000:r1`, "{not json")

    const restarted = newQueue(new MemoryFleetStore(store.values))
    expect(ids(restarted.nextBatch(A, 10, 1_000_000))).toEqual(["r2"])
    expect(restarted.size(A)).toBe(1)
    expect(restarted.takeLosses(A, clock)).toEqual({dropped: 1, expired: 0, from: null, to: null})
  })

  test("a failed write loses that record without throwing, and reports it as dropped", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("r1", at(1)))
    store.failSetWhen = (key) => key.endsWith(":r2")
    expect(() => queue.enqueue(A, gap("r2", at(2)))).not.toThrow()
    store.failSetWhen = null
    queue.enqueue(A, gap("r3", at(3)))

    expect(ids(queue.nextBatch(A, 10, 1_000_000))).toEqual(["r1", "r3"])
    expect(queue.takeLosses(A, clock)).toEqual({dropped: 1, expired: 0, from: at(2), to: at(2)})
    // The warning names what failed and carries none of the record.
    expect(warn).toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PHONE")
  })

  test("keeps counting a loss in memory when the store will not take the count either", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("r1", at(1)))
    store.failSetWhen = (key) => !key.startsWith("i:") || key.endsWith("r2")
    queue.enqueue(A, gap("r2", at(2)))
    store.failSetWhen = null
    expect(queue.takeLosses(A, clock)).toEqual({dropped: 1, expired: 0, from: at(2), to: at(2)})
    expect(queue.takeLosses(A, clock)).toEqual({dropped: 0, expired: 0, from: null, to: null})
  })

  test("a failed index write does not lose the record", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("r1"))
    store.failSetWhen = (key) => key.startsWith("i:")
    expect(() => queue.enqueue(A, gap("r2"))).not.toThrow()
    store.failSetWhen = null
    expect(ids(queue.nextBatch(A, 10, 1_000_000))).toEqual(["r1", "r2"])
    expect(ids(newQueue(new MemoryFleetStore(store.values)).nextBatch(A, 10, 1_000_000))).toEqual(["r1", "r2"])
  })
})

describe("FleetQueue cost", () => {
  test("scans the store once per partition, not on every call", () => {
    const queue = newQueue()
    queue.enqueue(A, gap("warm"))
    expect(store.getAllKeysCalls).toBe(1)
    for (let index = 0; index < 1000; index += 1) queue.enqueue(A, gap(`r${index}`))
    queue.nextBatch(A, 500, 1_000_000)
    queue.size(A)
    queue.takeLosses(A, clock)
    queue.remove(A, ["r1", "r2"])
    queue.nextSequence(A, "s")
    expect(store.getAllKeysCalls).toBe(1)
  })

  test("enqueue touches a constant number of keys once the queue is full", () => {
    const queue = newQueue()
    for (let index = 0; index < FLEET_LIMITS.phoneQueueMaxRecords; index += 1) queue.enqueue(A, gap(`r${index}`))
    store.reads.length = 0
    let writes = 0
    const set = store.set.bind(store)
    store.set = (key, value) => {
      writes += 1
      set(key, value)
    }
    queue.enqueue(A, gap("one-more"))
    expect(writes).toBeLessThanOrEqual(4)
    expect(store.reads.length).toBeLessThanOrEqual(3)
  })

  test("work on one partition never reads another partition's records", () => {
    const seed = newQueue()
    for (let index = 0; index < 300; index += 1) seed.enqueue(B, gap(`b${index}`))

    const spy = new MemoryFleetStore(store.values)
    const other = newQueue(spy)
    other.enqueue(A, gap("a1"))
    other.enqueue(A, gap("a2"))
    other.nextBatch(A, 10, 1_000_000)
    other.remove(A, ["a1"])
    other.takeLosses(A, clock)
    other.nextSequence(A, "s")

    expect(spy.reads.length).toBeGreaterThan(0)
    expect(spy.reads.filter((key) => key.includes(B))).toEqual([])
    expect(newQueue(new MemoryFleetStore(store.values)).size(B)).toBe(300)
  })
})

describe("the app's queue", () => {
  test("is one shared queue over the mentra-fleet MMKV instance", () => {
    const queue = createFleetQueue()
    expect(createFleetQueue()).toBe(queue)
    queue.enqueue("d".repeat(64), gap("kept"))
    expect(createMMKVCalls.map((call) => call.id)).toContain("mentra-fleet")
    expect(createMMKVCalls.map((call) => call.id)).not.toContain(DEFAULT_MMKV_ID)
    expect([...(mmkvInstances.get("mentra-fleet")?.values.keys() ?? [])].some((key) => key.includes(":kept"))).toBe(
      true,
    )
  })

  test("keeps its records when the default instance is cleared on logout", () => {
    const queue = createFleetQueue()
    const partition = "c".repeat(64)
    queue.enqueue(partition, gap("survivor"))
    const nextSequence = queue.nextSequence(partition, "session")
    const defaultInstance = fakeCreateMMKV()
    defaultInstance.set("settings", "x")
    defaultInstance.clearAll()

    expect(defaultInstance.getAllKeys()).toEqual([])
    expect(ids(queue.nextBatch(partition, 10, 1_000_000))).toEqual(["survivor"])
    expect(queue.nextSequence(partition, "session")).toBe(nextSequence + 1)
  })
})
