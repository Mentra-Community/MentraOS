import type {ReportTrigger} from "@mentra/island"

export type ReportSubmissionMode = "USER_INITIATED" | "AUTOMATIC"

export interface BugReportCategorization {
  submissionMode: ReportSubmissionMode
  triggerArea: string
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
      area: categorization.triggerArea,
      reason: categorization.triggerReason,
      ...source,
    }
  }

  return {
    type: "manual",
    surface: categorization.triggerArea,
    reason: categorization.triggerReason,
    ...source,
  }
}
