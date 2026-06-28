import type {IncidentBugFeedbackData} from "@mentra/island"

export type IncidentSubmissionMode = "USER_INITIATED" | "AUTOMATIC"

export interface IncidentCategorization {
  submissionMode: IncidentSubmissionMode
  triggerArea: string
  triggerReason: string
  sourceAppletPackageName?: string
  sourceAppletName?: string
}

export function normalizeOptionalIncidentString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export type IncidentCategorizationFields = Pick<
  IncidentBugFeedbackData,
  "submissionMode" | "triggerArea" | "triggerReason"
> &
  Partial<Pick<IncidentBugFeedbackData, "sourceAppletPackageName" | "sourceAppletName">> &
  Record<string, unknown>

export function buildIncidentCategorization(categorization: IncidentCategorization): IncidentCategorizationFields {
  const sourceAppletPackageName = normalizeOptionalIncidentString(categorization.sourceAppletPackageName)
  const sourceAppletName = normalizeOptionalIncidentString(categorization.sourceAppletName)

  return {
    submissionMode: categorization.submissionMode,
    triggerArea: categorization.triggerArea,
    triggerReason: categorization.triggerReason,
    ...(sourceAppletPackageName && {sourceAppletPackageName}),
    ...(sourceAppletName && {sourceAppletName}),
  }
}
