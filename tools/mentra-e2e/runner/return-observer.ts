import type {Snapshot} from "./driver"
import {otaPage} from "./ota-state"

/** Caller-captured reads under the existing fixture lease. This module runs no commands. */
export type ReturnProcess = {
  bootId: string
  pid: number
  startTicks: string
  clockTicksPerSecond: number
  uptimeSeconds: number
}
export type ReturnRead<T> = {at: string; evidence: string; process: ReturnProcess; value: T}
export type ReturnCheck = {id: string; passed: boolean; actual: unknown; evidence: string[]}
export type RuntimeIdleInput = {
  before: ReturnRead<null>
  after: ReturnRead<null>
  activity: ReturnRead<unknown>
  updateEngine: ReturnRead<string>
  requestId: string
  /** From a fresh correlated version response, independently bound to this ASG process. */
  currentProcessSid: string
}

/** /proc/<pid>/stat field 22; comm can contain spaces and parentheses. */
export function processStartTicks(stat: string, expectedPid: number): string {
  const close = stat.lastIndexOf(")")
  const prefix = stat.slice(0, stat.indexOf("("))
  const value = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)[19]
  if (close < 0 || Number(prefix.trim()) !== expectedPid || !/^[1-9]\d*$/.test(value ?? ""))
    throw new Error("Malformed or mismatched process stat")
  return value
}

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const sid = /^[a-f0-9]{8}$/
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
function sameProcess(a: ReturnProcess, b: ReturnProcess) {
  return (
    uuid.test(a.bootId) &&
    a.bootId === b.bootId &&
    Number.isSafeInteger(a.pid) &&
    a.pid > 0 &&
    a.pid === b.pid &&
    /^[1-9]\d*$/.test(a.startTicks) &&
    Number.isSafeInteger(Number(a.startTicks)) &&
    a.startTicks === b.startTicks &&
    Number.isFinite(a.clockTicksPerSecond) &&
    a.clockTicksPerSecond > 0 &&
    a.clockTicksPerSecond === b.clockTicksPerSecond
  )
}

/** Require every returned check. Historical logs and top-level BES completion are diagnostics,
 * not an alternative idle proof. A terminal failed session can be idle without making its test pass. */
