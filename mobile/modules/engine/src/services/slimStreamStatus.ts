import type {StreamStatusEvent} from "@mentra/bluetooth-sdk/internal"

/**
 * 1Hz encoder FPS/bitrate telemetry on `stream_status.stats`.
 * Lifecycle status (started/stopped/error) is unaffected.
 * Keep false in production; flip locally to debug the Mentra Call FPS ladder.
 *
 * Compatibility kill switch: old glasses can still emit stats. Copy onto a new object;
 * never mutate the incoming event. Manual acceptance with every layer false: join
 * waterfall yes; BLE stream_status.stats / STREAM_QUALITY / encoder-stats / watch-stats no.
 */
export const ENABLE_PIPELINE_FPS_TELEMETRY = false

/** Fields forwarded to cloud / miniapps after the first resolvedConfig ack. */
export function slimStreamStatusEvent(
  event: StreamStatusEvent,
  options: {includeResolvedConfig?: boolean; enableFpsTelemetry?: boolean} = {},
): Record<string, unknown> {
  const enableFpsTelemetry = options.enableFpsTelemetry ?? ENABLE_PIPELINE_FPS_TELEMETRY
  const slim: Record<string, unknown> = {
    type: "stream_status",
    kind: event.kind,
    status: event.status,
  }
  if (event.streamId) slim.streamId = event.streamId
  if (event.sid) slim.sid = event.sid
  if (typeof event.revision === "number") slim.revision = event.revision
  if (typeof event.terminal === "boolean") slim.terminal = event.terminal
  if ("willRetry" in event && typeof event.willRetry === "boolean") slim.willRetry = event.willRetry
  if (event.errorDetails) slim.errorDetails = event.errorDetails
  if (event.kind === "reconnect") {
    if ("reason" in event) slim.reason = event.reason
    if ("attempt" in event) slim.attempt = event.attempt
    if ("maxAttempts" in event) slim.maxAttempts = event.maxAttempts
  }
  const ts = event.timestamp
  if (typeof ts === "number" && Number.isFinite(ts)) slim.timestamp = ts
  if (options.includeResolvedConfig && event.resolvedConfig) {
    slim.resolvedConfig = event.resolvedConfig
  }
  // Compatibility kill switch: old glasses may still emit 1Hz stats. Copy onto a
  // new object; never mutate `event` — other consumers may still need the original.
  if (enableFpsTelemetry && event.stats) slim.stats = event.stats
  return slim
}

export function streamStatusSignature(payload: Record<string, unknown>): string {
  return JSON.stringify(payload)
}
