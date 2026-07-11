import {
  buildCloudV2TranscriptMetric,
  logCloudV2TranscriptMetric,
} from "../../../modules/engine/src/services/CloudTranscriptE2EMetrics"
import type {TranscriptionData} from "@mentra/cloud-runtime/protocol"

const transcript: TranscriptionData = {
  userId: "user-1",
  subscription: {kind: "transcription", language: {mode: "specific", code: "en-US"}},
  text: "hello world",
  isFinal: true,
  utteranceId: "utt-1",
  speakerId: "speaker-1",
  startMs: 100,
  endMs: 900,
  durationMs: 800,
  confidence: 0.9,
  resolvedLanguage: "en-US",
  languageDetected: false,
  tokens: [
    {
      text: "hello",
      startMs: 100,
      endMs: 400,
      confidence: 0.9,
      isFinal: true,
    },
  ],
  provider: "soniox",
  timestamp: 123456,
}

describe("CloudTranscriptE2EMetrics", () => {
  const originalEnv = process.env.EXPO_PUBLIC_ENABLE_E2E_METRICS
  let nowSpy: jest.SpyInstance
  let logSpy: jest.SpyInstance

  beforeEach(() => {
    nowSpy = jest.spyOn(Date, "now").mockReturnValue(777)
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.EXPO_PUBLIC_ENABLE_E2E_METRICS
    } else {
      process.env.EXPO_PUBLIC_ENABLE_E2E_METRICS = originalEnv
    }
    jest.restoreAllMocks()
  })

  it("builds the cloud v2 transcript metric payload", () => {
    expect(buildCloudV2TranscriptMetric(transcript)).toMatchObject({
      event: "cloud_v2_transcript",
      ts_ms: 777,
      text: "hello world",
      state: "final",
      is_final: true,
      resolved_language: "en-US",
      language_detected: false,
      utterance_id: "utt-1",
      start_ms: 100,
      end_ms: 900,
      duration_ms: 800,
      provider: "soniox",
      timestamp_ms: 123456,
      token_count: 1,
    })
    expect(nowSpy).toHaveBeenCalled()
  })

  it("logs only when e2e metrics are enabled", () => {
    process.env.EXPO_PUBLIC_ENABLE_E2E_METRICS = "false"
    logCloudV2TranscriptMetric(transcript)
    expect(logSpy).not.toHaveBeenCalled()

    process.env.EXPO_PUBLIC_ENABLE_E2E_METRICS = "true"
    logCloudV2TranscriptMetric(transcript)

    expect(logSpy).toHaveBeenCalledTimes(1)
    const line = String(logSpy.mock.calls[0][0])
    expect(line.startsWith("E2E_METRIC ")).toBe(true)
    expect(JSON.parse(line.replace("E2E_METRIC ", ""))).toMatchObject({
      event: "cloud_v2_transcript",
      text: "hello world",
      is_final: true,
    })
  })
})
