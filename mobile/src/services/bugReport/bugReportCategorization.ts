import type {ReportTrigger} from "@mentra/engine"

export interface BugReportCategorization {
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

  return {
    type: "manual",
    source: categorization.triggerSource,
    reason: categorization.triggerReason,
    ...source,
  }
}
