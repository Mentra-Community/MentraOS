import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import {createMMKV, type MMKV} from "react-native-mmkv"

import {requestGlassesReportLogs, submitAutomaticReport} from "../facades/reports"
import {BgTimer} from "../utils/timers"
import {cloudClientService} from "./CloudClientService"

const LOG_TAG = "BesCrashReport"
const STORAGE_ID = "mentra-bes-crash-reports"
const ENTRY_PREFIX = "incident:"
const MAX_STORED_INCIDENTS = 64
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000]
const RETRY_INTERVAL_MS = 1_800_000
const MAX_RETRIES = 8
const INCIDENT_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const REPORT_ID_PATTERN = /^rep_[A-Za-z0-9]+$/

export type BesCrashReason = "bes_crash" | "bes_unexpected_reset"

// TODO(OS-1988 integration): replace with BesCrashDetectedEvent from @mentra/bluetooth-sdk.
export interface BesCrashDetectedEvent {
  type: "bes_crash_detected"
  incidentKey: string
  reason: BesCrashReason
  state: string
  reportId: string | null
  summary?: {
    attribution?: "match" | "older" | "unknown"
    dumpId?: string | null
    bootId?: string | null
    resetHw?: number
    resetSw?: number
    crashUnixMs?: number | null
    coveredFromMs?: number
    coveredToMs?: number
    traceGaps?: number
    truncated?: boolean
    torn?: boolean
    tailCaptured?: boolean
    dumpGap?: boolean
    evictedCount?: number
    recentEvictions?: Array<{incidentKey?: string; reason?: string; bytes?: number; ms?: number}>
  }
}

// TODO(OS-1988 integration): drop once BluetoothSdk declares the event and method.
interface BesCrashBluetoothSdk {
  addListener(eventName: "bes_crash_detected", listener: (event: BesCrashDetectedEvent) => void): {remove(): void}
  sendBesCrashReported(incidentKey: string, reportId: string): Promise<void>
}
const besCrashSdk = BluetoothSdk as unknown as BesCrashBluetoothSdk

export type BesCrashReportOutcome =
  | {status: "reported"; reportId: string; submitted: boolean}
  | {status: "ack_failed"; reportId: string; error: string}
  | {status: "failed"; error: string}
  | {status: "ignored"; reason: string}

interface StoredIncident {
  reportId: string
  savedMs: number
}

interface PendingRetry {
  event: BesCrashDetectedEvent
  retriesUsed: number
  timer: number | undefined
}

let subscription: {remove(): void} | null = null
let store: MMKV | null = null
let generation = 0
const inFlight = new Map<string, Promise<BesCrashReportOutcome>>()
const retries = new Map<string, PendingRetry>()

function incidentStore(): MMKV {
  return (store ??= createMMKV({id: STORAGE_ID}))
}

// The user id is URI-encoded so it cannot contain the ":" that incidentKeys may use.
function entryKey(userId: string, incidentKey: string): string {
  return `${ENTRY_PREFIX}${encodeURIComponent(userId)}:${incidentKey}`
}

function readStoredReportId(userId: string, incidentKey: string): string | null {
  const raw = incidentStore().getString(entryKey(userId, incidentKey))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<StoredIncident>
    return typeof parsed.reportId === "string" && REPORT_ID_PATTERN.test(parsed.reportId) ? parsed.reportId : null
  } catch {
    return null
  }
}

function storeReportId(userId: string, incidentKey: string, reportId: string): void {
  const entries = incidentStore()
  entries.set(entryKey(userId, incidentKey), JSON.stringify({reportId, savedMs: Date.now()} satisfies StoredIncident))
  const keys = entries.getAllKeys().filter((key) => key.startsWith(ENTRY_PREFIX))
  if (keys.length <= MAX_STORED_INCIDENTS) return
  const byAge = keys
    .map((key) => {
      try {
        return {
          key,
          savedMs: Number((JSON.parse(entries.getString(key) ?? "{}") as Partial<StoredIncident>).savedMs) || 0,
        }
      } catch {
        return {key, savedMs: 0}
      }
    })
    .sort((a, b) => a.savedMs - b.savedMs)
  for (const {key} of byAge.slice(0, keys.length - MAX_STORED_INCIDENTS)) entries.remove(key)
}

