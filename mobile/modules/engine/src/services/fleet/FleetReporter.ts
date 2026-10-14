/**
 * The Fleet reporter: runs the collector for the signed-in account and delivers its records to the phone's own Core.
 *
 * A run is one account on one Core, which is one partition of the durable queue. Each run starts the collector with
 * a new collector session and uploads only its own partition, as that account, to that Core: every request goes
 * through `reportAs`, which sends nothing unless the client still holds that account's token for that Core. A
 * sign-out, a sign-in as someone else or a client rebuilt for another Core ends the run (the collector writes its
 * final checkpoints into the old partition) and starts the next. An old partition's records wait in the queue until
 * their account signs in to their Core again, or expire into a coverage gap; they are never sent as anyone else.
 *
 * Uploads go a minute after records arrive, or at once when 100 are waiting, at most 500 records (and 1 MB of them)
 * per request. With nothing waiting the uploader sets no timer: the next record wakes it. What each answer does:
 * - accepted or duplicate: the record is removed. Rejected: removed, with a `record_rejected` gap over its
 *   observation time. Retryable: kept, and the next request waits at least its Retry-After.
 * - not installed: collection stops and the partition is dropped, until the next sign-in or engine start.
 * - no Fleet route (a 404 without Fleet's code: a Core from before Fleet, or a proxy): collection stops until the next
 *   sign-in or engine start, as for not installed, but the partition is kept; its records expire after 7 days.
 * - unavailable, no answer within a minute, an authentication failure, or anything unexpected: everything is kept,
 *   and the next attempt waits min(30 min, 30 s * 2^n) +-20%, or Retry-After when given (at most 30 minutes). Only
 *   an answer that settles a record (accepted, duplicate or rejected) resets n.
 * - forbidden: everything is kept, and the next attempt waits 30 minutes.
 * - too large, or refused as a batch: the batch is halved; a single record still refused is removed with a gap. The
 *   batch does not grow back to a refused size until 10 sends have succeeded below it.
 *
 * After any failure the next batch is a probe of 5 records, and each success doubles the batch again, up to 500. A
 * batch of a single record is never sent straight after another request: it waits the normal minute.
 *
 * Before each upload, the records the queue dropped or expired become one coverage gap, queued in the same tick.
 *
 * Fleet is decided by the phone's Core alone. The reporter reads no deployment or telemetry setting, and nothing it
 * does can block the engine: every entry point catches its own failures.
 */
import {FLEET_LIMITS, FLEET_SCHEMA_VERSION, type FleetRecord} from "@mentra/cloud-protocol"
import {AppState, Platform} from "react-native"

import {BgTimer} from "../../utils/timers"
import {
  cloudClientService,
  type CoreSession,
  type CoreSessionChange,
  type FleetSendOutcome,
} from "../CloudClientService"
import {createFleetCollector, type FleetCollector} from "./fleetCollector"
import {newId, phoneDeviceId} from "./fleetIds"
import {createFleetQueue, partitionKey, type FleetLosses, type FleetQueue} from "./fleetQueue"

export interface FleetReporter {
  /** Sweeps the queue, starts collecting for the signed-in account (at once when it is known) and starts uploading. */
  start(): void
  /** Ends collection (`engine_stopped`), abandons a request in flight and drops every timer and listener. */
  stop(): Promise<void>
}

type CloudClient = typeof cloudClientService
/** What the reporter uses of the engine's Core client. */
export type FleetReporterCloud = Pick<CloudClient, "getCoreSession" | "resolveCoreSession" | "onCoreSessionChanged"> & {
  core: {fleet: Pick<CloudClient["core"]["fleet"], "reportAs">}
}

export interface FleetReporterDeps {
  /** Defaults to the engine's Core client. */
  cloud?: FleetReporterCloud
  /** Defaults to the app's shared queue. */
  queue?: FleetQueue
  /** Builds the collector over the queue the reporter hands it. Defaults to the engine's collector. */
  createCollector?: (queue: FleetQueue) => FleetCollector
  now?: () => number
  random?: () => number
}

