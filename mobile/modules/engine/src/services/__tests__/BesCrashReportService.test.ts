/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

import {bluetoothSdk} from "./bluetoothSdkTestMock"
import {cloudClientService} from "./cloudClientServiceTestMock"

const mmkvStores = new Map<string, Map<string, string>>()
mock.module("react-native-mmkv", () => ({
  createMMKV: ({id = "default"}: {id?: string} = {}) => {
    const values = mmkvStores.get(id) ?? new Map<string, string>()
    mmkvStores.set(id, values)
    return {
      getString: (key: string) => values.get(key),
      set: (key: string, value: string) => void values.set(key, value),
      remove: (key: string) => values.delete(key),
      getAllKeys: () => [...values.keys()],
    }
  },
}))
mock.module("../../stores/glasses", () => ({
  useGlassesStore: {getState: () => ({connection: {state: "connected"}})},
}))
mock.module("../../utils/diagnosticContext", () => ({
  collectDiagnosticContext: async (context?: Record<string, unknown>) => context ?? {},
}))
mock.module("../../utils/devLogging", () => ({
  logBuffer: {getRecentLogs: () => [], append: () => {}},
}))
mock.module("../../utils/timers", () => ({
  BgTimer: {
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id),
  },
}))

type SubmitBody = {incidentKey?: string; trigger: {reason: string}; report: {actualBehavior: string}}

/** Cloud stand-in that returns the existing report for a known incidentKey. */
const cloudReports = new Map<string, SubmitBody>()
let nextReport = 1
let submitFailure: "none" | "before_create" | "lost_response" = "none"
let submitGate: Promise<void> | null = null
const timeline: string[] = []

const submit = mock(async (body: SubmitBody) => {
  if (submitGate) await submitGate
  if (submitFailure === "before_create") throw new Error("network down")
  const existing = [...cloudReports].find(([, report]) => body.incidentKey && report.incidentKey === body.incidentKey)
  const reportId = existing?.[0] ?? `rep_${nextReport++}`
  if (!existing) cloudReports.set(reportId, body)
  timeline.push(`submit:${reportId}`)
  if (submitFailure === "lost_response") {
    submitFailure = "none"
    throw new Error("response lost")
  }
  return {reportId, status: "collecting", ...(existing ? {deduplicated: true} : {})}
})
const sendBesCrashReported = mock(async (incidentKey: string, reportId: string) => {
  timeline.push(`ack:${incidentKey}:${reportId}`)
})
const sendIncidentId = mock(async (reportId: string) => {
  timeline.push(`upload:${reportId}`)
})

cloudClientService.hasCore = () => true
cloudClientService.getCoreUrl = () => "https://core.example"
cloudClientService.syncCoreTokenToBluetooth = mock(async () => {
  timeline.push("token")
})
cloudClientService.core = {
  reports: {
    submit,
    updateLogCollection: mock(async (reportId: string, source: string) => {
      timeline.push(`receipt:${source}:${reportId}`)
    }),
    addLogs: mock(async () => ({stored: 0})),
    addScreenshots: mock(async () => ({stored: 0})),
    complete: mock(async () => ({status: "ready"})),
  },
}
bluetoothSdk.getGlassesStatus = mock(async () => ({connection: {state: "connected"}}))
bluetoothSdk.sendIncidentId = sendIncidentId
bluetoothSdk.sendBesCrashReported = sendBesCrashReported

const {besCrashTriggerReason, handleBesCrashDetected} = await import("../BesCrashReportService")
type BesCrashDetectedEvent = Parameters<typeof handleBesCrashDetected>[0]

const DUMP_KEY = "ML395018B-dump-0000002a-1f2e3d4c"
const RESET_KEY = "ML395018B-reset-9f3a0c1b2d4e5f60"