export function besCrashTriggerReason(event: Pick<BesCrashDetectedEvent, "incidentKey" | "reason">): BesCrashReason {
  if (event.reason === "bes_crash" || event.reason === "bes_unexpected_reset") return event.reason
  return event.incidentKey.includes("-reset-") ? "bes_unexpected_reset" : "bes_crash"
}

const isoOrUnknown = (ms: number | null | undefined): string =>
  typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : "unknown"

const hex = (value: number | undefined): string => (typeof value === "number" ? `0x${value.toString(16)}` : "unknown")

const yesNo = (value: boolean | undefined): string => (value === undefined ? "unknown" : value ? "yes" : "no")

const ATTRIBUTION_TEXT: Record<string, string> = {
  match: "match (the dump belongs to the boot ASG observed before this one)",
  older:
    "older (the dump is from an earlier boot than the one ASG last observed; a newer reset is reported separately)",
  unknown: "unknown (ASG had no previous boot_id, or the dump has none; this is the only incident for the transition)",
}

export function describeBesCrash(event: BesCrashDetectedEvent, reason: BesCrashReason): string {
  const summary = event.summary ?? {}
  const covered =
    typeof summary.coveredFromMs === "number" && typeof summary.coveredToMs === "number" && summary.coveredToMs > 0
      ? `${isoOrUnknown(summary.coveredFromMs)} .. ${isoOrUnknown(summary.coveredToMs)} (${summary.coveredFromMs}..${
          summary.coveredToMs
        })`
      : "none captured"
  const recent = (summary.recentEvictions ?? [])
    .map(
      (eviction) =>
        `${eviction.incidentKey ?? "unknown"} (${eviction.reason ?? "unknown"}, ${
          eviction.bytes ?? "?"
        } bytes, ${isoOrUnknown(eviction.ms)})`,
    )
    .join("; ")
  return [
    reason === "bes_crash"
      ? "Mentra Live BES firmware crashed and saved a crash dump."
      : "Mentra Live BES firmware reset unexpectedly without a crash dump.",
    `incidentKey: ${event.incidentKey}`,
    `reason: ${reason}`,
    `attribution: ${ATTRIBUTION_TEXT[summary.attribution ?? "unknown"] ?? summary.attribution}`,
    `dumpId: ${summary.dumpId ?? "none"}; bootId: ${summary.bootId ?? "unknown"}; resetHw: ${hex(
      summary.resetHw,
    )}; resetSw: ${hex(summary.resetSw)}`,
    `crash time: ${isoOrUnknown(summary.crashUnixMs)}`,
    `covered TRACE window: ${covered}; traceGaps: ${summary.traceGaps ?? "unknown"}`,
    `crash tail captured: ${yesNo(summary.tailCaptured)}; tail torn: ${yesNo(summary.torn)}`,
    `dump truncated: ${yesNo(summary.truncated)}; dumpGap: ${yesNo(summary.dumpGap)}`,
    `evictedCount: ${summary.evictedCount ?? 0}; recent evictions: ${recent || "none"}`,
    "Abrupt resets (watchdog, power loss, hard fault before the crash handler ran) cannot capture a TRACE tail, so a missing tail on a reset is expected.",
    `summary: ${JSON.stringify(summary)}`,
  ].join("\n")
}

