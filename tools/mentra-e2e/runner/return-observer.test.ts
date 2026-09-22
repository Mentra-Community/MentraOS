import {describe, expect, test} from "bun:test"
import type {Element, Snapshot} from "./driver"
import {
  checkPairedHome,
  checkRuntimeOtaIdle,
  checkStoppedStream,
  processStartTicks,
  type RuntimeIdleInput,
} from "./return-observer"

const now = Date.parse("2026-09-22T09:00:00Z")
const boot = "da1ae189-2166-4d4b-8069-806e570bb530"
const priorBoot = "82c56862-b30e-4db7-92bc-197807c693a7"
const sid = "165a7d73"
const version = 303006206
const process = {bootId: boot, pid: 1335, startTicks: "2485", clockTicksPerSecond: 100, uptimeSeconds: 99}
const read = <T>(value: T) => ({
  at: new Date(now - 500).toISOString(),
  evidence: "actual-capture.json",
  process: {...process},
  value,
})
function input(): RuntimeIdleInput {
  return {
    before: {...read(null), at: new Date(now - 1000).toISOString(), process: {...process, uptimeSeconds: 98}},
    after: {...read(null), at: new Date(now - 100).toISOString(), process: {...process, uptimeSeconds: 100}},
    requestId: "return-123",
    currentProcessSid: sid,
    activity: read({
      schema: 1,
      request_id: "return-123",
      process_sid: sid,
      admission_generation: 3,
      elapsed_realtime_ms: 98500,
      admission_held: false,
      consistent: true,
      updating: false,
      mtk_in_progress: false,
      bes_in_progress: false,
      session: {session_id: "f969d73a", status: "complete", restart_pending: false},
    }),
    updateEngine: {
      ...read("CURRENT_OP=UPDATE_STATUS_IDLE\nSTATUS_CODE=0\nPROGRESS=0.000000\n"),
      at: new Date(now - 750).toISOString(),
    },
  }
}
const failures = (value: RuntimeIdleInput) =>
  checkRuntimeOtaIdle(value, now)
    .filter((check) => !check.passed)
    .map((check) => check.id)
const state = (value: RuntimeIdleInput) => value.activity.value as Record<string, unknown>

describe("direct current-process OTA idle snapshot", () => {
  test("qualifies fresh correlated idle with independent Android engine, without requiring startup logs", () => {
    expect(failures(input())).toEqual([])
    const value = input()
    state(value).session = {session_id: "", status: "idle", restart_pending: false}
    expect(failures(value)).toEqual([])
    state(value).session = {session_id: "f969d73a", status: "failed", restart_pending: false}
    expect(failures(value)).toEqual([]) // Inactivity does not overwrite the separate failed test verdict.
  })
  test("rejects every actual busy source even beside a completed top-level BES status", () => {
    for (const key of ["admission_held", "updating", "mtk_in_progress", "bes_in_progress"]) {
      const value = input()
      state(value)[key] = true
      state(value).status = "complete"
      expect(failures(value)).toContain("idle.no-active-updater")
    }
    for (const session of [
      {session_id: "f969d73a", status: "complete", restart_pending: true},
      {session_id: "f969d73a", status: "in_progress", restart_pending: false},
      {session_id: "f969d73a", status: "step_complete", restart_pending: false},
    ]) {
      const value = input()
      state(value).session = session
      expect(failures(value)).toContain("idle.no-active-updater")
    }
  })
  test("unknown, missing or malformed activity never defaults to idle", () => {
    for (const patch of [
      {schema: 2},
      {admission_generation: undefined},
      {admission_generation: -1},
      {admission_generation: Number.MAX_SAFE_INTEGER + 1},
      {bes_in_progress: null},
      {updating: "false"},
      {session: null},
      {session: {status: "idle"}},
      {session: {session_id: "", status: ["idle"], restart_pending: false}},
      {elapsed_realtime_ms: -1},
    ]) {
      const value = input()
      Object.assign(state(value), patch)
      expect(failures(value)).toContain("idle.correlated-runtime-snapshot")
    }
    const value = input()
    value.activity.value = {type: "ota_status", status: "complete"}
    expect(failures(value)).toContain("idle.correlated-runtime-snapshot")
  })
  test("a complete admission handoff during capture rejects otherwise idle fields", () => {
    const value = input()
    state(value).consistent = false
    expect(failures(value)).toContain("idle.no-active-updater")
  })
  test("rejects wrong nonce, older process SID, cached snapshot and out-of-bracket capture", () => {
    for (const patch of [
      {request_id: "earlier-query"},
      {process_sid: "ffffffff"},
      {elapsed_realtime_ms: 97000},
      {elapsed_realtime_ms: 99001},
    ]) {
      const value = input()
      Object.assign(state(value), patch)
      expect(failures(value)).toContain("idle.correlated-runtime-snapshot")
    }
    for (const mutate of [
      (v: RuntimeIdleInput) => {
        v.activity.at = new Date(now - 20000).toISOString()
      },
      (v: RuntimeIdleInput) => {
        v.updateEngine.at = new Date(now - 30001).toISOString()
      },
      (v: RuntimeIdleInput) => {
        v.activity.process.bootId = priorBoot
      },
      (v: RuntimeIdleInput) => {
        v.after.process.pid++
      },
      (v: RuntimeIdleInput) => {
        v.after.process.startTicks = "2500"
      },
      (v: RuntimeIdleInput) => {
        v.updateEngine.at = new Date(now - 200).toISOString()
      },
    ]) {
      const value = input()
      mutate(value)
      expect(failures(value)).toContain("idle.same-process-and-freshness")
    }
  })
  test("staged MTK or ambiguous duplicate status fields are not idle", () => {
    for (const status of [
      "CURRENT_OP=UPDATE_STATUS_UPDATED_NEED_REBOOT\nSTATUS_CODE=6\n",
      "CURRENT_OP=UPDATE_STATUS_IDLE\nSTATUS_CODE=0\nSTATUS_CODE=3\n",
    ]) {
      const value = input()
      value.updateEngine.value = status
      expect(failures(value)).toContain("idle.android-update-engine")
    }
  })
  test("parses Linux start ticks without splitting a spaced comm name", () => {
    expect(processStartTicks("1200 (asg worker (main)) S " + Array(18).fill("0").join(" ") + " 12345 0", 1200)).toBe(
      "12345",
    )
    expect(() => processStartTicks("1201 (other) S 1", 1200)).toThrow()
  })
})

