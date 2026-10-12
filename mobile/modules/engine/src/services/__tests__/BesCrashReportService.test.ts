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
mock.module("../PairingIdentity", () => ({
  projectPairingIdentity: () => ({kind: "paired", deviceModel: "Mentra Live"}),
}))
mock.module("../reportLogSources", () => ({
  requiredDeviceReportLogSources: () => ["phone", "glasses"],
}))
mock.module("../../types", () => ({
  DeviceTypes: {SIMULATED: "Simulated Glasses", LIVE: "Mentra Live"},
}))
mock.module("../../utils/diagnosticContext", () => ({
  collectDiagnosticContext: async (context?: Record<string, unknown>) => context ?? {},
}))
mock.module("../../utils/devLogging", () => ({
  logBuffer: {getRecentLogs: () => [], append: () => {}},
}))

/** Fake BgTimer: timers only run when a test fires them. */
const timers = new Map<number, {callback: () => void; delayMs: number}>()
let nextTimerId = 1
mock.module("../../utils/timers", () => ({
  BgTimer: {
    setTimeout: (callback: () => void, delayMs: number) => {
      const id = nextTimerId++
      timers.set(id, {callback, delayMs})
      return id
    },
    clearTimeout: (id: number) => void timers.delete(id),
  },
}))

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Run the single pending retry timer to completion and return its delay. */
async function fireRetry(): Promise<number> {
  expect(timers.size).toBe(1)
  const [[id, timer]] = [...timers]
  timers.delete(id)
  timer.callback()
  await flush()
  return timer.delayMs
}

type SubmitBody = {incidentKey?: string; trigger: {reason: string}; report: {actualBehavior: string}}

/** Cloud stand-in that returns the existing report for a known (user, incidentKey). */
const cloudReports = new Map<string, SubmitBody & {userId: string}>()
let nextReport = 1
let currentUser: string | null = "user_a"
let submitFailures: Array<"before_create" | "lost_response"> = []
let submitGate: Promise<void> | null = null
const timeline: string[] = []

