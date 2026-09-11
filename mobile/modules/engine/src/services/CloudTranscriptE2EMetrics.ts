import type {TranscriptionData} from "@mentra/cloud-protocol"

import {buildE2EMetric, logE2EMetricPayload} from "../utils/e2eMetrics"

export function buildCloudV2TranscriptMetric(data: TranscriptionData): Record<string, unknown> {
  return buildE2EMetric("cloud_v2_transcript", {
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
  })
}

export function logCloudV2TranscriptMetric(data: TranscriptionData): void {
  logE2EMetricPayload(buildCloudV2TranscriptMetric(data), "cloud_v2_transcript")
}
