const E2E_METRIC_PREFIX = "E2E_METRIC"

export type E2EMetricPayload = Record<string, unknown>

export function e2eMetricsEnabled(): boolean {
  return process.env.EXPO_PUBLIC_ENABLE_E2E_METRICS === "true"
}

export function buildE2EMetric(event: string, payload: E2EMetricPayload = {}): E2EMetricPayload {
  // Payload first: the system-set `event` and `ts_ms` fields always win, so a
  // caller-supplied collision can't mislabel or re-timestamp the metric.
  return {
    ...payload,
    event,
    ts_ms: Date.now(),
  }
}

export function logE2EMetricPayload(metric: E2EMetricPayload, failureLabel = "payload"): void {
  if (!e2eMetricsEnabled()) return
  try {
    console.log(`${E2E_METRIC_PREFIX} ${JSON.stringify(metric)}`)
  } catch (error) {
    console.warn(`E2E_METRIC: failed to serialize ${failureLabel}`, error)
  }
}

export function logE2EMetric(event: string, payload: E2EMetricPayload = {}): void {
  logE2EMetricPayload(buildE2EMetric(event, payload), event)
}
