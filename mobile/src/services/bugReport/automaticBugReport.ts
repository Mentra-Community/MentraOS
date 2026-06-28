import type * as ImagePicker from "expo-image-picker"

import {toolkit, type ReportDetails} from "@mentra/island"
import {buildReportTrigger, type BugReportCategorization} from "./bugReportCategorization"
import {buildReportDetails, submitBugReport} from "./bugReportSubmission"

export interface SubmitCategorizedBugReportParams {
  categorization: BugReportCategorization
  expectedBehavior: string
  actualBehavior: string
  userSeverity?: 1 | 2 | 3 | 4 | 5
  systemPriority?: ReportDetails["systemPriority"]
  contactEmail?: string
  screenshots?: ImagePicker.ImagePickerAsset[]
}

export async function submitCategorizedBugReport(
  params: SubmitCategorizedBugReportParams,
): Promise<{ok: true; reportId: string} | {ok: false; error: Error}> {
  return submitBugReport(
    {
      trigger: buildReportTrigger(params.categorization),
      report: buildReportDetails({
        expectedBehavior: params.expectedBehavior,
        actualBehavior: params.actualBehavior,
        userSeverity: params.userSeverity,
        systemPriority: params.systemPriority,
        contactEmail: params.contactEmail,
      }),
    },
    {screenshots: params.screenshots},
  )
}

export interface SubmitAutomaticBugReportParams extends SubmitCategorizedBugReportParams {
  dedupeKey?: string
  dedupeWindowMs?: number
  logTag?: string
}

export type AutomaticBugReportResult =
  | {status: "filed"; reportId: string}
  | {status: "skipped"; reason: string}
  | {status: "failed"; error: string}

export async function submitAutomaticBugReport(
  params: SubmitAutomaticBugReportParams,
): Promise<AutomaticBugReportResult> {
  const logTag = params.logTag || "AutomaticBugReport"

  try {
    const trigger = buildReportTrigger({
      ...params.categorization,
      submissionMode: "AUTOMATIC",
    })
    if (trigger.type !== "automatic") {
      return {status: "failed", error: "automatic bug report trigger was not automatic"}
    }

    const result = await toolkit.reports.submit({
      kind: "automatic",
      trigger,
      report: buildReportDetails({
        expectedBehavior: params.expectedBehavior,
        actualBehavior: params.actualBehavior,
        systemPriority: params.systemPriority ?? "medium",
        contactEmail: params.contactEmail,
      }),
      screenshots: params.screenshots,
      dedupeKey: params.dedupeKey,
      dedupeWindowMs: params.dedupeWindowMs,
    })

    if (result.status === "skipped") {
      console.log(`[${logTag}] Skipping duplicate within window:`, params.dedupeKey)
      return result
    }
    if (result.status === "failed") {
      console.error(`[${logTag}] submitAutomaticBugReport failed:`, result.error)
      return result
    }

    console.log(`[${logTag}] Report filed:`, result.reportId)
    return {status: "filed", reportId: result.reportId}
  } catch (error) {
    console.error(`[${logTag}] Unexpected error:`, error)
    return {status: "failed", error: error instanceof Error ? error.message : String(error)}
  }
}