const dumpEvent = (overrides: Partial<BesCrashDetectedEvent> = {}): BesCrashDetectedEvent => ({
  type: "bes_crash_detected",
  incidentKey: DUMP_KEY,
  reason: "bes_crash",
  state: "STORED",
  reportId: null,
  summary: {
    attribution: "older",
    dumpId: "0000002a-1f2e3d4c",
    bootId: "9f3a0c1b2d4e5f60",
    resetHw: 0,
    resetSw: 0,
    crashUnixMs: 1760000000000,
    coveredFromMs: 1759998200000,
    coveredToMs: 1760000000000,
    traceGaps: 2,
    truncated: true,
    torn: false,
    tailCaptured: true,
    dumpGap: false,
    evictedCount: 3,
    recentEvictions: [
      {incidentKey: "ML395018B-reset-0badc0de12345678", reason: "budget", bytes: 4096, ms: 1759990000000},
    ],
  },
  ...overrides,
})

const storedIncidents = () => mmkvStores.get("mentra-bes-crash-reports") ?? new Map<string, string>()

beforeEach(() => {
  cloudReports.clear()
  nextReport = 1
  storedIncidents().clear()
  timeline.length = 0
  submitFailure = "none"
  submitGate = null
  submit.mockClear()
  sendBesCrashReported.mockClear()
  sendIncidentId.mockClear()
})

