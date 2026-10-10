import {
  IncidentReportError,
  submitIncidentReport,
} from "../../../modules/engine/src/services/SubmitIncidentReportService"
import {ReportCollectionError, reports, submitAutomaticReport} from "../../../modules/engine/src/facades/reports"
import {projectPairingIdentity} from "../../../modules/engine/src/services/PairingIdentity"
import {useSettingsStore} from "../../../modules/engine/src/stores/settings"

jest.mock("../../../modules/engine/src/facades/reports", () => ({
  submitAutomaticReport: jest.fn(),
  reports: {waitForCollection: jest.fn()},
  ReportCollectionError: class ReportCollectionError extends Error {
    collection: unknown
    constructor(value: unknown) {
      super("Report log collection did not complete")
      this.collection = value
    }
  },
}))
jest.mock("../../../modules/engine/src/services/PairingIdentity", () => ({projectPairingIdentity: jest.fn()}))
jest.mock("../../../modules/engine/src/stores/settings", () => ({
  useSettingsStore: {getState: () => ({loadAllSettings: mockLoadSettings})},
}))
jest.mock("../../../modules/engine/src/types", () => ({DeviceTypes: {LIVE: "Mentra Live"}}))
const mockLoadSettings = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  mockLoadSettings.mockResolvedValue({is_error: () => false})
  jest.mocked(projectPairingIdentity).mockReturnValue({kind: "paired", model: "Mentra Live", name: "Mentra_Live_test"})
  jest
    .mocked(submitAutomaticReport)
    .mockResolvedValue({status: "submitted", reportId: "rep_test", reportStatus: "ready"})
  jest.mocked(reports.waitForCollection).mockResolvedValue({reportId: "rep_test", state: "complete", logCollection: {}})
})

