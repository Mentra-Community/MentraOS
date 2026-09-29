import {submitIncidentReport, type IncidentReportResult} from "@mentra/engine"

const fields = {
  alert_id: 160,
  failure_code: 160,
  failure_message: 8192,
  test_run_id: 160,
  scenario_name: 256,
  source: 160,
  dashboard_url: 2048,
  expected_behavior: 8192,
} as const

export type IncidentReportRequest = Partial<Record<keyof typeof fields, string>> & {
  alert_id: string
  failure_code: string
  failure_message: string
}

export function parseIncidentReportRequest(
  params: Record<string, unknown>,
): {ok: true; request: IncidentReportRequest} | {ok: false; error: string} {
  const request: Partial<Record<keyof typeof fields, string>> = {}
  for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
    const value = params[key]
    if (value === undefined) continue
    if (typeof value !== "string" || !value.trim() || value.length > fields[key]) {
      return {ok: false, error: `Invalid ${key}`}
    }
    request[key] = value
  }
  if (!request.alert_id || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(request.alert_id)) {
    return {ok: false, error: "A unique alert_id is required"}
  }
  if (!request.failure_code || !request.failure_message) {
    return {ok: false, error: "failure_code and failure_message are required"}
  }
  return {ok: true, request: request as IncidentReportRequest}
}

type Submission = {input: string; result: Promise<IncidentReportResult>; settled: boolean}
const submissions = new Map<string, Submission>()
const MAX_REMEMBERED_REQUESTS = 32

function failed(request: IncidentReportRequest, error: string): IncidentReportResult {
  return {
    alert_id: request.alert_id,
    test_run_id: request.test_run_id,
    failure_code: request.failure_code,
    status: "failed",
    error,
  }
}

/** Cold-start URL delivery and React remounts must not file the same request twice.
 * This is process-local request reuse, separate from the engine's incident throttle.
 * Include deployment and account identity in the scope; never include credentials.
 */
export function submitIncidentReportOnce(scope: string, request: IncidentReportRequest): Promise<IncidentReportResult> {
  const key = JSON.stringify([scope, request.alert_id])
  const input = JSON.stringify(request)
  const existing = submissions.get(key)
  if (existing) {
    if (existing.input === input) return existing.result
    return Promise.resolve(failed(request, "alert_id was reused with different report details"))
  }
  if (submissions.size >= MAX_REMEMBERED_REQUESTS) {
    const oldest = [...submissions].find(([, entry]) => entry.settled)
    if (oldest) submissions.delete(oldest[0])
    else return Promise.resolve(failed(request, "Too many incident requests are in progress"))
  }
  const entry: Submission = {
    input,
    settled: false,
    result: Promise.resolve()
      .then(() => submitIncidentReport(request))
      .catch((error: unknown) => failed(request, error instanceof Error ? error.message : String(error)))
      .finally(() => {
        entry.settled = true
      }),
  }
  submissions.set(key, entry)
  return entry.result
}
