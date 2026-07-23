import type * as ImagePicker from "expo-image-picker"

import {engine, type ReportContext, type ReportDetails, type ReportTrigger} from "@mentra/engine"

export interface SubmitBugReportInput {
  trigger: ReportTrigger
  report: ReportDetails
  context?: Partial<ReportContext>
}

export interface SubmitBugReportOptions {
  screenshots?: ImagePicker.ImagePickerAsset[]
}

export function resolveFeedbackTriggerReason(
  providedReason: string | string[] | undefined,
  feedbackType: "bug" | "feature",
): string {
  if (typeof providedReason === "string" && providedReason.trim()) return providedReason.trim()
  return feedbackType === "bug" ? "manual_bug_report" : "manual_feedback"
}

export function buildReportSurfaceContext(input: {
  surface: string
  route: string
  source: string
  sourceRoute?: string | null
  reason: string
  sourceAppletPackageName?: string
  sourceAppletName?: string
  userSelectedSubject?: boolean
}): Partial<ReportContext> {
  const packageName = input.sourceAppletPackageName?.trim()
  const name = input.sourceAppletName?.trim()
  const userSelectedSubject = input.userSelectedSubject === true

  return {
    reporting: {
      surface: input.surface,
      route: input.route,
      openedFrom: {
        source: input.source,
        reason: input.reason,
        ...(input.sourceRoute ? {route: input.sourceRoute} : {}),
      },
      subject: packageName
        ? {
            packageName,
            ...(name ? {name} : {}),
            attribution: userSelectedSubject ? "user_selection" : "launch_context",
          }
        : null,
      userSelectedSubject,
    },
  }
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
    context: input.context,
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
