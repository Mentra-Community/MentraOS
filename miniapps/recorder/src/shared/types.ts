/**
 * Shared domain types referenced by BOTH the background JSContext and the UI
 * WebView. Both bundlers inline this file at build time. Anything crossing the
 * mentra.send / session.ui channel boundary needs its shape declared here.
 *
 * Note: the UI never imports `@mentra/miniapp/background` (it's browser-side), so
 * the background maps the SDK's `BlobMeta` into the UI-friendly `RecordingItem`.
 */

/** One saved recording, as the UI needs it (a projection of the SDK's BlobMeta). */
export interface RecordingItem {
  id: string
  /** Display name (defaults to the generated file name). */
  name: string
  /** Epoch ms the recording was created. */
  createdAt: number
  /** Size on disk in bytes (WAV incl. header). */
  bytes: number
  /** Duration in milliseconds. */
  durationMs: number
  /** Capture sample rate in Hz. */
  sampleRate: number
  /** True if the recording was capped at the storage quota. */
  truncated?: boolean
  /** Soniox transcript captured live during recording (final text). */
  transcript?: string
}

/** Live status while a capture is in progress. */
export interface RecorderStatus {
  recordingId: string
  /** Elapsed capture time, ms. */
  ms: number
  /** Bytes written so far. */
  bytes: number
  /** Coarse 0–1 input level for the meter. */
  level: number
  /** True while the capture is paused (mic feed suspended). */
  paused?: boolean
}

/** Per-app blob storage usage. */
export interface Usage {
  bytes: number
  count: number
  quotaBytes: number
}

/** Full state pushed to the UI on every WebView open. */
export interface RecorderSnapshot {
  /** Non-null while recording. */
  recording: RecorderStatus | null
  recordings: RecordingItem[]
  usage: Usage
  /** Id of the recording currently playing back, or null. */
  playingId: string | null
  /** True when a glasses microphone is available to record from. */
  hasMic: boolean
}
