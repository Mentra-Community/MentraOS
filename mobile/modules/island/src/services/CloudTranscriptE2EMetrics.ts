import type {TranscriptionData} from "@mentra/cloud-runtime/protocol"

const E2E_METRIC_PREFIX = "E2E_METRIC"

function e2eMetricsEnabled(): boolean {
  return process.env.EXPO_PUBLIC_ENABLE_E2E_METRICS === "true"
}

export function buildCloudV2TranscriptMetric(data: TranscriptionData): Record<string, unknown> {
  return {
    event: "cloud_v2_transcript",
    ts_ms: Date.now(),
    text: data.text,
    state: data.isFinal ? "final" : "interim",
    is_final: data.isFinal,
    resolved_language: data.resolvedLanguage,
    language_detected: data.languageDetected,
    utterance_id: data.utteranceId,
    speaker_id: data.speakerId,
    start_ms: data.startMs,
    end_ms: data.endMs,
    duration_ms: data.durationMs,
    provider: data.provider,
    confidence: data.confidence,
    timestamp_ms: data.timestamp,
    token_count: data.tokens.length,
    subscription: data.subscription,
  }
}

export function logCloudV2TranscriptMetric(data: TranscriptionData): void {
  if (!e2eMetricsEnabled()) return
  try {
    console.log(`${E2E_METRIC_PREFIX} ${JSON.stringify(buildCloudV2TranscriptMetric(data))}`)
  } catch (error) {
    console.warn("E2E_METRIC: failed to serialize cloud_v2_transcript", error)
  }
}