test("stream must be a stopped current-process snapshot, not an event or old cached status", () => {
  const value = {
    type: "stream_status",
    kind: "snapshot",
    sid,
    revision: 0,
    status: "stopped",
    terminal: true,
    streaming: false,
    reconnecting: false,
  }
  expect(checkStoppedStream(value, sid)).toBe(true)
  expect(checkStoppedStream({...value, sid: boot}, boot)).toBe(false)
  for (const patch of [
    {sid: "ffffffff"},
    {kind: "event"},
    {terminal: false},
    {streaming: true},
    {status: "initializing"},
    {revision: undefined},
  ])
    expect(checkStoppedStream({...value, ...patch}, sid)).toBe(false)
})

function element(patch: Partial<Element>): Element {
  return {
    path: "0",
    role: "AXGenericElement",
    subrole: "",
    title: "",
    description: "",
    placeholder: "",
    identifier: "",
    value: "",
    enabled: true,
    focused: false,
    visible: true,
    actions: ["AXPress"],
    ...patch,
  }
}
const snapshot = (elements: Element[]): Snapshot => ({
  pid: 456,
  frontmostBundleId: "com.mentra.mentra",
  window: {x: 0, y: 0, width: 400, height: 600},
  elements,
})
test("paired-home proof needs the connected-only battery card and separate exact current pair metadata", () => {
  const home = snapshot([
    element({description: "Mentra Live, \uea31, 100%, \uecea"}),
    element({identifier: "home.miniapp.com.mentra.settings"}),
  ])
  const info = snapshot([
    element({description: "MAC address, CC:E7:DE:E0:03:BE"}),
    element({description: "Build number, " + version}),
  ])
  expect(checkPairedHome(home, info, "CC:E7:DE:E0:03:BE", version)).toBe(true)
  expect(checkPairedHome(snapshot([]), info, "CC:E7:DE:E0:03:BE", version)).toBe(false)
  expect(checkPairedHome(home, {...info, pid: 789}, "CC:E7:DE:E0:03:BE", version)).toBe(false)
  expect(checkPairedHome(home, info, "CC:E7:DE:E0:03:BF", version)).toBe(false)
  expect(
    checkPairedHome(
      snapshot([...home.elements, element({description: "Connect glasses"})]),
      info,
      "CC:E7:DE:E0:03:BE",
      version,
    ),
  ).toBe(false)
  expect(
    checkPairedHome(
      snapshot([
        ...home.elements,
        element({description: "Mentra Live Update Available"}),
        element({description: "Install"}),
      ]),
      info,
      "CC:E7:DE:E0:03:BE",
      version,
    ),
  ).toBe(false)
})
