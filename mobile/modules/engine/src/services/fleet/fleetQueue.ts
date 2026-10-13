/**
 * The Fleet reporter's durable queue.
 *
 * The collectors record observations here and the uploader drains them to the phone's own Core. A partition is
 * one account on one Core: records queued as account A on Core X are only ever delivered as A to X, so a
 * partition's records are never returned for, or mixed with, another's. Every call takes the partition it works
 * on.
 *
 * Storage layout, in the `mentra-fleet` MMKV instance (which logout's `storage.clearAll()` does not touch):
 * - `q:<partition>:<seq>:<recordId>` holds one record, as `{enqueuedAt, record}` JSON. `<seq>` is the partition's
 *   enqueue counter, zero-padded to 16 digits so that key order is queue order.
 * - `i:<partition>` is the partition's index: `{count, nextSeq, oldest, newest}`, the record count, the next
 *   sequence and the oldest and newest record keys.
 * - `l:<partition>` holds the losses not yet reported: `{dropped, expired, from, to}`.
 * - `n:<partition>` holds the collector-session sequence counters, as `[collectorSessionId, next][]`.
 *
 * MMKV can list keys only by listing all of them, so the first call for a partition in a process scans the store
 * once, repairs the index if a crash left it behind, and keeps the partition's ordered record keys in memory.
 * After that every call costs in proportion to its own work: an enqueue is two writes (three at capacity), and
 * no call touches another partition's records. Because that list is the queue's view of the store, one queue
 * owns a store: `createFleetQueue()` returns the app's shared queue, and tests build theirs over a store of
 * their own.
 *
 * Writes are ordered so that a crash errs toward reporting a loss twice rather than never: a loss is recorded
 * before the record it describes is removed, and the index is written last and rebuilt from the records if it is
 * missing or stale.
 */
import {FLEET_LIMITS, type FleetRecord} from "@mentra/cloud-protocol"
import {getFleetStore} from "./fleetStorage"
import {sha256HexOfText, utf8ByteLength} from "./utf8"

/** The subset of an MMKV instance the queue uses; tests pass an in-memory Map-backed implementation. */
export interface FleetKeyValueStore {
  getString(key: string): string | undefined
  set(key: string, value: string): void
  remove(key: string): void
  getAllKeys(): string[]
}

/** What the queue lost since the last `takeLosses`, and the span of observation time it covers. */
export interface FleetLosses {
  /** Records discarded because the queue was full (or could not be read or written). */
  dropped: number
  /** Records discarded because they were older than the queue's maximum age. */
  expired: number
  /** The earliest `observedAt` among the lost records, or null if none had a readable one. */
  from: string | null
  /** The latest `observedAt` among the lost records, or null if none had a readable one. */
  to: string | null
}

/** A partition is one account on one Core. */
export interface FleetQueue {
  /** Adds a record. Drops the oldest beyond 10,000 and counts the drop. Never throws: a record that cannot be stored is counted as dropped. */
  enqueue(partition: string, record: FleetRecord): void
  /**
   * Up to `maxRecords` records, oldest first, whose own JSON (UTF-8 bytes, as serialized in the batch) adds up to
   * at most `maxBytes`. `maxBytes` is the caller's budget for the records themselves; the caller leaves headroom
   * for the envelope and the commas. The oldest record is always offered even if it alone exceeds `maxBytes`, so
   * one oversize record cannot block the queue; the server rejects it and the caller removes it. Records stay
   * queued until `remove`.
   */
  nextBatch(partition: string, maxRecords: number, maxBytes: number): FleetRecord[]
  /** Removes the records with these IDs. IDs that are not queued are ignored. */
  remove(partition: string, recordIds: string[]): void
  /**
   * Drops records older than 7 days, then returns the drops and expiries since the last call, with the span of
   * `observedAt` they cover, and resets the counters. The caller turns a non-zero result into a coverage gap and
   * should enqueue it straight away: the counters are cleared by this call.
   */
  takeLosses(partition: string, now: number): FleetLosses
  /** Forgets everything held for the partition: records, losses and sequence counters. */
  clearPartition(partition: string): void
  size(partition: string): number
  /** The next sequence number for a collector session, counting up from 0 and persisted. */
  nextSequence(partition: string, collectorSessionId: string): number
}

export interface FleetQueueOptions {
  /** The clock that stamps `enqueuedAt`. Defaults to `Date.now`. */
  now?: () => number
}

const SEQUENCE_WIDTH = 16
const MAX_TRACKED_COLLECTOR_SESSIONS = 16
const EMPTY_LOSSES: FleetLosses = {dropped: 0, expired: 0, from: null, to: null}

const DEFAULT_PORTS: Record<string, string> = {http: "80", https: "443"}
const URL_PARTS = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i

