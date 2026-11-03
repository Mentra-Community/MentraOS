import {otaArtifactFailure} from "../../../modules/engine/src/services/OtaArtifactFailure"
import {submitAutomaticReport} from "../../../modules/engine/src/facades/reports"
import {
  submitOtaFailureReport,
  type OtaFailureEvidence,
} from "../../../modules/engine/src/services/OtaFailureReportService"

jest.mock("../../../modules/engine/src/facades/reports", () => ({submitAutomaticReport: jest.fn()}))
const submit = submitAutomaticReport as jest.Mock
const evidence = (): OtaFailureEvidence => ({
  attemptId: `attempt-${sequence}`,
  deviceRevision: 1,
  reason: "progress_stalled",
  transport: "hotspot",
  hotspotPhase: "serving",
  connected: true,
  wifiState: "disconnected",
  buildNumber: "123",
  besFirmwareVersion: "26.9.17.1",
  mtkFirmwareVersion: "20260709",
  targetBesVersion: "26.10.5.1",
  targetRelease: "3.2.1",
  targetBuild: 456,
  updates: ["apk", "bes"],
  retryCount: 0,
  sawReconnectEdge: false,
  besRestartExpected: false,
  besRestartDisconnectObserved: false,
  versionChangeInstallStarted: false,
  otaStatus: {
    sessionId: `session-${sequence}`,
    totalSteps: 2,
    currentStep: 2,
    stepType: "bes",
    phase: "download",
    stepPercent: 0,
    overallPercent: 20,
    bytesDownloaded: 0,
    status: "in_progress",
  },
  otaProgress: null,
})

let sequence = 0
beforeEach(() => {
  sequence += 1
  submit.mockReset().mockResolvedValue({status: "submitted", reportId: "rep_test", reportStatus: "ready"})
})

it("captures the snapshot and suppresses duplicate reports while submission is pending", async () => {
  let finish!: (value: unknown) => void
  submit.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const input = evidence()
  const pending = submitOtaFailureReport(input)
  await submitOtaFailureReport(input)
  input.otaStatus!.overallPercent = 100
  expect(submit).toHaveBeenCalledTimes(1)
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      trigger: {type: "automatic", source: "glasses_ota", reason: "progress_stalled"},
      context: {
        otaFailure: expect.objectContaining({
          transport: "hotspot",
          otaStatus: expect.objectContaining({overallPercent: 20}),
        }),
      },
    }),
  )
  finish({status: "submitted", reportId: "rep_test", reportStatus: "ready"})
  await pending
})

it("allows resubmission after rejection and contains upload exceptions", async () => {
  submit.mockRejectedValueOnce(new Error("offline"))
  await expect(submitOtaFailureReport(evidence())).resolves.toBeUndefined()
  await submitOtaFailureReport(evidence())
  expect(submit).toHaveBeenCalledTimes(2)
})

it("keeps distinct failure reasons and redacts free-form device errors", async () => {
  const input = evidence()
  input.otaStatus!.error = "https://example.com/firmware?token=secret"
  await submitOtaFailureReport(input)
  await submitOtaFailureReport({...input, reason: "restart_timeout"})
  const report = submit.mock.calls[0][0]
  expect(report.report.actualBehavior).not.toContain("secret")
  expect(report.context.otaFailure.otaStatus.error).toBe("[REDACTED]")
  expect(submit.mock.calls[0][0].throttleKey).not.toEqual(submit.mock.calls[1][0].throttleKey)
})

it("suppresses repeated durable failure replies beyond the facade throttle window", async () => {
  const now = jest.spyOn(Date, "now").mockReturnValue(1000)
  try {
    const input = evidence()
    await submitOtaFailureReport(input)
    now.mockReturnValue(200000)
    await submitOtaFailureReport({...input, attemptId: "remounted", otaStatus: {...input.otaStatus!}})
    expect(submit).toHaveBeenCalledTimes(1)
    await submitOtaFailureReport({...input, otaStatus: {...input.otaStatus!, sessionId: "new-ota-session"}})
    expect(submit).toHaveBeenCalledTimes(2)
  } finally {
    now.mockRestore()
  }
})

it("keeps classified native download details in private evidence without signed URLs", async () => {
  const input = evidence()
  input.artifactFailure = otaArtifactFailure(
    Object.assign(new Error("Software caused connection abort https://cdn.example.com/a?token=private"), {
      code: "RNFS",
    }),
    {
      artifact: "apk",
      stage: "download",
      httpStatus: 200,
      bytesWritten: 40,
      contentLength: 100,
    },
  )
  await submitOtaFailureReport(input)
  const report = submit.mock.calls[0][0]
  expect(report.context.otaFailure.artifactFailure).toMatchObject({
    category: "connection",
    httpStatus: 200,
    bytesWritten: 40,
    nativeErrors: [{name: "Error", code: "RNFS", message: expect.stringContaining("Software caused connection abort")}],
  })
  expect(report.report.actualBehavior).not.toContain("token=private")
  input.artifactFailure.nativeErrors[0].message = "changed after failure"
  expect(report.context.otaFailure.artifactFailure.nativeErrors[0].message).not.toContain("changed after failure")
})
