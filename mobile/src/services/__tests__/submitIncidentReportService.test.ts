import {submitIncidentReport} from "../../../modules/engine/src/services/SubmitIncidentReportService"
import {reports, submitAutomaticReport} from "../../../modules/engine/src/facades/reports"
jest.mock("../../../modules/engine/src/facades/reports", () => ({
  submitAutomaticReport: jest.fn(),
  reports: {waitForCollection: jest.fn()},
}))
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(reports.waitForCollection).mockResolvedValue({reportId: "rep_test", state: "complete", logCollection: {}})
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
  expect(reports.waitForCollection).toHaveBeenCalledWith("rep_test", {
    sources: ["phone", "glasses", "glasses_firmware"],
    timeoutMs: 20_000,
  })
})
it("returns a correlated failure when the uploader fails", async () => {
  jest.mocked(submitAutomaticReport).mockRejectedValue(new Error("upload unavailable"))
  expect(await submitIncidentReport({alert_id: "test-2", failure_code: "search_failed"})).toMatchObject({
    alert_id: "test-2",
    status: "failed",
  })
  expect(reports.waitForCollection).not.toHaveBeenCalled()
})

it("does not expose the final filed receipt while device log collection is pending", async () => {
  jest
    .mocked(submitAutomaticReport)
    .mockResolvedValue({status: "submitted", reportId: "rep_test", reportStatus: "ready"})
  let finish!: (value: Awaited<ReturnType<typeof reports.waitForCollection>>) => void
  jest.mocked(reports.waitForCollection).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const logged = jest.spyOn(console, "log").mockImplementation(() => {})
  const pending = submitIncidentReport({alert_id: "test-wait", failure_code: "original_failure"})
  let settled = false
  void pending.then(() => {
    settled = true
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(logged.mock.calls.some(([value]) => String(value).startsWith("INCIDENT_REPORT_RESULT"))).toBe(false)
  finish({reportId: "rep_test", state: "complete", logCollection: {}})
  await expect(pending).resolves.toMatchObject({status: "filed", collection: {state: "complete"}})
  expect(submitAutomaticReport).toHaveBeenCalledTimes(1)
  logged.mockRestore()
})

it.each(["timed-out", "unavailable"] as const)(
  "preserves the filed report and original failure after collection is %s",
  async (state) => {
    jest
      .mocked(submitAutomaticReport)
      .mockResolvedValue({status: "submitted", reportId: "rep_test", reportStatus: "ready"})
    jest.mocked(reports.waitForCollection).mockResolvedValue({reportId: "rep_test", state, logCollection: {}})
    await expect(
      submitIncidentReport({alert_id: `test-${state}`, failure_code: "original_failure"}),
    ).resolves.toMatchObject({
      status: "filed",
      report_id: "rep_test",
      failure_code: "original_failure",
      collection: {state},
    })
    expect(submitAutomaticReport).toHaveBeenCalledTimes(1)
  },
)

it("keeps the filed report after an unexpected collection reader rejection", async () => {
  jest
    .mocked(submitAutomaticReport)
    .mockResolvedValue({status: "submitted", reportId: "rep_test", reportStatus: "ready"})
  jest.mocked(reports.waitForCollection).mockRejectedValueOnce(new Error("Bearer PRIVATE_TOKEN"))
  await expect(
    submitIncidentReport({alert_id: "test-read-error", failure_code: "original_failure"}),
  ).resolves.toMatchObject({
    status: "filed",
    report_id: "rep_test",
    failure_code: "original_failure",
    collection: {state: "unavailable"},
  })
  expect(submitAutomaticReport).toHaveBeenCalledTimes(1)
})

it("does not wait for a report that was skipped by the existing submission policy", async () => {
  jest.mocked(submitAutomaticReport).mockResolvedValueOnce({status: "skipped", reason: "throttled_within_window"})
  await expect(
    submitIncidentReport({alert_id: "test-skipped", failure_code: "original_failure"}),
  ).resolves.toMatchObject({
    status: "skipped",
    failure_code: "original_failure",
    reason: "throttled_within_window",
  })
  expect(reports.waitForCollection).not.toHaveBeenCalled()
})
