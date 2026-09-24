import CrustModule from "@mentra/crust"

import {submitAutomaticReport} from "../facades/reports"
import {
  logAutomaticReportSubmissionStatus,
  logUnexpectedAutomaticReportError,
  toAutomaticReportSubmissionStatus,
  type AutomaticReportSubmissionStatus,
} from "./AutomaticReportResult"

const LOG_TAG = "SubmitIncidentReport"
const EVENT_NAME = "submit_incident_report"

let subscription: {remove: () => void} | null = null

export type IncidentReportResult = {
  alert_id?: string
  test_run_id?: string
  failure_code: string
  scenario_name?: string
  status: AutomaticReportSubmissionStatus["status"]
  report_id?: string
  incident_id?: string
  reason?: string
  error?: string
}

function readString(event: Record<string, unknown>, key: string): string | undefined {
  const value = event[key]
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function logIncidentResult(params: {
  alertId?: string
  testRunId?: string
  failureCode: string
  scenarioName?: string
  result: AutomaticReportSubmissionStatus
}): IncidentReportResult {
  const {alertId, testRunId, failureCode, scenarioName, result} = params
  const reportId = result.status === "filed" ? result.reportId : undefined

  const payload: IncidentReportResult = {
    alert_id: alertId,
    test_run_id: testRunId,
    failure_code: failureCode,
    scenario_name: scenarioName,
    status: result.status,
    report_id: reportId,
    incident_id: reportId,
    reason: result.status === "skipped" ? result.reason : undefined,
    error: result.status === "failed" ? result.error : undefined,
  }
  console.log(`INCIDENT_REPORT_RESULT ${JSON.stringify(payload)}`)
  return payload
}

export async function submitIncidentReport(rawEvent: unknown): Promise<IncidentReportResult> {
  const event = rawEvent && typeof rawEvent === "object" ? (rawEvent as Record<string, unknown>) : {}
  const failureCode = readString(event, "failure_code") ?? "unknown"
  const failureMessage = readString(event, "failure_message") ?? "Incident report requested."
  const source = readString(event, "source") ?? "external_trigger"
  const testRunId = readString(event, "test_run_id")
  const scenarioName = readString(event, "scenario_name")
  const alertId = readString(event, "alert_id") ?? testRunId
  const dashboardUrl = readString(event, "dashboard_url")
  const expectedBehavior =
    readString(event, "expected_behavior") ??
    (dashboardUrl
      ? `The workflow should complete without this incident. See dashboard: ${dashboardUrl}.`
      : "The workflow should complete without this incident.")

  const throttleKey = [source, failureCode, scenarioName || "unknown", alertId || "unknown"].join("|")

  try {
    if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent))
      throw new Error("Incident report request must be an object")
    const actualBehavior = JSON.stringify({failureCode, failureMessage, testRunId, scenarioName, event}, null, 2)
    const submitResult = await submitAutomaticReport({
      kind: "automatic",
      trigger: {
        type: "automatic",
        source,
        reason: "incident_report_requested",
      },
      report: {
        expectedBehavior,
        actualBehavior,
        systemPriority: "medium",
      },
      throttleKey,
    })

    const result = toAutomaticReportSubmissionStatus(submitResult)
    logAutomaticReportSubmissionStatus(LOG_TAG, result, throttleKey)
    return logIncidentResult({alertId, testRunId, failureCode, scenarioName, result})
  } catch (error) {
    const result = logUnexpectedAutomaticReportError(LOG_TAG, error)
    return logIncidentResult({alertId, testRunId, failureCode, scenarioName, result})
  }
}

export function startSubmitIncidentReportService(): void {
  if (subscription) return
  subscription = CrustModule.addListener(EVENT_NAME, (event) => {
    void submitIncidentReport(event)
  })
}

export function stopSubmitIncidentReportService(): void {
  subscription?.remove()
  subscription = null
}
