const E2E_METRIC_PREFIX = "E2E_METRIC"
const E2E_METRICS_ENABLED = process.env.EXPO_PUBLIC_ENABLE_E2E_METRICS === "true"

export interface E2EMetricPayload {
  [key: string]: unknown
}

export const logE2EMetric = (event: string, payload: E2EMetricPayload = {}) => {
  if (!E2E_METRICS_ENABLED) {
    return
  }

  try {
    console.log(
      `${E2E_METRIC_PREFIX} ${JSON.stringify({
        event,
        ts_ms: Date.now(),
        ...payload,
      })}`,
    )
  } catch (error) {
    console.warn("E2E_METRIC: failed to serialize payload", error)
  }
}

export const extractDisplayText = (displayEvent: any): string[] => {
  const layout = displayEvent?.layout
  if (!layout || typeof layout !== "object") {
    return []
  }

  switch (layout.layoutType) {
    case "text_wall":
    case "text_line":
      return typeof layout.text === "string" ? layout.text.split("\n") : []
    case "double_text_wall":
      return [layout.topText, layout.bottomText].filter((value): value is string => typeof value === "string")
    case "text_rows":
      return Array.isArray(layout.text)
        ? layout.text.filter((value: unknown): value is string => typeof value === "string")
        : []
    default:
      return []
  }
}
