export type DiagnosticRenderSurface = "glasses_battery" | "wifi_scan"

export type ReportDiagnosticRender = (
  surface: DiagnosticRenderSurface,
  eventIds: string[],
  value?: number | null,
) => boolean

/**
 * Wraps the Android-only native render marker. An empty id list is forwarded because it is
 * meaningful: it invalidates the surface's earlier marker. Returns false (and does nothing) on
 * other platforms, on native builds without the function, or when the native call throws.
 */
export function createReportDiagnosticRender(
  native: Record<string, unknown>,
  platformOs: string,
): ReportDiagnosticRender {
  const nativeReport = native.reportDiagnosticRender
  return (surface, eventIds, value) => {
    if (platformOs !== "android" || typeof nativeReport !== "function") return false
    try {
      return Boolean(nativeReport.call(native, surface, eventIds, value ?? null))
    } catch {
      return false
    }
  }
}
