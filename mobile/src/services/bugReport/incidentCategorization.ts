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

export function buildIncidentCategorization(categorization: IncidentCategorization): Record<string, unknown> {
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
