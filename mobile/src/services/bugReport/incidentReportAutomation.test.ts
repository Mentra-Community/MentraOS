import {submitIncidentReport} from "@mentra/engine"

import {parseIncidentReportRequest, submitIncidentReportOnce} from "./incidentReportAutomation"

const mockSuperMode = jest.fn()
jest.mock("@mentra/engine", () => ({
  engine: {settings: {get: () => mockSuperMode()}},
  SETTINGS: {super_mode: {key: "super_mode"}},
  submitIncidentReport: jest.fn(),
}))

const request = {
  alert_id: "ios-ota-1",
  test_run_id: "run-1",
  failure_code: "ota_failed",
  failure_message: "Update failed & stopped",
}
const receipt = {...request, status: "filed", report_id: "rep_test", incident_id: "rep_test"}

beforeEach(() => {
  jest.clearAllMocks()
  mockSuperMode.mockReturnValue(false)
  jest.mocked(submitIncidentReport).mockResolvedValue(receipt as Awaited<ReturnType<typeof submitIncidentReport>>)
})

it("preserves decoded report details and drops fields outside the trigger contract", () => {
  expect(parseIncidentReportRequest({...request, callback_url: "https://untrusted.example", token: "ignored"})).toEqual(
    {ok: true, request},
  )
})

it.each([
  {...request, alert_id: undefined},
  {...request, alert_id: "wrong id"},
  {...request, failure_code: ""},
  {...request, failure_message: "x".repeat(8193)},
  {...request, test_run_id: ["one", "two"]},
])("rejects an invalid or ambiguous request", (input) => {
  expect(parseIncidentReportRequest(input).ok).toBe(false)
})

it("reuses a normal-mode in-flight and completed request after a screen remount", async () => {
  let finish!: (value: Awaited<ReturnType<typeof submitIncidentReport>>) => void
  jest.mocked(submitIncidentReport).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const first = submitIncidentReportOnce("account-a/dev", request)
  const second = submitIncidentReportOnce("account-a/dev", request)
  await Promise.resolve()
  expect(submitIncidentReport).toHaveBeenCalledTimes(1)
  finish(receipt as Awaited<ReturnType<typeof submitIncidentReport>>)
  await expect(first).resolves.toMatchObject({incident_id: "rep_test"})
  expect(second).toBe(first)
  expect(submitIncidentReportOnce("account-a/dev", request)).toBe(first)
  expect(mockSuperMode).not.toHaveBeenCalled()
})

it("does not reuse another account's or deployment's incident", async () => {
  await submitIncidentReportOnce("account-b/dev", request)
  await submitIncidentReportOnce("account-b/staging", request)
  await submitIncidentReportOnce("account-c/dev", request)
  expect(submitIncidentReport).toHaveBeenCalledTimes(3)
})

it("rejects different details under an already used alert ID", async () => {
  await submitIncidentReportOnce("conflict", request)
  await expect(
    submitIncidentReportOnce("conflict", {...request, failure_message: "Different failure"}),
  ).resolves.toMatchObject({
    alert_id: request.alert_id,
    status: "failed",
    error: "alert_id was reused with different report details",
  })
  expect(submitIncidentReport).toHaveBeenCalledTimes(1)
})

it("returns a correlated failure if the uploader unexpectedly rejects", async () => {
  jest.mocked(submitIncidentReport).mockRejectedValueOnce(new Error("offline"))
  await expect(submitIncidentReportOnce("offline", request)).resolves.toMatchObject({
    alert_id: request.alert_id,
    test_run_id: request.test_run_id,
    status: "failed",
    error: "offline",
  })
})

it.each(["Mac", "Android"])("submits a first normal-mode %s report through the shared uploader", async (source) => {
  const input = {...request, alert_id: `normal-mode-${source}`, source}
  const result = {...receipt, ...input}
  jest.mocked(submitIncidentReport).mockResolvedValueOnce(result as Awaited<ReturnType<typeof submitIncidentReport>>)

  await expect(submitIncidentReportOnce(`normal-mode-${source}/dev`, input)).resolves.toEqual(result)
  expect(submitIncidentReport).toHaveBeenCalledTimes(1)
  expect(submitIncidentReport).toHaveBeenCalledWith(input)
  expect(mockSuperMode).not.toHaveBeenCalled()
})
