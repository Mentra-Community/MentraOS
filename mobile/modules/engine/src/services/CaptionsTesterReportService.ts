import CrustModule from "@mentra/crust"

import {submitAutomaticReport} from "../facades/reports"
import {
  logAutomaticReportSubmissionStatus,
  logUnexpectedAutomaticReportError,
  toAutomaticReportSubmissionStatus,
  type AutomaticReportSubmissionStatus,
} from "./AutomaticReportResult"

const LOG_TAG = "CaptionsTesterBugReport"
const EVENT_NAME = "captions_tester_incident"

let subscription: {remove: () => void} | null = null

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
}): void {
  const {alertId, testRunId, failureCode, scenarioName, result} = params
  const reportId = result.status === "filed" ? result.reportId : undefined

  console.log(
    `CAPTIONS_TESTER_INCIDENT_RESULT ${JSON.stringify({
      alert_id: alertId,
      test_run_id: testRunId,
      failure_code: failureCode,
      scenario_name: scenarioName,
      status: result.status,
      report_id: reportId,
      incident_id: reportId,
      reason: result.status === "skipped" ? result.reason : undefined,
      error: result.status === "failed" ? result.error : undefined,
    })}`,
  )
}

export async function submitCaptionsTesterIncidentReport(rawEvent: unknown): Promise<void> {
  const event = rawEvent && typeof rawEvent === "object" ? (rawEvent as Record<string, unknown>) : {}
  const failureCode = readString(event, "failure_code") ?? "unknown"
  const failureMessage = readString(event, "failure_message") ?? "Captions tester incident detected."
  const testRunId = readString(event, "test_run_id")
  const scenarioName = readString(event, "scenario_name")
  const alertId = readString(event, "alert_id") ?? testRunId
  const dashboardUrl = readString(event, "dashboard_url")
  const expectedBehavior = dashboardUrl
    ? `Captions tester runs should complete without a captions incident. Check live dashboard: ${dashboardUrl}.`
    : "Captions tester runs should complete without a captions incident."

  const actualBehavior = JSON.stringify(
    {
      failureCode,
      failureMessage,
      testRunId,
      scenarioName,
      event,
    },
    null,
    2,
  )

  const throttleKey = ["captions_tester", failureCode, scenarioName || "unknown", testRunId || "unknown"].join("|")

  try {
    const submitResult = await submitAutomaticReport({
      kind: "automatic",
      trigger: {
        type: "automatic",
        source: "captions_tester",
        reason: "captions_incident_detected",
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
    logIncidentResult({alertId, testRunId, failureCode, scenarioName, result})
  } catch (error) {
    const result = logUnexpectedAutomaticReportError(LOG_TAG, error)
    logIncidentResult({alertId, testRunId, failureCode, scenarioName, result})
  }
}

export function startCaptionsTesterReportService(): void {
  if (subscription) return
  subscription = (CrustModule.addListener as any)(EVENT_NAME, (event: unknown) => {
    void submitCaptionsTesterIncidentReport(event)
  })
}

export function stopCaptionsTesterReportService(): void {
  subscription?.remove()
  subscription = null
}