async function acknowledgeAndUpload(
  incidentKey: string,
  reportId: string,
  submitted: boolean,
): Promise<BesCrashReportOutcome> {
  try {
    await besCrashSdk.sendBesCrashReported(incidentKey, reportId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[${LOG_TAG}] ${incidentKey}: glasses did not acknowledge ${reportId}:`, message)
    return {status: "ack_failed", reportId, error: message}
  }
  const {dispatch} = await requestGlassesReportLogs(reportId)
  console.log(
    `[${LOG_TAG}] ${incidentKey}: ${reportId} acknowledged; log upload ${dispatch.state} (${dispatch.reason})`,
  )
  return {status: "reported", reportId, submitted}
}

async function processIncident(event: BesCrashDetectedEvent): Promise<BesCrashReportOutcome> {
  const {incidentKey} = event
  if (event.state === "REPORTED" && typeof event.reportId === "string" && REPORT_ID_PATTERN.test(event.reportId)) {
    return acknowledgeAndUpload(incidentKey, event.reportId, false)
  }
  if (event.state !== "STORED" && event.state !== "REPORTED") {
    return {status: "ignored", reason: `state_${event.state}`}
  }

  let userId: string
  try {
    userId = await cloudClientService.resolveMentraUserId()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[${LOG_TAG}] ${incidentKey}: user identity unavailable:`, message)
    return {status: "failed", error: message}
  }

  const storedReportId = readStoredReportId(userId, incidentKey)
  if (storedReportId) return acknowledgeAndUpload(incidentKey, storedReportId, false)

  const reason = besCrashTriggerReason(event)
  const result = await submitAutomaticReport({
    kind: "automatic",
    incidentKey,
    trigger: {type: "automatic", source: "glasses_firmware_crash", reason},
    report: {
      expectedBehavior: "Mentra Live BES firmware should run without crashing or resetting unexpectedly.",
      actualBehavior: describeBesCrash(event, reason),
      systemPriority: "critical",
    },
    notifyGlasses: false,
  })
  if (result.status !== "submitted") {
    const error = result.status === "failed" ? result.error : result.reason
    console.error(`[${LOG_TAG}] ${incidentKey}: submit failed:`, error)
    return {status: "failed", error}
  }
  storeReportId(userId, incidentKey, result.reportId)
  return acknowledgeAndUpload(incidentKey, result.reportId, true)
}

/** Delay before retry number `retry` (1-based). */
export function besCrashRetryDelayMs(retry: number): number {
  return RETRY_DELAYS_MS[retry - 1] ?? RETRY_INTERVAL_MS
}

function cancelRetry(incidentKey: string): void {
  const pending = retries.get(incidentKey)
  if (pending?.timer !== undefined) BgTimer.clearTimeout(pending.timer)
  retries.delete(incidentKey)
}

function scheduleRetry(event: BesCrashDetectedEvent): void {
  const {incidentKey} = event
  const retriesUsed = retries.get(incidentKey)?.retriesUsed ?? 0
  if (retriesUsed >= MAX_RETRIES) {
    retries.delete(incidentKey)
    console.warn(`[${LOG_TAG}] ${incidentKey}: giving up after ${MAX_RETRIES} retries`)
    return
  }
  const delayMs = besCrashRetryDelayMs(retriesUsed + 1)
  const timer = BgTimer.setTimeout(() => {
    const pending = retries.get(incidentKey)
    if (pending?.timer !== timer) return
    pending.timer = undefined
    void runFlow(pending.event)
  }, delayMs)
  retries.set(incidentKey, {event, retriesUsed: retriesUsed + 1, timer})
}

function runFlow(event: BesCrashDetectedEvent): Promise<BesCrashReportOutcome> {
  const {incidentKey} = event
  const existing = inFlight.get(incidentKey)
  if (existing) return existing
  const startedGeneration = generation
  const run = processIncident(event)
    .catch((error): BesCrashReportOutcome => {
      console.error(`[${LOG_TAG}] ${incidentKey}: unexpected error:`, error)
      return {status: "failed", error: error instanceof Error ? error.message : String(error)}
    })
    .then((outcome) => {
      inFlight.delete(incidentKey)
      if (startedGeneration !== generation) return outcome
      if (outcome.status === "failed" || outcome.status === "ack_failed") scheduleRetry(event)
      else cancelRetry(incidentKey)
      return outcome
    })
  inFlight.set(incidentKey, run)
  return run
}

/**
 * Report one `bes_crash_detected` event. A new event restarts the retry
 * schedule for its key; while a flow for the key is in flight it joins it.
 */
export function handleBesCrashDetected(event: BesCrashDetectedEvent): Promise<BesCrashReportOutcome> {
  if (!event || typeof event.incidentKey !== "string" || !INCIDENT_KEY_PATTERN.test(event.incidentKey)) {
    return Promise.resolve({status: "ignored", reason: "invalid_incident_key"})
  }
  cancelRetry(event.incidentKey)
  return runFlow(event)
}

export function startBesCrashReportService(): void {
  if (subscription) return
  subscription = besCrashSdk.addListener("bes_crash_detected", (event) => {
    void handleBesCrashDetected(event)
  })
}

export function stopBesCrashReportService(): void {
  subscription?.remove()
  subscription = null
  generation++
  for (const incidentKey of [...retries.keys()]) cancelRetry(incidentKey)
}
