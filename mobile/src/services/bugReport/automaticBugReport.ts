import type * as ImagePicker from "expo-image-picker"

import {toolkit} from "@mentra/island"
import {logBuffer} from "@/utils/dev/logging"
import {buildBugReportFeedbackDataForBug, buildBugReportPhoneState, submitBugIncident} from "./bugReportIncident"
import {buildIncidentCategorization, type IncidentCategorization} from "./incidentCategorization"

export interface SubmitCategorizedBugIncidentParams {
  categorization: IncidentCategorization
  expectedBehavior: string
  actualBehavior: string
  severityRating: number
  contactEmail?: string
  screenshots?: ImagePicker.ImagePickerAsset[]
}

export async function submitCategorizedBugIncident(
  params: SubmitCategorizedBugIncidentParams,
): Promise<{ok: true; incidentId: string} | {ok: false; error: Error}> {
  const feedbackData = await buildBugReportFeedbackDataForBug({
    expectedBehavior: params.expectedBehavior,
    actualBehavior: params.actualBehavior,
    severityRating: params.severityRating,
    contactEmail: params.contactEmail,
    extraFeedbackFields: buildIncidentCategorization(params.categorization),
  })

  return submitBugIncident(feedbackData, {screenshots: params.screenshots})
}

export interface SubmitAutomaticBugIncidentParams extends SubmitCategorizedBugIncidentParams {
  dedupeKey?: string
  dedupeWindowMs?: number
  logTag?: string
}

export type AutomaticBugIncidentResult =
  | {status: "filed"; incidentId: string}
  | {status: "skipped"; reason: string}
  | {status: "failed"; error: string}

export async function submitAutomaticBugIncident(
  params: SubmitAutomaticBugIncidentParams,
): Promise<AutomaticBugIncidentResult> {
  const logTag = params.logTag || "AutomaticBugReport"

  try {
    const feedbackData = await buildBugReportFeedbackDataForBug({
      expectedBehavior: params.expectedBehavior,
      actualBehavior: params.actualBehavior,
      severityRating: params.severityRating,
      contactEmail: params.contactEmail,
      extraFeedbackFields: buildIncidentCategorization(params.categorization),
    })
    const result = await toolkit.incidents.fileAutomatic({
      feedbackData,
      phoneState: buildBugReportPhoneState(),
      logs: logBuffer.getRecentLogs(),
      screenshots: params.screenshots,
      dedupeKey: params.dedupeKey,
      dedupeWindowMs: params.dedupeWindowMs,
    })

    if (result.status === "skipped") {
      console.log(`[${logTag}] Skipping duplicate within window:`, params.dedupeKey)
      return result
    }
    if (result.status === "failed") {
      console.error(`[${logTag}] submitBugIncident failed:`, result.error)
      return result
    }

    console.log(`[${logTag}] Incident filed:`, result.incidentId)
    return result
  } catch (error) {
    console.error(`[${logTag}] Unexpected error:`, error)
    return {status: "failed", error: error instanceof Error ? error.message : String(error)}
  }
}
