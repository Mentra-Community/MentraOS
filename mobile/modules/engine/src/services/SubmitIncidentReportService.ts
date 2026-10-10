import {ReportCollectionError, reports, submitAutomaticReport, type ReportCollectionResult} from "../facades/reports"
import {useSettingsStore} from "../stores/settings"
import {DeviceTypes} from "../types"
import {
  logAutomaticReportSubmissionStatus,
  toAutomaticReportSubmissionStatus,
  type AutomaticReportSubmissionStatus,
} from "./AutomaticReportResult"
import {projectPairingIdentity} from "./PairingIdentity"

const LOG_TAG = "SubmitIncidentReport"
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
  collection?: ReportCollectionResult
}

/** A rejected submission retains any created report and its partial collection receipts. */
export class IncidentReportError extends Error {
  constructor(readonly result: IncidentReportResult) {
    super(result.error ?? result.reason ?? "Incident report submission did not complete")
    this.name = "IncidentReportError"
  }
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
  reportId?: string
  collection?: ReportCollectionResult
}): IncidentReportResult {
  const {alertId, testRunId, failureCode, scenarioName, result} = params
  const reportId = result.status === "filed" ? result.reportId : params.reportId

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
    ...(params.collection ? {collection: params.collection} : {}),
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
  let reportId: string | undefined

  try {
    if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent))
      throw new Error("Incident report request must be an object")
    const loaded = await useSettingsStore.getState().loadAllSettings()
    if (loaded.is_error()) throw loaded.error
    // A paired device remains required if it disconnects while collecting. A
    // selection that never completed pairing has no glasses logs to collect.
    const identity = projectPairingIdentity()
    const sources =
      identity.kind === "paired" && identity.model === DeviceTypes.LIVE
        ? (["phone", "glasses", "glasses_firmware"] as const)
        : (["phone"] as const)
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
    if (result.status !== "filed") {
      logAutomaticReportSubmissionStatus(LOG_TAG, result, throttleKey)
      throw new IncidentReportError(logIncidentResult({alertId, testRunId, failureCode, scenarioName, result}))
    }
    reportId = result.reportId
    const collection = await reports.waitForCollection(reportId, {sources: [...sources], timeoutMs: 20_000})
    logAutomaticReportSubmissionStatus(LOG_TAG, result, throttleKey)
    return logIncidentResult({alertId, testRunId, failureCode, scenarioName, result, collection})
  } catch (error) {
    if (error instanceof IncidentReportError) throw error
    const collection =
      error instanceof ReportCollectionError
        ? error.collection
        : reportId
        ? {reportId, state: "unavailable" as const, logCollection: {}}
        : undefined
    const result: AutomaticReportSubmissionStatus = {
      status: "failed",
      error: reportId ? "Required incident log collection did not complete" : "Incident report submission failed",
    }
    logAutomaticReportSubmissionStatus(LOG_TAG, result)
    throw new IncidentReportError(
      logIncidentResult({alertId, testRunId, failureCode, scenarioName, result, reportId, collection}),
    )
  }
}
