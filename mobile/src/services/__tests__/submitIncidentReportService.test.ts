import {waitFor} from "@testing-library/react-native"

import {
  startSubmitIncidentReportService,
  stopSubmitIncidentReportService,
  submitIncidentReport,
} from "../../../modules/engine/src/services/SubmitIncidentReportService"
import {submitAutomaticReport} from "../../../modules/engine/src/facades/reports"
import {emitCrustEvent, resetCrustModuleMock} from "@/test-utils/mockCrustModule"

jest.mock("@mentra/crust", () => {
  const {crustModuleMock} = require("@/test-utils/mockCrustModule")
  return {
    __esModule: true,
    default: crustModuleMock,
  }
})

jest.mock("../../../modules/engine/src/facades/reports", () => ({
  submitAutomaticReport: jest.fn(),
}))

describe("SubmitIncidentReportService", () => {
  let logSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    resetCrustModuleMock()
    ;(submitAutomaticReport as jest.Mock).mockClear()
    ;(submitAutomaticReport as jest.Mock).mockResolvedValue({
      status: "submitted",
      reportId: "report-1",
      reportStatus: "ready",
    })
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {})
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    startSubmitIncidentReportService()
  })

  afterEach(() => {
    stopSubmitIncidentReportService()
    jest.restoreAllMocks()
  })

  it("files broadcast incidents through the existing automatic-report pipeline", async () => {
    emitCrustEvent("submit_incident_report", {
      failure_code: "stale_transcript",
      failure_message: "Transcript stayed stale",
      test_run_id: "run-1",
      scenario_name: "live_words",
      alert_id: "alert-1",
      dashboard_url: "https://captions.example.test",
      source: "captions_tester",
    })

    await waitFor(() => {
      expect(submitAutomaticReport).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "automatic",
          trigger: {
            type: "automatic",
            source: "captions_tester",
            reason: "incident_report_requested",
          },
          throttleKey: "captions_tester|stale_transcript|live_words|alert-1",
        }),
      )
    })

    const submitInput = (submitAutomaticReport as jest.Mock).mock.calls[0][0]
    expect(submitInput.report.actualBehavior).toContain("Transcript stayed stale")
    expect(submitInput.report.expectedBehavior).toContain("https://captions.example.test")

    const markerCall = logSpy.mock.calls.find(([message]) => String(message).startsWith("INCIDENT_REPORT_RESULT "))
    expect(markerCall).toBeTruthy()

    const payload = JSON.parse(String(markerCall?.[0]).replace("INCIDENT_REPORT_RESULT ", ""))
    expect(payload).toMatchObject({
      alert_id: "alert-1",
      test_run_id: "run-1",
      failure_code: "stale_transcript",
      scenario_name: "live_words",
      status: "filed",
      report_id: "report-1",
      incident_id: "report-1",
    })
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it("returns the same correlated result for an explicit incident request", async () => {
    const result = await submitIncidentReport({
      alert_id: "ota-failure-1",
      test_run_id: "ota-run",
      failure_code: "update_failed",
      source: "mentra_automated_testing",
      expected_behavior: "All versions match the selected manifest",
    })
    expect(result).toMatchObject({
      alert_id: "ota-failure-1",
      test_run_id: "ota-run",
      status: "filed",
      report_id: "report-1",
    })
    expect(submitAutomaticReport).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: {type: "automatic", source: "mentra_automated_testing", reason: "incident_report_requested"},
        report: expect.objectContaining({expectedBehavior: "All versions match the selected manifest"}),
      }),
    )
    expect(logSpy).toHaveBeenCalledWith(`INCIDENT_REPORT_RESULT ${JSON.stringify(result)}`)
  })

  it("uses distinct throttle keys for distinct request IDs in the same test run", async () => {
    for (const alert_id of ["request-1", "request-2"])
      await submitIncidentReport({alert_id, test_run_id: "same-run", failure_code: "update_failed"})
    const keys = (submitAutomaticReport as jest.Mock).mock.calls.map(([input]) => input.throttleKey)
    expect(keys).toEqual([
      "external_trigger|update_failed|unknown|request-1",
      "external_trigger|update_failed|unknown|request-2",
    ])
  })

  it.each([
    [
      {status: "skipped", reason: "throttled_within_window"},
      {status: "skipped", reason: "throttled_within_window"},
    ],
    [
      {status: "failed", error: "Not signed in"},
      {status: "failed", error: "Not signed in"},
    ],
  ])("returns an observable non-success outcome: %j", async (submission, expected) => {
    ;(submitAutomaticReport as jest.Mock).mockResolvedValueOnce(submission)
    expect(await submitIncidentReport({alert_id: "request-1", test_run_id: "run-1"})).toMatchObject({
      ...expected,
      alert_id: "request-1",
      test_run_id: "run-1",
    })
  })

  it("turns submission exceptions into a correlated failed receipt", async () => {
    ;(submitAutomaticReport as jest.Mock).mockRejectedValueOnce(new Error("Connection lost"))
    expect(await submitIncidentReport({alert_id: "request-1"})).toMatchObject({
      alert_id: "request-1",
      status: "failed",
      error: "Connection lost",
    })
  })

  it.each([null, [], "not-an-object"])("rejects malformed requests without submitting: %j", async (request) => {
    expect(await submitIncidentReport(request)).toMatchObject({status: "failed"})
    expect(submitAutomaticReport).not.toHaveBeenCalled()
  })

  it("removes the Crust listener when stopped", async () => {
    stopSubmitIncidentReportService()

    emitCrustEvent("submit_incident_report", {
      failure_code: "stale_transcript",
      test_run_id: "run-1",
    })

    await Promise.resolve()
    expect(submitAutomaticReport).not.toHaveBeenCalled()
  })
})
