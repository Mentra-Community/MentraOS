import {submitIncidentReport} from "../../../modules/engine/src/services/SubmitIncidentReportService"
import {submitAutomaticReport} from "../../../modules/engine/src/facades/reports"
jest.mock("../../../modules/engine/src/facades/reports", () => ({submitAutomaticReport: jest.fn()}))
beforeEach(() => {
  jest.clearAllMocks()
})
it("files a requested incident through the existing report pipeline", async () => {
  jest
    .mocked(submitAutomaticReport)
    .mockResolvedValue({status: "submitted", reportId: "rep_test", reportStatus: "ready"})
  const result = await submitIncidentReport({
    alert_id: "test-1",
    failure_code: "search_failed",
    failure_message: "No results",
  })
  expect(result).toMatchObject({alert_id: "test-1", status: "filed", report_id: "rep_test"})
  expect(submitAutomaticReport).toHaveBeenCalledWith(
    expect.objectContaining({trigger: expect.objectContaining({reason: "incident_report_requested"})}),
  )
})
it("returns a correlated failure when the uploader fails", async () => {
  jest.mocked(submitAutomaticReport).mockRejectedValue(new Error("upload unavailable"))
  expect(await submitIncidentReport({alert_id: "test-2", failure_code: "search_failed"})).toMatchObject({
    alert_id: "test-2",
    status: "failed",
  })
})