/**
 * One spelling per Core: lower-case scheme and host, no default port, no trailing slash, no query or fragment.
 * Hand-written so the partition key never depends on a runtime's URL implementation.
 */
function normalizeCoreUrl(coreUrl: string): string {
  const trimmed = coreUrl.trim()
  const parts = URL_PARTS.exec(trimmed)
  if (!parts) return trimmed.replace(/\/+$/, "").toLowerCase()
  const scheme = parts[1].toLowerCase()
  const authority = parts[2]
  const at = authority.lastIndexOf("@")
  const userInfo = at >= 0 ? authority.slice(0, at + 1) : ""
  const hostAndPort = /^(.*?)(?::(\d*))?$/.exec(authority.slice(at + 1).toLowerCase())
  const host = hostAndPort?.[1] ?? ""
  const port = hostAndPort?.[2] ?? ""
  const keptPort = port === "" || port === DEFAULT_PORTS[scheme] ? "" : `:${port}`
  return `${scheme}://${userInfo}${host}${keptPort}${parts[3].replace(/\/+$/, "")}`
}

/** The partition for an account on a Core: sha256 hex of `${normalizedCoreUrl}|${mentraUserId}`. */
export function partitionKey(coreUrl: string, mentraUserId: string): string {
  const core = normalizeCoreUrl(coreUrl)
  if (core === "" || mentraUserId.trim() === "") throw new Error("A Fleet partition needs a Core URL and an account")
  return sha256HexOfText(`${core}|${mentraUserId}`)
}

interface StoredEntry {
  enqueuedAt: number
  record: FleetRecord
}

interface PartitionIndex {
  count: number
  nextSeq: number
  oldest: string | null
  newest: string | null
}

interface PartitionState {
  /** The partition's record keys in queue order. */
  keys: string[]
  nextSeq: number
}

type LossKind = "dropped" | "expired"

const recordPrefix = (partition: string) => `q:${partition}:`
const indexKey = (partition: string) => `i:${partition}`
const lossKey = (partition: string) => `l:${partition}`
const sequenceKey = (partition: string) => `n:${partition}`

function recordKey(partition: string, sequence: number, recordId: string): string {
  return `${recordPrefix(partition)}${String(sequence).padStart(SEQUENCE_WIDTH, "0")}:${recordId}`
}

