import type {ReportSubmitResult} from "../facades/reports"

export type AutomaticReportSubmissionStatus =
  | {status: "filed"; reportId: string}
  | {status: "skipped"; reason: string}
  | {status: "failed"; error: string}

export function toAutomaticReportSubmissionStatus(result: ReportSubmitResult): AutomaticReportSubmissionStatus {
  if (result.status === "submitted") {
    return {status: "filed", reportId: result.reportId}
  }
  if (result.status === "skipped") {
    return {status: "skipped", reason: result.reason}
  }
  return {status: "failed", error: result.error}
}

export function automaticReportErrorStatus(error: unknown): Extract<AutomaticReportSubmissionStatus, {status: "failed"}> {
  return {status: "failed", error: error instanceof Error ? error.message : String(error)}
}

export function logAutomaticReportSubmissionStatus(
  logTag: string,
  result: AutomaticReportSubmissionStatus,
  ...throttleDetails: unknown[]
): void {
  if (result.status === "filed") {
    console.log(`[${logTag}] Report filed:`, result.reportId)
    return
  }
  if (result.status === "skipped") {
    console.log(
      `[${logTag}] Skipping automatic report within throttle window:`,
      ...(throttleDetails.length > 0 ? throttleDetails : [result.reason]),
    )
    return
  }
  console.error(`[${logTag}] submit failed:`, result.error)
}

export function logUnexpectedAutomaticReportError(
  logTag: string,
  error: unknown,
): Extract<AutomaticReportSubmissionStatus, {status: "failed"}> {
  const result = automaticReportErrorStatus(error)
  console.error(`[${logTag}] Unexpected error:`, error)
  return result
}