const UPLOAD_INTERVAL_MS = 60_000
/** This many records waiting are sent at once rather than at the next minute. */
const UPLOAD_NOW_RECORDS = 100
const MAX_BATCH_RECORDS = FLEET_LIMITS.maxRecordsPerBatch
/** After a failure the next batch is this small, and doubles with each success. */
const PROBE_BATCH_RECORDS = 5
/** A batch size Core refused is not tried again until this many sends have succeeded below it. */
const BATCH_CAP_RESET_SENDS = 10
/** The records' own JSON; the rest of the 1 MiB request limit is headroom for the envelope and the commas. */
const MAX_BATCH_BYTES = 1_000_000
const BACKOFF_BASE_MS = 30_000
const BACKOFF_MAX_MS = 30 * 60_000
/** A Retry-After of 0 still waits this long, so a server that keeps answering 0 cannot make the loop spin. */
const MIN_RETRY_MS = 1_000
/** `sweepExpired` scans the whole store, so it runs at start and then at most this often. */
const SWEEP_INTERVAL_MS = 60 * 60_000
/** A request still unanswered after this long is abandoned, and counts as no answer. */
const REQUEST_TIMEOUT_MS = 60_000
const NO_ANSWER: FleetSendOutcome = {kind: "unavailable", retryAfterSeconds: null}

/** min(30 min, 30 s * 2^failures), times a jitter between 0.8 and 1.2. */
export function backoffDelayMs(failures: number, random: () => number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures))
  return Math.round(base * (0.8 + 0.4 * random()))
}

/** A server's Retry-After, as a delay the loop can live with. */
function retryDelayMs(seconds: number): number {
  return Math.min(BACKOFF_MAX_MS, Math.max(MIN_RETRY_MS, seconds * 1_000))
}

function iso(wall: number): string {
  return new Date(wall).toISOString()
}