function isRecordKey(key: string, prefix: string): boolean {
  if (!key.startsWith(prefix)) return false
  for (let offset = 0; offset < SEQUENCE_WIDTH; offset += 1) {
    const code = key.charCodeAt(prefix.length + offset)
    if (!(code >= 48 && code <= 57)) return false
  }
  return key.charCodeAt(prefix.length + SEQUENCE_WIDTH) === 58
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function warn(message: string, error: unknown): void {
  // Never log record content: only what failed.
  console.warn(`[FleetQueue] ${message}: ${describe(error)}`)
}

function parseTime(value: string | null): number {
  return value === null ? Number.NaN : Date.parse(value)
}

function earlier(a: string | null, b: string | null): string | null {
  if (Number.isNaN(parseTime(a))) return Number.isNaN(parseTime(b)) ? null : b
  if (Number.isNaN(parseTime(b))) return a
  return parseTime(b) < parseTime(a) ? b : a
}

function later(a: string | null, b: string | null): string | null {
  if (Number.isNaN(parseTime(a))) return Number.isNaN(parseTime(b)) ? null : b
  if (Number.isNaN(parseTime(b))) return a
  return parseTime(b) > parseTime(a) ? b : a
}

function mergeLosses(a: FleetLosses, b: FleetLosses): FleetLosses {
  return {
    dropped: a.dropped + b.dropped,
    expired: a.expired + b.expired,
    from: earlier(a.from, b.from),
    to: later(a.to, b.to),
  }
}

function lossesOf(kind: LossKind, observedAts: Array<string | undefined>): FleetLosses {
  let from: string | null = null
  let to: string | null = null
  for (const observedAt of observedAts) {
    if (observedAt === undefined) continue
    from = earlier(from, observedAt)
    to = later(to, observedAt)
  }
  return {
    dropped: kind === "dropped" ? observedAts.length : 0,
    expired: kind === "expired" ? observedAts.length : 0,
    from,
    to,
  }
}

function buildQueue(store: FleetKeyValueStore, options: FleetQueueOptions): FleetQueue {
  const now = options.now ?? Date.now
  const states = new Map<string, PartitionState>()
  /** Losses that could not be written to the store; reported by the next `takeLosses` in this process. */
  const unpersistedLosses = new Map<string, FleetLosses>()
  const sequences = new Map<string, Array<[string, number]>>()

  function readJson(key: string): unknown {
    try {
      const raw = store.getString(key)
      return raw === undefined ? null : JSON.parse(raw)
    } catch {
      return null
    }
  }

  function readIndex(partition: string): PartitionIndex | null {
    const value = readJson(indexKey(partition)) as Partial<PartitionIndex> | null
    if (!value || !isCount(value.count) || !isCount(value.nextSeq)) return null
    const oldest = typeof value.oldest === "string" ? value.oldest : null
    const newest = typeof value.newest === "string" ? value.newest : null
    return {count: value.count, nextSeq: value.nextSeq, oldest, newest}
  }

  function writeIndex(partition: string, state: PartitionState): void {
    const index: PartitionIndex = {
      count: state.keys.length,
      nextSeq: state.nextSeq,
      oldest: state.keys[0] ?? null,
      newest: state.keys[state.keys.length - 1] ?? null,
    }
    store.set(indexKey(partition), JSON.stringify(index))
  }

  function readEntry(key: string): StoredEntry | null {
    const value = readJson(key) as Partial<StoredEntry> | null
    const record = value?.record as Partial<FleetRecord> | undefined
    if (!value || typeof value.enqueuedAt !== "number" || !record || typeof record.recordId !== "string") return null
    return value as StoredEntry
  }

  function readLosses(partition: string): FleetLosses | null {
    const value = readJson(lossKey(partition)) as Partial<FleetLosses> | null
    if (!value || !isCount(value.dropped) || !isCount(value.expired)) return null
    return {
      dropped: value.dropped,
      expired: value.expired,
      from: typeof value.from === "string" ? value.from : null,
      to: typeof value.to === "string" ? value.to : null,
    }
  }

  /** Counts losses, in the store if it will take them, otherwise in memory. */
  function noteLosses(partition: string, kind: LossKind, observedAts: Array<string | undefined>): void {
    if (observedAts.length === 0) return
    const delta = lossesOf(kind, observedAts)
    try {
      store.set(lossKey(partition), JSON.stringify(mergeLosses(readLosses(partition) ?? EMPTY_LOSSES, delta)))
    } catch (error) {
      warn("could not persist a loss count", error)
      unpersistedLosses.set(partition, mergeLosses(unpersistedLosses.get(partition) ?? EMPTY_LOSSES, delta))
    }
  }

  /** The partition's records, read from the store the first time the process asks. */
  function load(partition: string): PartitionState {
    const loaded = states.get(partition)
    if (loaded) return loaded
    const prefix = recordPrefix(partition)
    const keys = store
      .getAllKeys()
      .filter((key) => isRecordKey(key, prefix))
      .sort()
    const index = readIndex(partition)
    const lastKey = keys[keys.length - 1]
    const lastSequence =
      lastKey === undefined ? -1 : Number(lastKey.slice(prefix.length, prefix.length + SEQUENCE_WIDTH))
    const state: PartitionState = {keys, nextSeq: Math.max(index?.nextSeq ?? 0, lastSequence + 1)}
    states.set(partition, state)
    const inStep =
      index !== null &&
      index.count === keys.length &&
      index.nextSeq === state.nextSeq &&
      index.oldest === (keys[0] ?? null) &&
      index.newest === (lastKey ?? null)
    if (!inStep && (keys.length > 0 || index !== null)) {
      try {
        writeIndex(partition, state)
      } catch (error) {
        warn("could not repair the index", error)
      }
    }
    return state
  }

  /** Removes the first `count` records of the partition (they are already counted as lost). */
  function removeOldest(state: PartitionState, count: number): void {
    for (const key of state.keys.splice(0, count)) store.remove(key)
  }

  /** Discards records that cannot be read, counting them as dropped. */
  function discardUnreadable(partition: string, state: PartitionState, unreadable: string[]): void {
    noteLosses(
      partition,
      "dropped",
      unreadable.map(() => undefined),
    )
    const gone = new Set(unreadable)
    for (const key of unreadable) store.remove(key)
    state.keys = state.keys.filter((key) => !gone.has(key))
    writeIndex(partition, state)
  }

  function trimToCapacity(partition: string, state: PartitionState): void {
    const excess = state.keys.length - FLEET_LIMITS.phoneQueueMaxRecords
    if (excess <= 0) return
    const observedAts = state.keys.slice(0, excess).map((key) => readEntry(key)?.record.observedAt)
    noteLosses(partition, "dropped", observedAts)
    removeOldest(state, excess)
  }

  function expire(partition: string, state: PartitionState, at: number): void {
    const cutoff = at - FLEET_LIMITS.phoneQueueMaxAgeMs
    const expired: Array<string | undefined> = []
    const unreadable: Array<undefined> = []
    let head = 0
    // Records are in enqueue order, so the expired ones are a prefix of the queue. If the wall clock was stepped back,
    // a young record can sit ahead of older ones; those wait until it ages out, which only delays their expiry.
    for (; head < state.keys.length; head += 1) {
      const entry = readEntry(state.keys[head])
      if (entry === null) unreadable.push(undefined)
      else if (entry.enqueuedAt < cutoff) expired.push(entry.record.observedAt)
      else break
    }
    if (head === 0) return
    noteLosses(partition, "expired", expired)
    noteLosses(partition, "dropped", unreadable)
    removeOldest(state, head)
    writeIndex(partition, state)
  }

  function loadSequences(partition: string): Array<[string, number]> {
    const cached = sequences.get(partition)
    if (cached) return cached
    const stored = readJson(sequenceKey(partition))
    const counters = (Array.isArray(stored) ? stored : []).filter(
      (item): item is [string, number] => Array.isArray(item) && typeof item[0] === "string" && isCount(item[1]),
    )
    sequences.set(partition, counters)
    return counters
  }

  return {
    enqueue(partition, record) {
      let state: PartitionState
      try {
        state = load(partition)
        const key = recordKey(partition, state.nextSeq, record.recordId)
        store.set(key, JSON.stringify({enqueuedAt: now(), record}))
        state.keys.push(key)
        state.nextSeq += 1
      } catch (error) {
        warn("could not store a record", error)
        noteLosses(partition, "dropped", [record?.observedAt])
        return
      }
      try {
        trimToCapacity(partition, state)
        writeIndex(partition, state)
      } catch (error) {
        warn("could not update the index", error)
      }
    },

    nextBatch(partition, maxRecords, maxBytes) {
      if (!(maxRecords >= 1)) return []
      const state = load(partition)
      const batch: FleetRecord[] = []
      const unreadable: string[] = []
      let bytes = 0
      for (const key of state.keys) {
        if (batch.length >= maxRecords) break
        const entry = readEntry(key)
        if (entry === null) {
          unreadable.push(key)
          continue
        }
        const size = utf8ByteLength(JSON.stringify(entry.record))
        if (batch.length > 0 && !(bytes + size <= maxBytes)) break
        batch.push(entry.record)
        bytes += size
      }
      if (unreadable.length > 0) discardUnreadable(partition, state, unreadable)
      return batch
    },

    remove(partition, recordIds) {
      if (recordIds.length === 0) return
      const state = load(partition)
      const wanted = new Set(recordIds)
      const idOffset = recordPrefix(partition).length + SEQUENCE_WIDTH + 1
      const kept: string[] = []
      for (const key of state.keys) {
        if (wanted.has(key.slice(idOffset))) store.remove(key)
        else kept.push(key)
      }
      if (kept.length === state.keys.length) return
      state.keys = kept
      writeIndex(partition, state)
    },

    takeLosses(partition, at) {
      expire(partition, load(partition), at)
      const losses = mergeLosses(
        readLosses(partition) ?? EMPTY_LOSSES,
        unpersistedLosses.get(partition) ?? EMPTY_LOSSES,
      )
      if (losses.dropped === 0 && losses.expired === 0) return {...EMPTY_LOSSES}
      store.remove(lossKey(partition))
      unpersistedLosses.delete(partition)
      return losses
    },

    clearPartition(partition) {
      const state = load(partition)
      for (const key of state.keys) store.remove(key)
      store.remove(indexKey(partition))
      store.remove(lossKey(partition))
      store.remove(sequenceKey(partition))
      state.keys = []
      state.nextSeq = 0
      unpersistedLosses.delete(partition)
      sequences.delete(partition)
    },

    size(partition) {
      return load(partition).keys.length
    },

    nextSequence(partition, collectorSessionId) {
      const counters = loadSequences(partition)
      const position = counters.findIndex(([id]) => id === collectorSessionId)
      const next = position >= 0 ? counters[position][1] : 0
      if (position >= 0) counters.splice(position, 1)
      counters.push([collectorSessionId, next + 1])
      while (counters.length > MAX_TRACKED_COLLECTOR_SESSIONS) counters.shift()
      try {
        store.set(sequenceKey(partition), JSON.stringify(counters))
      } catch (error) {
        // The counter still increases for the life of this process.
        warn("could not persist a sequence counter", error)
      }
      return next
    },
  }
}

let sharedQueue: FleetQueue | undefined

/**
 * Without a store, the app's one shared queue over the `mentra-fleet` MMKV instance. A queue keeps its view of a
 * store in memory, so two queues over one store would not see each other's writes; share this one.
 *
 * With a store (tests), a new queue over it. `options` apply only then.
 */
export function createFleetQueue(store?: FleetKeyValueStore, options: FleetQueueOptions = {}): FleetQueue {
  if (store === undefined) return (sharedQueue ??= buildQueue(getFleetStore(), {}))
  return buildQueue(store, options)
}
