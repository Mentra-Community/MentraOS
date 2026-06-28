import type {IncidentTrigger} from "@mentra/island"

export type IncidentSubmissionMode = "USER_INITIATED" | "AUTOMATIC"

export interface IncidentCategorization {
  submissionMode: IncidentSubmissionMode
  triggerArea: string
  triggerReason: string
  sourceAppletPackageName?: string
  sourceAppletName?: string
}

export function normalizeOptionalIncidentString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function buildIncidentTrigger(categorization: IncidentCategorization): IncidentTrigger {
  const sourceAppletPackageName = normalizeOptionalIncidentString(categorization.sourceAppletPackageName)
  const sourceAppletName = normalizeOptionalIncidentString(categorization.sourceAppletName)
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