function timeOf(value: string | null): number | null {
  if (value === null) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function warn(what: string, error: unknown): void {
  // Only the failure's message: never a record, an account or a token.
  console.warn(`FleetReporter: ${what} failed:`, error instanceof Error ? error.message : "unknown error")
}

type GapPayload = Extract<FleetRecord, {kind: "coverage_gap"}>["payload"]
/** Fleet's answer for one record, as the Core client read it. */
type AckResult = Extract<FleetSendOutcome, {kind: "results"}>["ack"]["results"][number]

/** One account on one Core, from the start of its collection to the end. */
interface Run {
  /** Who the run sends as. The Core URL follows the client's spelling of the same Core. */
  session: {coreUrl: string; mentraUserId: string}
  readonly partition: string
  readonly collectorSessionId: string
  /** Aborted when the run ends, which abandons its request in flight. */
  readonly controller: AbortController
  ended: boolean
  timer: number | null
  /** When the next attempt is due (`now()` time). */
  dueAt: number
  /** The next attempt waits out a backoff the server or a failure asked for. */
  backingOff: boolean
  uploading: boolean
  /** Failed attempts since the last answer that settled a record: the n of the backoff. */
  failures: number
  batchLimit: number
  /** Below the batch sizes Core refused lately: the limit does not grow back to a refused size for a while. */
  batchCap: number
  /** Sends that succeeded since Core last refused a batch; at BATCH_CAP_RESET_SENDS the cap is lifted. */
  sendsSinceRefusal: number
  batchRefusalLogged: boolean
}

/** When to try next, and whether that wait is a backoff. */
interface Next {
  delayMs: number
  backingOff: boolean
}
const AFTER_INTERVAL: Next = {delayMs: UPLOAD_INTERVAL_MS, backingOff: false}
const AT_ONCE: Next = {delayMs: 0, backingOff: false}
/** Nothing is waiting: the uploader sets no timer until a record arrives. */
const ASLEEP = null

export function createFleetReporter(deps: FleetReporterDeps = {}): FleetReporter {
  const cloud = deps.cloud ?? cloudClientService
  const queue = deps.queue ?? createFleetQueue()
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random

  let started = false
  let run: Run | null = null
  /** The partition its Core said has no Fleet: nothing is collected for it until a sign-in or the next start. */
  let notInstalled: string | null = null
  /** Bumped by every change of session, so only the latest resolution of the account is applied. */
  let resolution = 0
  let lastSweepAt = 0
  const cleanups: Array<() => void> = []

  // The collector writes through this view of the queue, which wakes the uploader once 100 records wait. It
  // delegates at call time, so the shared queue stays the only queue over the store.
  const collectorQueue: FleetQueue = {
    enqueue(partition, record) {
      queue.enqueue(partition, record)
      try {
        onEnqueued(partition)
      } catch (error) {
        warn("waking the uploader", error)
      }
    },
    nextBatch: (partition, maxRecords, maxBytes) => queue.nextBatch(partition, maxRecords, maxBytes),
    remove: (partition, recordIds) => queue.remove(partition, recordIds),
    takeLosses: (partition, at) => queue.takeLosses(partition, at),
    sweepExpired: (at) => queue.sweepExpired(at),
    clearPartition: (partition) => queue.clearPartition(partition),
    size: (partition) => queue.size(partition),
    nextSequence: (partition, collectorSessionId) => queue.nextSequence(partition, collectorSessionId),
  }
  const collector = (deps.createCollector ?? ((q: FleetQueue) => createFleetCollector({queue: q})))(collectorQueue)

  function guard(what: string, work: () => void): void {
    try {
      work()
    } catch (error) {
      warn(what, error)
    }
  }

  // --- runs ----------------------------------------------------------------------------------------------------

  function beginRun(session: Run["session"], partition: string): void {
    const r: Run = {
      session,
      partition,
      collectorSessionId: newId(),
      controller: new AbortController(),
      ended: false,
      timer: null,
      dueAt: 0,
      backingOff: false,
      uploading: false,
      failures: 0,
      batchLimit: MAX_BATCH_RECORDS,
      batchCap: MAX_BATCH_RECORDS,
      sendsSinceRefusal: 0,
      batchRefusalLogged: false,
    }
    run = r
    collector.start({partition, collectorSessionId: r.collectorSessionId})
    collector.flushCheckpoint()
    schedule(r, afterSend(r))
  }

  function endRun(reason: "engine_stopped" | "account_changed" | "not_installed"): void {
    const r = run
    if (!r) return
    run = null
    r.ended = true
    if (r.timer !== null) BgTimer.clearTimeout(r.timer)
    r.timer = null
    r.controller.abort()
    // The collector writes its final checkpoints into the run's partition.
    collector.stop(reason)
  }

  /**
   * Core said Fleet is not there for this session: nothing more is collected for or sent from the partition until the
   * next sign-in or engine start. Only Fleet's own "not installed" drops what was queued; a Core without the route
   * (or a proxy answering for it) proves nothing about Fleet, so its records wait in the queue, and expire there.
   */
  function stopForSession(r: Run, drop: boolean): void {
    notInstalled = r.partition
    endRun("not_installed")
    if (drop) queue.clearPartition(r.partition)
  }

  /** Collects for `session` if it names an account; otherwise collects for no one. */
  function applySession(session: CoreSession | null): void {
    if (!started) return
    const user = session?.mentraUserId
    if (!session || !user) {
      endRun("account_changed")
      return
    }
    const partition = partitionKey(session.coreUrl, user)
    if (run?.partition === partition) {
      // The same Core, maybe spelled differently by a rebuilt client: send as the client spells it now.
      if (run.session.coreUrl !== session.coreUrl) run.session = {coreUrl: session.coreUrl, mentraUserId: user}
      return
    }
    endRun("account_changed")
    if (partition === notInstalled) return
    beginRun({coreUrl: session.coreUrl, mentraUserId: user}, partition)
  }

  /** Asks the client who it speaks for now (refreshing its token if needed) and follows. The latest ask wins. */
  async function resolveAndApply(): Promise<void> {
    const mine = ++resolution
    let session: CoreSession | null
    try {
      session = await cloud.resolveCoreSession()
    } catch (error) {
      // Nothing learned: keep what is running.
      warn("resolving the account", error)
      return
    }
    if (mine !== resolution || !started) return
    guard("following the account", () => applySession(session))
  }

  function onSessionChanged(change: CoreSessionChange): void {
    if (!started) return
    if (change.reason === "signed_out") {
      // A resolution still under way must not bring the account back.
      resolution += 1
      endRun("account_changed")
      return
    }
    // A new authenticated session asks Core again, including a Core that said it has no Fleet.
    if (change.reason === "signed_in") notInstalled = null
    // What the change already names is enough to stop collecting for an account or a Core that is no longer current.
    const r = run
    if (r) {
      let partition: string | null = null
      try {
        partition = change.coreUrl ? partitionKey(change.coreUrl, change.mentraUserId ?? r.session.mentraUserId) : null
      } catch {
        partition = null
      }
      if (partition !== r.partition) endRun("account_changed")
    }
    void resolveAndApply()
  }

  // --- the upload loop -----------------------------------------------------------------------------------------

  function schedule(r: Run, next: Next | typeof ASLEEP): void {
    if (r.ended) return
    if (r.timer !== null) BgTimer.clearTimeout(r.timer)
    r.timer = null
    if (next === ASLEEP) {
      r.backingOff = false
      return
    }
    r.backingOff = next.backingOff
    r.dueAt = now() + next.delayMs
    r.timer = BgTimer.setTimeout(() => {
      r.timer = null
      guard("upload tick", () => tick(r))
    }, next.delayMs)
  }

  /**
   * A record arrived. An uploader that was asleep is woken (a minute from now, or at once when 100 wait); one that is
   * due anyway is hurried once 100 wait. Deferred to a timer either way: this runs inside whatever the collector is
   * reacting to. While a request is out or the loop is backing off, the next attempt picks the record up.
   */
  function onEnqueued(partition: string): void {
    const r = run
    if (!r || r.partition !== partition || r.uploading || r.backingOff) return
    if (r.timer === null) schedule(r, afterSend(r))
    else if (r.dueAt > now() && queue.size(partition) >= UPLOAD_NOW_RECORDS && r.batchLimit > 1) schedule(r, AT_ONCE)
  }

  function sweepIfDue(at: number): void {
    // A clock set back sweeps again rather than waiting for it to catch up.
    if (at >= lastSweepAt && at - lastSweepAt < SWEEP_INTERVAL_MS) return
    lastSweepAt = at
    queue.sweepExpired(at)
  }

  function tick(r: Run): void {
    if (r !== run || r.ended) return
    r.backingOff = false
    guard("sweeping the queue", () => sweepIfDue(now()))
    if (!r.uploading) void upload(r)
  }

  async function upload(r: Run): Promise<void> {
    r.uploading = true
    let next: Next | typeof ASLEEP
    try {
      next = await attempt(r)
    } catch (error) {
      // Whatever went wrong, the loop goes on: back off and try again.
      warn("upload", error)
      next = failed(r, null)
    } finally {
      r.uploading = false
    }
    if (r === run) schedule(r, next)
  }

  async function attempt(r: Run): Promise<Next | typeof ASLEEP> {
    const at = now()
    // takeLosses clears the counts it returns, so their gap is queued before anything else can happen.
    recordLosses(r, queue.takeLosses(r.partition, at), at)
    const records = queue.nextBatch(r.partition, r.batchLimit, MAX_BATCH_BYTES)
    if (records.length === 0) return ASLEEP
    let outcome: FleetSendOutcome
    try {
      outcome = await send(r, records)
    } catch (error) {
      if (r.ended) return ASLEEP
      throw error
    }
    // An answer for a run that is over changes nothing: its records are sent again as their own account later.
    if (r.ended) return ASLEEP
    return answered(r, records, outcome)
  }

  /**
   * Sends one batch as the run's account. The request is abandoned when the run ends or when it has gone a minute
   * without an answer, so a request that hangs cannot keep the run from ever trying again; an abandoned request is
   * no answer (`unavailable`), and whatever it says later is ignored.
   */
  async function send(r: Run, records: FleetRecord[]): Promise<FleetSendOutcome> {
    const request = new AbortController()
    let timer: number | null = null
    let stopWaiting: () => void = () => {}
    const abandoned = new Promise<FleetSendOutcome>((resolve) => {
      stopWaiting = () => resolve(NO_ANSWER)
    })
    // Lets go of the timer and the run's signal at once, so a run that ends leaves nothing of the request behind.
    const release = () => {
      if (timer !== null) BgTimer.clearTimeout(timer)
      timer = null
      r.controller.signal.removeEventListener("abort", abandon)
    }
    const abandon = () => {
      release()
      request.abort()
      stopWaiting()
    }
    r.controller.signal.addEventListener("abort", abandon)
    timer = BgTimer.setTimeout(() => {
      timer = null
      abandon()
    }, REQUEST_TIMEOUT_MS)
    try {
      if (r.controller.signal.aborted) abandon()
      const answer = cloud.core.fleet.reportAs(
        r.session,
        {schemaVersion: FLEET_SCHEMA_VERSION, records},
        {signal: request.signal},
      )
      // Once abandoned, how the request ends is of no interest, and must not surface as an unhandled rejection.
      answer.catch(() => {})
      return await Promise.race([answer, abandoned])
    } finally {
      release()
    }
  }

  function answered(r: Run, records: FleetRecord[], outcome: FleetSendOutcome): Next | typeof ASLEEP {
    switch (outcome.kind) {
      case "results":
        return settle(r, records, outcome.ack.results)
      case "not_installed":
        stopForSession(r, true)
        return ASLEEP
      case "no_fleet_route":
        stopForSession(r, false)
        return ASLEEP
      case "unavailable":
        return failed(r, outcome.retryAfterSeconds)
      case "unauthorized":
        // The client refreshed the token once; records are never dropped for credentials.
        return failed(r, null)
      case "forbidden":
        // Core will not take this account's reports now; that changes slowly, so wait the longest backoff.
        r.batchLimit = Math.min(r.batchLimit, PROBE_BATCH_RECORDS)
        r.failures += 1
        return {delayMs: Math.round(BACKOFF_MAX_MS * (0.8 + 0.4 * random())), backingOff: true}
      case "batch_too_large":
        return shrink(r, records)
      case "batch_invalid":
        if (!r.batchRefusalLogged) {
          r.batchRefusalLogged = true
          console.warn(`FleetReporter: Core refused a batch (${outcome.code}); sending smaller batches`)
        }
        return shrink(r, records)
      case "session_changed":
        // The client speaks for someone else now. Nothing was sent; follow it.
        void resolveAndApply()
        return failed(r, null)
    }
  }

  function failed(r: Run, retryAfterSeconds: number | null): Next {
    // Whatever went wrong may still be wrong: the next attempt sends a small batch, not the whole backlog again.
    r.batchLimit = Math.min(r.batchLimit, PROBE_BATCH_RECORDS)
    const delayMs =
      retryAfterSeconds != null && Number.isFinite(retryAfterSeconds)
        ? retryDelayMs(retryAfterSeconds)
        : backoffDelayMs(r.failures, random)
    r.failures += 1
    return {delayMs, backingOff: true}
  }

  function settle(r: Run, records: FleetRecord[], results: AckResult[]): Next | typeof ASLEEP {
    const removed: string[] = []
    const rejected: FleetRecord[] = []
    const reasons = new Map<string, number>()
    const answeredIndexes = new Set<number>()
    let retryable = false
    let retryAfterSeconds: number | null = null
    for (const result of results) {
      const record = records[result.index]
      // A result counts only for the record at its index, and only if it names that record.
      if (!record || answeredIndexes.has(result.index)) continue
      if (result.recordId !== undefined && result.recordId !== record.recordId) continue
      answeredIndexes.add(result.index)
      if (result.status === "accepted" || result.status === "duplicate") {
        removed.push(record.recordId)
      } else if (result.status === "rejected") {
        removed.push(record.recordId)
        rejected.push(record)
        const reason = result.reasonCode ?? "unknown"
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
      } else {
        retryable = true
        if (result.retryAfterSeconds !== undefined) {
          retryAfterSeconds = Math.max(retryAfterSeconds ?? 0, result.retryAfterSeconds)
        }
      }
    }
    // An answer that settles nothing is no answer, and one that only says "retry" is a failure to deliver: neither
    // resets the backoff, or a Core answering retryable to everything would get a full batch every 30 s forever.
    if (removed.length === 0) return failed(r, retryable ? retryAfterSeconds : null)

    r.failures = 0
    r.sendsSinceRefusal += 1
    if (r.sendsSinceRefusal >= BATCH_CAP_RESET_SENDS) r.batchCap = MAX_BATCH_RECORDS
    r.batchLimit = Math.min(r.batchCap, r.batchLimit * 2)
    const at = now()
    queue.remove(r.partition, removed)
    for (const record of rejected) recordRejected(r, record, at)
    if (rejected.length > 0) {
      const summary = [...reasons].map(([reason, count]) => `${reason} x${count}`).join(", ")
      console.warn(`FleetReporter: Core rejected ${rejected.length} record(s): ${summary}`)
    }
    if (retryable) {
      return {
        delayMs: retryAfterSeconds !== null ? retryDelayMs(retryAfterSeconds) : backoffDelayMs(0, random),
        backingOff: true,
      }
    }
    return afterSend(r)
  }

  /**
   * When to send next, by what waits: nothing, and the uploader sleeps until a record arrives; 100 or more, and the
   * next send goes at once, unless it would carry a single record (single records are spaced by the normal minute,
   * so a run reduced to them cannot fire one request after another); otherwise a minute from now.
   */
  function afterSend(r: Run): Next | typeof ASLEEP {
    const waiting = queue.size(r.partition)
    if (waiting === 0) return ASLEEP
    return waiting >= UPLOAD_NOW_RECORDS && r.batchLimit > 1 ? AT_ONCE : AFTER_INTERVAL
  }

  /**
   * Too large, or refused as a batch: halve it, and do not grow back to this size until 10 sends have succeeded below
   * it (a proxy's body limit would otherwise refuse every other request, and one spurious refusal would otherwise pin
   * the run to tiny batches). A single record still refused goes, with a gap over its time.
   */
  function shrink(r: Run, records: FleetRecord[]): Next {
    if (records.length > 1) {
      r.batchCap = Math.min(r.batchCap, records.length - 1)
      r.batchLimit = Math.max(1, Math.floor(records.length / 2))
      r.sendsSinceRefusal = 0
      return r.batchLimit > 1 ? AT_ONCE : AFTER_INTERVAL
    }
    const [record] = records
    queue.remove(r.partition, [record.recordId])
    recordRejected(r, record, now())
    // The refusals that narrowed the batch down to this record may have been this record's, not the batch size's.
    r.batchCap = MAX_BATCH_RECORDS
    console.warn("FleetReporter: Core refused a single record; it was removed")
    // Halving cannot help any further. Wait before the next record, so a Core that refuses every batch cannot
    // empty the queue at once.
    return failed(r, null)
  }

  // --- coverage gaps -------------------------------------------------------------------------------------------

  function enqueueGap(r: Run, payload: GapPayload, at: number): void {
    try {
      queue.enqueue(r.partition, {
        schemaVersion: FLEET_SCHEMA_VERSION,
        recordId: newId(),
        phoneDeviceId: phoneDeviceId(),
        collectorSessionId: r.collectorSessionId,
        sequence: queue.nextSequence(r.partition, r.collectorSessionId),
        observedAt: iso(at),
        // A gap measures nothing.
        capabilities: [],
        kind: "coverage_gap",
        payload,
      })
    } catch (error) {
      warn("recording a coverage gap", error)
    }
  }

  function recordRejected(r: Run, record: FleetRecord, at: number): void {
    // A refused gap gets no gap of its own, so a rejection can never feed itself.
    if (record.kind === "coverage_gap") return
    const time = iso(timeOf(record.observedAt) ?? at)
    enqueueGap(r, {reason: "record_rejected", from: time, to: time, droppedRecordCount: 1}, at)
  }

  /**
   * One gap for what the queue dropped (it was full) or expired (7 days old). When no lost record had a readable
   * time, the gap covers the 7 days before now: the longest a record can wait in the queue.
   */
  function recordLosses(r: Run, losses: FleetLosses, at: number): void {
    const count = losses.dropped + losses.expired
    if (count <= 0) return
    const fromMs = timeOf(losses.from)
    const toMs = timeOf(losses.to)
    const end = toMs ?? Math.max(at, fromMs ?? at)
    const start = fromMs ?? end - FLEET_LIMITS.phoneQueueMaxAgeMs
    enqueueGap(
      r,
      {
        reason: losses.dropped > 0 ? "queue_dropped" : "queue_expired",
        from: iso(Math.min(start, end)),
        to: iso(Math.max(start, end)),
        droppedRecordCount: count,
      },
      at,
    )
  }

  // --- the app -------------------------------------------------------------------------------------------------

  function onAppState(state: string): void {
    // iOS may suspend the process once it is in the background: checkpoint and try once. Nothing is promised after.
    if (state !== "background") return
    const r = run
    if (!r) return
    collector.flushCheckpoint()
    if (r.uploading || r.backingOff) return
    if (r.timer !== null) BgTimer.clearTimeout(r.timer)
    r.timer = null
    void upload(r)
  }

  return {
    start() {
      if (started) return
      started = true
      notInstalled = null
      guard("sweeping the queue", () => {
        lastSweepAt = now()
        queue.sweepExpired(lastSweepAt)
      })
      guard("listening for account changes", () => {
        cleanups.push(
          cloud.onCoreSessionChanged((change) => guard("following a session change", () => onSessionChanged(change))),
        )
      })
      if (Platform.OS === "ios") {
        guard("listening for the app state", () => {
          const subscription = AppState.addEventListener("change", (state) =>
            guard("going to the background", () => onAppState(state)),
          )
          cleanups.push(() => subscription.remove())
        })
      }
      guard("starting", () => {
        // Known at once in the usual case (the engine synced the token just before), so the collector is listening
        // before engine.start() returns, and so before the host restores miniapps.
        const session = cloud.getCoreSession()
        if (session?.mentraUserId) applySession(session)
        else void resolveAndApply()
      })
    },

    async stop() {
      if (!started) return
      started = false
      resolution += 1
      guard("stopping", () => endRun("engine_stopped"))
      for (const cleanup of cleanups.splice(0)) guard("removing a listener", cleanup)
      notInstalled = null
    },
  }
}

let appReporter: FleetReporter | null = null

/** Starts the app's reporter, over the shared queue and the engine's Core client. Never throws. */
export function startFleetReporter(): void {
  try {
    appReporter ??= createFleetReporter()
    appReporter.start()
  } catch (error) {
    warn("start", error)
  }
}

/** Stops the app's reporter. */
export async function stopFleetReporter(): Promise<void> {
  await appReporter?.stop()
}
