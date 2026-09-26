export type DiagnosticRenderSurface = "glasses_battery" | "wifi_scan"

export type ReportDiagnosticRender = (
  surface: DiagnosticRenderSurface,
  eventIds: string[],
  value?: number | null,
) => boolean

/** Largest value each surface's evidence can represent (native enforces the same bounds). */
const MAX_VALUE: Record<DiagnosticRenderSurface, number> = {glasses_battery: 100, wifi_scan: 500}

/**
 * Wraps the Android-only native render marker. An empty id list is forwarded because it is
 * meaningful: it invalidates the surface's earlier marker. A displayed value the evidence
 * cannot represent (not an integer, or outside the surface's range) is sent as a withdrawal
 * (no ids, null value) rather than dropped or passed through, so an earlier marker never stays
 * attributed to it. Returns false (and does nothing) on other platforms, on native builds
 * without the function, or when the native call throws.
 */
export function createReportDiagnosticRender(
  native: Record<string, unknown>,
  platformOs: string,
): ReportDiagnosticRender {
  const nativeReport = native.reportDiagnosticRender
  return (surface, eventIds, value) => {
    if (platformOs !== "android" || typeof nativeReport !== "function") return false
    const representable = value == null || (Number.isInteger(value) && value >= 0 && value <= MAX_VALUE[surface])
    try {
      if (!representable) return Boolean(nativeReport.call(native, surface, [], null))
      return Boolean(nativeReport.call(native, surface, eventIds, value ?? null))
    } catch {
      return false
    }
  }
}
