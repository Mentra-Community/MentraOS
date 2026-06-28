import CrustModule from "@mentra/crust"

import {submitAutomaticReport, type ReportSubmitResult} from "../facades/reports"

const LOG_TAG = "CaptionsTesterBugReport"
const EVENT_NAME = "captions_tester_incident"

let subscription: {remove: () => void} | null = null

function readString(event: Record<string, unknown>, key: string): string | undefined {
  const value = event[key]
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function buildSubmitStatus(result: ReportSubmitResult):
  | {status: "filed"; reportId: string}
  | {status: "skipped"; reason: string}
  | {status: "failed"; error: string} {
  if (result.status === "submitted") {
    return {status: "filed", reportId: result.reportId}
  }
  if (result.status === "skipped") {
    return {status: "skipped", reason: result.reason}
  }
  return {status: "failed", error: result.error}
}

function logIncidentResult(params: {
  alertId?: string
  testRunId?: string
  failureCode: string
  scenarioName?: string
  result: ReturnType<typeof buildSubmitStatus>
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

  const dedupeKey = ["captions_tester", failureCode, scenarioName || "unknown", testRunId || "unknown"].join("|")

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
      dedupeKey,
    })

    const result = buildSubmitStatus(submitResult)
    if (result.status === "filed") {
      console.log(`[${LOG_TAG}] Report filed:`, result.reportId)
    } else if (result.status === "skipped") {
      console.log(`[${LOG_TAG}] Skipping duplicate within window:`, dedupeKey)
    } else {
      console.error(`[${LOG_TAG}] submit failed:`, result.error)
    }
    logIncidentResult({alertId, testRunId, failureCode, scenarioName, result})
  } catch (error) {
    const result = {status: "failed" as const, error: error instanceof Error ? error.message : String(error)}
    console.error(`[${LOG_TAG}] Unexpected error:`, error)
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
