import type * as ImagePicker from "expo-image-picker"

import {engine, type ReportDetails, type ReportTrigger} from "@mentra/engine"

export interface SubmitBugReportInput {
  trigger: ReportTrigger
  report: ReportDetails
}

export interface SubmitBugReportOptions {
  screenshots?: ImagePicker.ImagePickerAsset[]
}

export function buildReportDetails(input: {
  expectedBehavior?: string
  actualBehavior: string
  userSeverity?: 1 | 2 | 3 | 4 | 5
  systemPriority?: ReportDetails["systemPriority"]
  contactEmail?: string
}): ReportDetails {
  const expectedBehavior = input.expectedBehavior?.trim()
  const actualBehavior = input.actualBehavior.trim()
  const contactEmail = input.contactEmail?.trim()

  return {
    actualBehavior,
    ...(expectedBehavior && {expectedBehavior}),
    ...(input.userSeverity && {userSeverity: input.userSeverity}),
    ...(input.systemPriority && {systemPriority: input.systemPriority}),
    ...(contactEmail && {contactEmail}),
  }
}

/**
 * UI/trigger-specific code passes what happened; engine owns context
 * collection, logs, Cloud V2 calls, screenshots, and glasses notification.
 */
export async function submitBugReport(
  input: SubmitBugReportInput,
  options?: SubmitBugReportOptions,
): Promise<{ok: true; reportId: string} | {ok: false; error: Error}> {
  const res = await engine.reports.submit({
    kind: "bug",
    trigger: input.trigger,
    report: input.report,
    screenshots: options?.screenshots,
  })
  if (res.status === "failed") {
    return {ok: false, error: new Error(res.error)}
  }
  if (res.status === "skipped") {
    return {ok: false, error: new Error(res.reason)}
  }

  return {ok: true, reportId: res.reportId}
}
