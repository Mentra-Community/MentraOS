import * as ImagePicker from "expo-image-picker"

import restComms from "@/services/RestComms"
import {buildBugReportFeedbackDataForBug, submitBugIncident} from "./bugReportIncident"
import {buildIncidentCategorization, type IncidentCategorization} from "./incidentCategorization"

export const DEFAULT_AUTOMATIC_INCIDENT_DEDUPE_MS = 90_000

const automaticIncidentDedupeRegistry = new Map<string, number>()

export function automaticIncidentReportDedupeShouldSkip(
  key: string,
  nowMs: number,
  windowMs: number,
  registry: Map<string, number>,
): boolean {
  const previous = registry.get(key)
  if (previous !== undefined && nowMs - previous < windowMs) {
    return true
  }

  registry.set(key, nowMs)
  for (const [entryKey, entryTime] of registry) {
    if (nowMs - entryTime > windowMs * 3) {
      registry.delete(entryKey)
    }
  }

  return false
}

export function resetAutomaticIncidentDedupeRegistryForTests(): void {
  automaticIncidentDedupeRegistry.clear()
}

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

  if (!restComms.getCoreToken()) {
    console.log(`[${logTag}] Skipping: no core token`)
    return {status: "skipped", reason: "no_core_token"}
  }

  if (params.dedupeKey) {
    const now = Date.now()
    const dedupeWindowMs = params.dedupeWindowMs ?? DEFAULT_AUTOMATIC_INCIDENT_DEDUPE_MS
    if (
      automaticIncidentReportDedupeShouldSkip(params.dedupeKey, now, dedupeWindowMs, automaticIncidentDedupeRegistry)
    ) {
      console.log(`[${logTag}] Skipping duplicate within window:`, params.dedupeKey)
      return {status: "skipped", reason: "duplicate_within_window"}
    }
  }

  try {
    const submitRes = await submitCategorizedBugIncident(params)
    if (!submitRes.ok) {
      console.error(`[${logTag}] submitBugIncident failed:`, submitRes.error)
      return {status: "failed", error: submitRes.error.message}
    }

    console.log(`[${logTag}] Incident filed:`, submitRes.incidentId)
    return {status: "filed", incidentId: submitRes.incidentId}
  } catch (error) {
    console.error(`[${logTag}] Unexpected error:`, error)
    return {status: "failed", error: error instanceof Error ? error.message : String(error)}
  }
}