describe("BesCrashReportService", () => {
  test("a lost response resubmits the same incidentKey and Cloud keeps one report", async () => {
    submitFailure = "lost_response"
    await expect(handleBesCrashDetected(dumpEvent())).resolves.toMatchObject({status: "failed"})
    expect(storedIncidents().size).toBe(0)
    expect(sendBesCrashReported).not.toHaveBeenCalled()

    await expect(handleBesCrashDetected(dumpEvent())).resolves.toEqual({
      status: "reported",
      reportId: "rep_1",
      submitted: true,
    })

    expect(submit).toHaveBeenCalledTimes(2)
    expect(submit.mock.calls.map(([body]) => body.incidentKey)).toEqual([DUMP_KEY, DUMP_KEY])
    expect(cloudReports.size).toBe(1)
    expect(JSON.parse(storedIncidents().get(`incident:${DUMP_KEY}`) ?? "{}").reportId).toBe("rep_1")
    expect(sendBesCrashReported).toHaveBeenCalledTimes(1)
    expect(sendIncidentId).toHaveBeenCalledTimes(1)
    const ack = timeline.indexOf(`ack:${DUMP_KEY}:rep_1`)
    expect(ack).toBeGreaterThan(-1)
    expect(ack).toBeLessThan(timeline.indexOf("upload:rep_1"))
    expect(ack).toBeLessThan(timeline.indexOf("receipt:glasses_firmware:rep_1"))
    expect(timeline.lastIndexOf("token")).toBeGreaterThan(ack)
  })

  test("submits the contract trigger, priority and incident summary", async () => {
    await handleBesCrashDetected(dumpEvent())

    const body = submit.mock.calls[0][0] as SubmitBody & Record<string, unknown>
    expect(body).toMatchObject({
      kind: "automatic",
      incidentKey: DUMP_KEY,
      trigger: {type: "automatic", source: "glasses_firmware_crash", reason: "bes_crash"},
      report: {systemPriority: "critical"},
    })
    const text = body.report.actualBehavior
    expect(text).toContain("covered TRACE window: 2025-10-09T08:23:20.000Z .. 2025-10-09T08:53:20.000Z")
    expect(text).toContain("(1759998200000..1760000000000); traceGaps: 2")
    expect(text).toContain("crash tail captured: yes; tail torn: no")
    expect(text).toContain("dump truncated: yes; dumpGap: no")
    expect(text).toContain("attribution: older")
    expect(text).toContain("evictedCount: 3; recent evictions: ML395018B-reset-0badc0de12345678 (budget, 4096 bytes")
    expect(text).toContain("Abrupt resets")
  })

  test("a duplicate after a restart reuses the reportId Cloud already holds", async () => {
    await handleBesCrashDetected(dumpEvent())
    storedIncidents().clear()

    await expect(handleBesCrashDetected(dumpEvent())).resolves.toMatchObject({status: "reported", reportId: "rep_1"})

    expect(submit).toHaveBeenCalledTimes(2)
    expect(cloudReports.size).toBe(1)
    expect(sendBesCrashReported.mock.calls).toEqual([
      [DUMP_KEY, "rep_1"],
      [DUMP_KEY, "rep_1"],
    ])
  })

  test("a stored reportId is reused without submitting", async () => {
    await handleBesCrashDetected(dumpEvent())
    await expect(handleBesCrashDetected(dumpEvent())).resolves.toEqual({
      status: "reported",
      reportId: "rep_1",
      submitted: false,
    })
    expect(submit).toHaveBeenCalledTimes(1)
    expect(sendBesCrashReported).toHaveBeenCalledTimes(2)
  })

  test("a REPORTED event resends the ack and upload without submitting", async () => {
    await expect(handleBesCrashDetected(dumpEvent({state: "REPORTED", reportId: "rep_glasses"}))).resolves.toEqual({
      status: "reported",
      reportId: "rep_glasses",
      submitted: false,
    })
    expect(submit).not.toHaveBeenCalled()
    expect(timeline.filter((step) => step.startsWith("ack") || step.startsWith("upload"))).toEqual([
      `ack:${DUMP_KEY}:rep_glasses`,
      "upload:rep_glasses",
    ])
  })

  test("a failed submit stores nothing and sends no ack", async () => {
    submitFailure = "before_create"
    await expect(handleBesCrashDetected(dumpEvent())).resolves.toEqual({status: "failed", error: "network down"})
    expect(storedIncidents().size).toBe(0)
    expect(cloudReports.size).toBe(0)
    expect(sendBesCrashReported).not.toHaveBeenCalled()
    expect(sendIncidentId).not.toHaveBeenCalled()
  })

  test("a failed ack keeps the reportId and skips the upload", async () => {
    sendBesCrashReported.mockImplementationOnce(async () => {
      throw new Error("bes_crash_reported_ack timeout")
    })
    await expect(handleBesCrashDetected(dumpEvent())).resolves.toMatchObject({status: "ack_failed", reportId: "rep_1"})
    expect(storedIncidents().has(`incident:${DUMP_KEY}`)).toBe(true)
    expect(sendIncidentId).not.toHaveBeenCalled()
  })

  test("a duplicate event while one is in flight does not double-submit", async () => {
    let release!: () => void
    submitGate = new Promise((resolve) => (release = resolve))
    const first = handleBesCrashDetected(dumpEvent())
    const second = handleBesCrashDetected(dumpEvent())
    release()

    expect(await second).toEqual(await first)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(sendBesCrashReported).toHaveBeenCalledTimes(1)
  })

  test("different incidentKeys are each reported", async () => {
    await handleBesCrashDetected(dumpEvent())
    await handleBesCrashDetected(dumpEvent({incidentKey: RESET_KEY, reason: "bes_unexpected_reset"}))
    expect(cloudReports.size).toBe(2)
  })

  test("the no-dump reason maps to bes_unexpected_reset", async () => {
    await handleBesCrashDetected(
      dumpEvent({
        incidentKey: RESET_KEY,
        reason: "bes_unexpected_reset",
        summary: {attribution: "match", dumpId: null, tailCaptured: false, evictedCount: 0, recentEvictions: []},
      }),
    )
    const body = submit.mock.calls[0][0]
    expect(body.trigger.reason).toBe("bes_unexpected_reset")
    expect(body.report.actualBehavior).toContain("reset unexpectedly without a crash dump")
    expect(besCrashTriggerReason({incidentKey: RESET_KEY, reason: "unrecognized" as never})).toBe(
      "bes_unexpected_reset",
    )
  })

  test("an invalid incidentKey is ignored", async () => {
    await expect(handleBesCrashDetected(dumpEvent({incidentKey: "bad key/with spaces"}))).resolves.toEqual({
      status: "ignored",
      reason: "invalid_incident_key",
    })
    expect(submit).not.toHaveBeenCalled()
  })
})