it("files a requested incident and awaits all paired Mentra Live device logs", async () => {
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

it.each([
  {kind: "none"} as const,
  {kind: "pending", model: "Mentra Live"} as const,
  {kind: "paired", model: "Even Realities G1", name: "G1"} as const,
])("requires only phone logs when no Mentra Live is paired: %j", async (identity) => {
  jest.mocked(projectPairingIdentity).mockReturnValue(identity)
  await expect(submitIncidentReport({failure_code: "entry_failed"})).resolves.toMatchObject({status: "filed"})
  expect(reports.waitForCollection).toHaveBeenCalledWith("rep_test", {sources: ["phone"], timeoutMs: 20_000})
})

it("does not drop paired glasses requirements if pairing identity changes during submission", async () => {
  jest.mocked(submitAutomaticReport).mockImplementationOnce(async () => {
    jest.mocked(projectPairingIdentity).mockReturnValue({kind: "none"})
    return {status: "submitted", reportId: "rep_test", reportStatus: "ready"}
  })
  await submitIncidentReport({failure_code: "disconnected"})
  expect(reports.waitForCollection).toHaveBeenCalledWith("rep_test", {
    sources: ["phone", "glasses", "glasses_firmware"],
    timeoutMs: 20_000,
  })
})

it("loads pairing settings before deciding which sources are required at cold start", async () => {
  jest.mocked(projectPairingIdentity).mockReturnValue({kind: "none"})
  mockLoadSettings.mockImplementationOnce(async () => {
    jest
      .mocked(projectPairingIdentity)
      .mockReturnValue({kind: "paired", model: "Mentra Live", name: "Mentra_Live_test"})
    return {is_error: () => false}
  })
  await submitIncidentReport({failure_code: "cold_start"})
  expect(reports.waitForCollection).toHaveBeenCalledWith("rep_test", {
    sources: ["phone", "glasses", "glasses_firmware"],
    timeoutMs: 20_000,
  })
  expect(useSettingsStore.getState().loadAllSettings).toHaveBeenCalledTimes(1)
})

it("does not claim a device is unpaired when loading its identity fails", async () => {
  mockLoadSettings.mockResolvedValueOnce({is_error: () => true, error: new Error("read failed")})
  await expect(submitIncidentReport({failure_code: "entry_failed"})).rejects.toMatchObject({result: {status: "failed"}})
  expect(submitAutomaticReport).not.toHaveBeenCalled()
})

it("rejects with a correlated failure when submission fails", async () => {
  jest.mocked(submitAutomaticReport).mockRejectedValue(new Error("Bearer PRIVATE_TOKEN"))
  await expect(submitIncidentReport({alert_id: "test-2", failure_code: "search_failed"})).rejects.toMatchObject({
    name: "IncidentReportError",
    result: {alert_id: "test-2", status: "failed", error: "Incident report submission failed"},
  })
  expect(reports.waitForCollection).not.toHaveBeenCalled()
})

it("does not expose the final filed receipt while device log collection is pending", async () => {
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
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(logged.mock.calls.some(([value]) => String(value).startsWith("INCIDENT_REPORT_RESULT"))).toBe(false)
  finish({reportId: "rep_test", state: "complete", logCollection: {}})
  await expect(pending).resolves.toMatchObject({status: "filed", collection: {state: "complete"}})
  expect(submitAutomaticReport).toHaveBeenCalledTimes(1)
  logged.mockRestore()
})

it.each(["failed", "timed-out", "unavailable"] as const)(
  "rejects and preserves the created incident when required collection is %s",
  async (state) => {
    const collection = {reportId: "rep_test", state, logCollection: {}}
    jest.mocked(reports.waitForCollection).mockRejectedValueOnce(new ReportCollectionError(collection))
    const pending = submitIncidentReport({alert_id: `test-${state}`, failure_code: "original_failure"})
    await expect(pending).rejects.toBeInstanceOf(IncidentReportError)
    await expect(pending).rejects.toMatchObject({
      result: {
        status: "failed",
        report_id: "rep_test",
        incident_id: "rep_test",
        failure_code: "original_failure",
        collection,
      },
    })
    expect(submitAutomaticReport).toHaveBeenCalledTimes(1)
  },
)

it("preserves successful phone and ASG receipts when firmware collection fails", async () => {
  const collection = {
    reportId: "rep_test",
    state: "failed" as const,
    logCollection: {
      phone: {
        state: "received" as const,
        artifactId: "art_phone",
        requestedAt: "2026-10-09T00:00:00.000Z",
        deadlineAt: "2026-10-09T00:00:20.000Z",
      },
      glasses_firmware: {
        state: "failed" as const,
        reason: "firmware_read_failed",
        requestedAt: "2026-10-09T00:00:00.000Z",
        deadlineAt: "2026-10-09T00:00:20.000Z",
      },
    },
  }
  jest.mocked(reports.waitForCollection).mockRejectedValueOnce(new ReportCollectionError(collection))
  await expect(submitIncidentReport({failure_code: "original_failure"})).rejects.toMatchObject({result: {collection}})
})

it("rejects with the report ID and a safe message after an unexpected collection read failure", async () => {
  jest.mocked(reports.waitForCollection).mockRejectedValueOnce(new Error("Bearer PRIVATE_TOKEN"))
  await expect(
    submitIncidentReport({alert_id: "test-read-error", failure_code: "original_failure"}),
  ).rejects.toMatchObject({
    result: {
      status: "failed",
      report_id: "rep_test",
      collection: {state: "unavailable"},
      error: "Required incident log collection did not complete",
    },
  })
  expect(submitAutomaticReport).toHaveBeenCalledTimes(1)
})

it.each([
  {status: "skipped", reason: "throttled_within_window"} as const,
  {status: "failed", error: "upload_failed"} as const,
])("rejects an incomplete submission without starting collection: %j", async (result) => {
  jest.mocked(submitAutomaticReport).mockResolvedValueOnce(result)
  await expect(
    submitIncidentReport({alert_id: "test-skipped", failure_code: "original_failure"}),
  ).rejects.toMatchObject({
    result: {status: result.status, failure_code: "original_failure"},
  })
  expect(reports.waitForCollection).not.toHaveBeenCalled()
})
