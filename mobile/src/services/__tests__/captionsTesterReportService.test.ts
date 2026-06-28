import {waitFor} from "@testing-library/react-native"

import {
  startCaptionsTesterReportService,
  stopCaptionsTesterReportService,
} from "../../../modules/island/src/services/CaptionsTesterReportService"
import {reports} from "../../../modules/island/src/facades/reports"
import {emitCrustEvent, resetCrustModuleMock} from "@/test-utils/mockCrustModule"

jest.mock("@mentra/crust", () => {
  const {crustModuleMock} = require("@/test-utils/mockCrustModule")
  return {
    __esModule: true,
    default: crustModuleMock,
  }
})

jest.mock("../../../modules/island/src/facades/reports", () => ({
  reports: {
    submit: jest.fn(),
  },
}))

describe("CaptionsTesterReportService", () => {
  let logSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    resetCrustModuleMock()
    ;(reports.submit as jest.Mock).mockClear()
    ;(reports.submit as jest.Mock).mockResolvedValue({
      status: "submitted",
      reportId: "report-1",
      reportStatus: "ready",
      created: true,
    })
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {})
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    startCaptionsTesterReportService()
  })

  afterEach(() => {
    stopCaptionsTesterReportService()
    jest.restoreAllMocks()
  })

  it("files Android Intent captions tester incidents through island reports", async () => {
    emitCrustEvent("captions_tester_incident", {
      failure_code: "stale_transcript",
      failure_message: "Transcript stayed stale",
      test_run_id: "run-1",
      scenario_name: "live_words",
      alert_id: "alert-1",
      dashboard_url: "https://captions.example.test",
    })

    await waitFor(() => {
      expect(reports.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "automatic",
          trigger: {
            type: "automatic",
            source: "captions_tester",
            reason: "captions_incident_detected",
          },
          dedupeKey: "captions_tester|stale_transcript|live_words|run-1",
        }),
      )
    })

    const submitInput = (reports.submit as jest.Mock).mock.calls[0][0]
    expect(submitInput.report.actualBehavior).toContain("Transcript stayed stale")
    expect(submitInput.report.expectedBehavior).toContain("https://captions.example.test")

    const markerCall = logSpy.mock.calls.find(([message]) =>
      String(message).startsWith("CAPTIONS_TESTER_INCIDENT_RESULT "),
    )
    expect(markerCall).toBeTruthy()

    const payload = JSON.parse(String(markerCall?.[0]).replace("CAPTIONS_TESTER_INCIDENT_RESULT ", ""))
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

  it("removes the Crust listener when stopped", async () => {
    stopCaptionsTesterReportService()

    emitCrustEvent("captions_tester_incident", {
      failure_code: "stale_transcript",
      test_run_id: "run-1",
    })

    await Promise.resolve()
    expect(reports.submit).not.toHaveBeenCalled()
  })
})