const submit = mock(async (body: SubmitBody) => {
  if (submitGate) await submitGate
  const failure = submitFailures.shift()
  if (failure === "before_create") throw new Error("network down")
  const userId = currentUser ?? "anonymous"
  const existing = [...cloudReports].find(
    ([, report]) => body.incidentKey && report.userId === userId && report.incidentKey === body.incidentKey,
  )
  const reportId = existing?.[0] ?? `rep_${nextReport++}`
  if (!existing) cloudReports.set(reportId, {...body, userId})
  timeline.push(`submit:${reportId}`)
  if (failure === "lost_response") throw new Error("response lost")
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
cloudClientService.resolveMentraUserId = mock(async () => {
  if (!currentUser) throw new Error("Mentra user identity is unavailable")
  return currentUser
})
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
bluetoothSdk.getGlassesStatus = mock(async () => ({connection: {state: "connected"}, deviceModel: "Mentra Live"}))
bluetoothSdk.sendIncidentId = sendIncidentId
bluetoothSdk.sendBesCrashReported = sendBesCrashReported

const {besCrashRetryDelayMs, besCrashTriggerReason, handleBesCrashDetected, stopBesCrashReportService} = await import(
  "../BesCrashReportService"
)
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
const storedReportId = (userId: string, incidentKey = DUMP_KEY) =>
  JSON.parse(storedIncidents().get(`incident:${userId}:${incidentKey}`) ?? "{}").reportId

beforeEach(() => {
  stopBesCrashReportService()
  timers.clear()
  cloudReports.clear()
  nextReport = 1
  currentUser = "user_a"
  storedIncidents().clear()
  timeline.length = 0
  submitFailures = []
  submitGate = null
  submit.mockClear()
  sendBesCrashReported.mockClear()
  sendIncidentId.mockClear()
})

describe("BesCrashReportService", () => {
  test("a lost response resubmits the same incidentKey and Cloud keeps one report", async () => {
    submitFailures = ["lost_response"]
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
    expect(storedReportId("user_a")).toBe("rep_1")
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
    expect(storedIncidents().size).toBe(0)
    expect(timeline.filter((step) => step.startsWith("ack") || step.startsWith("upload"))).toEqual([
      `ack:${DUMP_KEY}:rep_glasses`,
      "upload:rep_glasses",
    ])
  })

  test("a failed submit stores nothing and sends no ack", async () => {
    submitFailures = ["before_create"]
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
    expect(storedReportId("user_a")).toBe("rep_1")
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
    expect(timers.size).toBe(0)
  })
})

describe("BesCrashReportService retries", () => {
  test("a failed submit retries with backoff and ends with one report", async () => {
    submitFailures = ["before_create", "lost_response"]
    await expect(handleBesCrashDetected(dumpEvent())).resolves.toMatchObject({status: "failed"})

    expect(await fireRetry()).toBe(30_000)
    expect(await fireRetry()).toBe(120_000)

    expect(submit).toHaveBeenCalledTimes(3)
    expect(cloudReports.size).toBe(1)
    expect(storedReportId("user_a")).toBe("rep_1")
    expect(sendBesCrashReported.mock.calls).toEqual([[DUMP_KEY, "rep_1"]])
    expect(sendIncidentId).toHaveBeenCalledTimes(1)
    expect(timers.size).toBe(0)
  })

  test("a failed log dispatch keeps the reportId and retries", async () => {
    sendIncidentId.mockImplementationOnce(async () => {
      throw new Error("sendIncidentId failed")
    })
    await expect(handleBesCrashDetected(dumpEvent())).resolves.toMatchObject({
      status: "dispatch_failed",
      reportId: "rep_1",
    })
    expect(storedReportId("user_a")).toBe("rep_1")

    expect(await fireRetry()).toBe(30_000)

    expect(submit).toHaveBeenCalledTimes(1)
    expect(sendIncidentId).toHaveBeenCalledTimes(2)
    expect(timers.size).toBe(0)
  })

  test("a failed ack retries from the cache and stops after success", async () => {
    sendBesCrashReported.mockImplementationOnce(async () => {
      throw new Error("bes_crash_reported_ack timeout")
    })
    await expect(handleBesCrashDetected(dumpEvent())).resolves.toMatchObject({status: "ack_failed"})
    expect(sendIncidentId).not.toHaveBeenCalled()

    expect(await fireRetry()).toBe(30_000)

    expect(submit).toHaveBeenCalledTimes(1)
    expect(sendBesCrashReported).toHaveBeenCalledTimes(2)
    expect(sendIncidentId).toHaveBeenCalledTimes(1)
    expect(timers.size).toBe(0)
  })

  test("gives up after eight retries", async () => {
    submitFailures = Array(20).fill("before_create")
    await handleBesCrashDetected(dumpEvent())

    const delays: number[] = []
    while (timers.size > 0) delays.push(await fireRetry())

    expect(delays).toEqual([30_000, 120_000, 600_000, 1_800_000, 1_800_000, 1_800_000, 1_800_000, 1_800_000])
    expect(submit).toHaveBeenCalledTimes(9)
    expect(besCrashRetryDelayMs(20)).toBe(1_800_000)
  })

  test("a new event for the key cancels the pending retry and restarts the schedule", async () => {
    submitFailures = ["before_create", "before_create", "before_create"]
    await handleBesCrashDetected(dumpEvent())
    expect(await fireRetry()).toBe(30_000)
    expect([...timers.values()].map((timer) => timer.delayMs)).toEqual([120_000])

    await handleBesCrashDetected(dumpEvent())

    expect(submit).toHaveBeenCalledTimes(3)
    expect([...timers.values()].map((timer) => timer.delayMs)).toEqual([30_000])
  })

  test("stop() clears pending retries and a flow that ends after stop schedules none", async () => {
    submitFailures = ["before_create", "before_create"]
    await handleBesCrashDetected(dumpEvent())
    expect(timers.size).toBe(1)

    stopBesCrashReportService()
    expect(timers.size).toBe(0)

    let release!: () => void
    submitGate = new Promise((resolve) => (release = resolve))
    const pending = handleBesCrashDetected(dumpEvent())
    await flush()
    stopBesCrashReportService()
    release()
    await expect(pending).resolves.toMatchObject({status: "failed"})
    expect(timers.size).toBe(0)
  })

  test("missing user identity fails without submitting and retries", async () => {
    currentUser = null
    await expect(handleBesCrashDetected(dumpEvent())).resolves.toMatchObject({status: "failed"})
    expect(submit).not.toHaveBeenCalled()

    currentUser = "user_a"
    expect(await fireRetry()).toBe(30_000)
    expect(storedReportId("user_a")).toBe("rep_1")
    expect(timers.size).toBe(0)
  })
})

describe("BesCrashReportService user scope", () => {
  test("an account switch never reuses another user's reportId", async () => {
    await handleBesCrashDetected(dumpEvent())
    expect(storedReportId("user_a")).toBe("rep_1")

    currentUser = "user_b"
    await expect(handleBesCrashDetected(dumpEvent())).resolves.toEqual({
      status: "reported",
      reportId: "rep_2",
      submitted: true,
    })
    expect(submit).toHaveBeenCalledTimes(2)
    expect(storedReportId("user_b")).toBe("rep_2")
    expect(sendBesCrashReported.mock.calls.at(-1)).toEqual([DUMP_KEY, "rep_2"])

    currentUser = "user_a"
    await expect(handleBesCrashDetected(dumpEvent())).resolves.toEqual({
      status: "reported",
      reportId: "rep_1",
      submitted: false,
    })
    expect(submit).toHaveBeenCalledTimes(2)
  })

  test("user ids cannot collide with incidentKeys that contain colons", async () => {
    currentUser = "user:a"
    await handleBesCrashDetected(dumpEvent())
    expect(storedIncidents().has(`incident:user%3Aa:${DUMP_KEY}`)).toBe(true)

    currentUser = "user"
    await handleBesCrashDetected(dumpEvent({incidentKey: `a:${DUMP_KEY}`}))
    expect(submit).toHaveBeenCalledTimes(2)
  })
})
