/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

import {bluetoothSdk} from "../../services/__tests__/bluetoothSdkTestMock"
import {cloudClientService} from "../../services/__tests__/cloudClientServiceTestMock"

mock.module("../../stores/glasses", () => ({
  useGlassesStore: {getState: () => ({connection: {state: "connected"}})},
}))
mock.module("../../services/PairingIdentity", () => ({
  projectPairingIdentity: () => ({kind: "paired", deviceModel: "Mentra Live"}),
}))
mock.module("../../services/reportLogSources", () => ({
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
mock.module("../../utils/timers", () => ({
  BgTimer: {
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id),
  },
}))

const submit = mock(async (_body: Record<string, unknown>) => ({reportId: "rep_facade", status: "collecting"}))
const updateLogCollection = mock(async (_reportId: string, _source: string, _update: unknown) => {})
const sendIncidentId = mock(async (_reportId: string, _coreUrl?: string | null) => {})

cloudClientService.hasCore = () => true
cloudClientService.getCoreUrl = () => "https://core.example"
cloudClientService.syncCoreTokenToBluetooth = mock(async () => {})
cloudClientService.core = {
  reports: {
    submit,
    updateLogCollection,
    addLogs: mock(async () => ({stored: 0})),
    addScreenshots: mock(async () => ({stored: 0})),
    complete: mock(async () => ({status: "ready"})),
  },
}
bluetoothSdk.getGlassesStatus = mock(async () => ({connection: {state: "connected"}, deviceModel: "Mentra Live"}))
bluetoothSdk.sendIncidentId = sendIncidentId

const {submitAutomaticReport} = await import("../reports")

const input = {
  kind: "automatic" as const,
  trigger: {type: "automatic" as const, source: "glasses_firmware_crash", reason: "bes_crash"},
  report: {actualBehavior: "crash", systemPriority: "critical" as const},
}

const glassesReceipts = () =>
  updateLogCollection.mock.calls.filter(([, source]) => source === "glasses" || source === "glasses_firmware")

beforeEach(() => {
  submit.mockClear()
  updateLogCollection.mockClear()
  sendIncidentId.mockClear()
})

describe("submitAutomaticReport glasses notification", () => {
  test("notifies the glasses by default", async () => {
    await expect(submitAutomaticReport(input)).resolves.toMatchObject({status: "submitted", reportId: "rep_facade"})

    expect(sendIncidentId).toHaveBeenCalledWith("rep_facade", "https://core.example")
    expect(glassesReceipts()).toHaveLength(2)
    expect(submit.mock.calls[0][0]).not.toHaveProperty("incidentKey")
  })

  test("notifyGlasses:false skips the upload request and the glasses receipts", async () => {
    await expect(
      submitAutomaticReport({...input, incidentKey: "ML395018B-dump-0000002a-1f2e3d4c", notifyGlasses: false}),
    ).resolves.toMatchObject({status: "submitted", reportId: "rep_facade"})

    expect(sendIncidentId).not.toHaveBeenCalled()
    expect(glassesReceipts()).toHaveLength(0)
    expect(submit.mock.calls[0][0]).toMatchObject({kind: "automatic", incidentKey: "ML395018B-dump-0000002a-1f2e3d4c"})
    expect(submit.mock.calls[0][0]).not.toHaveProperty("notifyGlasses")
  })
})