export function checkRuntimeOtaIdle(input: RuntimeIdleInput, now = Date.now(), maxAgeMs = 30000): ReturnCheck[] {
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error("Invalid observation clock")
  const {before, after, activity, updateEngine} = input
  const reads = [before, after, activity, updateEngine]
  const checks: ReturnCheck[] = []
  const add = (id: string, passed: boolean, actual: unknown, sources: ReturnRead<unknown>[]) =>
    checks.push({id, passed, actual, evidence: sources.map((read) => read.evidence)})
  const bounded =
    reads.every((read) => {
      const time = Date.parse(read.at)
      const age = now - time
      return (
        read.evidence.trim().length > 0 &&
        Number.isFinite(age) &&
        age >= 0 &&
        age <= maxAgeMs &&
        sameProcess(before.process, read.process) &&
        time >= Date.parse(before.at) &&
        time <= Date.parse(after.at) &&
        Number.isFinite(read.process.uptimeSeconds) &&
        read.process.uptimeSeconds >= before.process.uptimeSeconds &&
        read.process.uptimeSeconds <= after.process.uptimeSeconds
      )
    }) &&
    before.process.uptimeSeconds >= Number(before.process.startTicks) / before.process.clockTicksPerSecond &&
    Date.parse(updateEngine.at) <= Date.parse(activity.at) &&
    updateEngine.process.uptimeSeconds <= activity.process.uptimeSeconds
  add("idle.same-process-and-freshness", bounded, {before: before.process, after: after.process}, reads)

  const fields = updateEngine.value.trim().split(/\r?\n/)
  add(
    "idle.android-update-engine",
    fields.filter((line) => line === "CURRENT_OP=UPDATE_STATUS_IDLE").length === 1 &&
      fields.filter((line) => line.startsWith("CURRENT_OP=")).length === 1 &&
      fields.filter((line) => line === "STATUS_CODE=0").length === 1 &&
      fields.filter((line) => line.startsWith("STATUS_CODE=")).length === 1,
    updateEngine.value,
    [updateEngine],
  )

  const state = object(activity.value)
  const session = object(state.session)
  const correlated =
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(input.requestId) &&
    state.schema === 1 &&
    state.request_id === input.requestId &&
    sid.test(input.currentProcessSid) &&
    state.process_sid === input.currentProcessSid &&
    Number.isSafeInteger(state.admission_generation) &&
    Number(state.admission_generation) >= 0 &&
    Number.isSafeInteger(state.elapsed_realtime_ms) &&
    Number(state.elapsed_realtime_ms) >= before.process.uptimeSeconds * 1000 &&
    Number(state.elapsed_realtime_ms) <= activity.process.uptimeSeconds * 1000 &&
    [
      state.admission_held,
      state.updating,
      state.mtk_in_progress,
      state.bes_in_progress,
      state.consistent,
      session.restart_pending,
    ].every((value) => typeof value === "boolean") &&
    typeof session.session_id === "string" &&
    (session.session_id === "" || sid.test(session.session_id)) &&
    typeof session.status === "string" &&
    ["idle", "complete", "failed", "in_progress", "step_complete"].includes(String(session.status))
  add("idle.correlated-runtime-snapshot", correlated, activity.value, [activity])
  add(
    "idle.no-active-updater",
    correlated &&
      state.admission_held === false &&
      state.updating === false &&
      state.mtk_in_progress === false &&
      state.bes_in_progress === false &&
      state.consistent === true &&
      session.restart_pending === false &&
      ["idle", "complete", "failed"].includes(String(session.status)),
    activity.value,
    [activity],
  )
  return checks
}

/** Pair with a fresh version response's ProcessSessionId.SID (eight hex characters). */
export function checkStoppedStream(value: unknown, currentProcessSid: string): boolean {
  const row = object(value)
  return (
    sid.test(currentProcessSid) &&
    row.type === "stream_status" &&
    row.kind === "snapshot" &&
    row.sid === currentProcessSid &&
    Number.isSafeInteger(row.revision) &&
    Number(row.revision) >= 0 &&
    row.status === "stopped" &&
    row.terminal === true &&
    row.streaming === false &&
    row.reconnecting === false
  )
}

/** The English battery card exists only in the connected, fully booted, non-searching branch.
 * Caller independently binds both fresh captures to the selected executable and same app PID. */
export function checkPairedHome(home: Snapshot, deviceInfo: Snapshot, bluetooth: string, asgVersion: number): boolean {
  if (
    !Number.isSafeInteger(home.pid) ||
    home.pid <= 0 ||
    home.pid !== deviceInfo.pid ||
    !Number.isSafeInteger(asgVersion) ||
    asgVersion <= 0 ||
    !/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(bluetooth)
  )
    return false
  const shown = home.elements.filter((row) => row.visible)
  const named = deviceInfo.elements.filter((row) => row.visible).map((row) => row.description)
  return (
    otaPage(home).kind === "home" &&
    shown.filter(
      (row) =>
        row.role === "AXGenericElement" &&
        row.enabled &&
        row.actions.includes("AXPress") &&
        /^Mentra Live, .*\b(?:100|[1-9]?\d)%,/.test(row.description),
    ).length === 1 &&
    !shown.some(
      (row) =>
        row.identifier === "miniapp.close" ||
        ["AXSheet", "AXDialog"].includes(row.role) ||
        /^(?:Connect glasses|Connecting glasses…|Glasses are booting\.\.\.|Reconnecting\.\.\.)$/.test(row.description),
    ) &&
    named.includes("MAC address, " + bluetooth.toUpperCase()) &&
    named.includes("Build number, " + asgVersion)
  )
}
