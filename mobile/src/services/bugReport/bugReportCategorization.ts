import type {ReportTrigger} from "@mentra/island"

export type ReportSubmissionMode = "USER_INITIATED" | "AUTOMATIC"

export interface BugReportCategorization {
  submissionMode: ReportSubmissionMode
  triggerSource: string
  triggerReason: string
  sourceAppletPackageName?: string
  sourceAppletName?: string
}

export function normalizeOptionalReportString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function buildReportTrigger(categorization: BugReportCategorization): ReportTrigger {
  const sourceAppletPackageName = normalizeOptionalReportString(categorization.sourceAppletPackageName)
  const sourceAppletName = normalizeOptionalReportString(categorization.sourceAppletName)
  const source = {
    ...(sourceAppletPackageName && {sourceAppletPackageName}),
    ...(sourceAppletName && {sourceAppletName}),
  }

  if (categorization.submissionMode === "AUTOMATIC") {
    return {
      type: "automatic",
      source: categorization.triggerSource,
      reason: categorization.triggerReason,
      ...source,
    }
  }

  return {
    type: "manual",
    source: categorization.triggerSource,
    reason: categorization.triggerReason,
    ...source,
  }
}
