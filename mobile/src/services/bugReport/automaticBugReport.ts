import type * as ImagePicker from "expo-image-picker"

import {toolkit, type IncidentReport} from "@mentra/island"
import {buildIncidentReport, submitBugIncident} from "./bugReportIncident"
import {buildIncidentTrigger, type IncidentCategorization} from "./incidentCategorization"

export interface SubmitCategorizedBugIncidentParams {
  categorization: IncidentCategorization
  expectedBehavior: string
  actualBehavior: string
  userSeverity?: 1 | 2 | 3 | 4 | 5
  systemPriority?: IncidentReport["systemPriority"]
  contactEmail?: string
  screenshots?: ImagePicker.ImagePickerAsset[]
}

export async function submitCategorizedBugIncident(
  params: SubmitCategorizedBugIncidentParams,
): Promise<{ok: true; incidentId: string} | {ok: false; error: Error}> {
  return submitBugIncident(
    {
      trigger: buildIncidentTrigger(params.categorization),
      report: buildIncidentReport({
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
    const result = await toolkit.incidents.fileAutomatic({
      trigger: buildIncidentTrigger({
        ...params.categorization,
        submissionMode: "AUTOMATIC",
      }),
      report: buildIncidentReport({
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
