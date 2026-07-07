import type {StreamStatusEvent} from "@mentra/bluetooth-sdk-internal"

/** Fields forwarded to cloud / miniapps after the first resolvedConfig ack. */
export function slimStreamStatusEvent(
  event: StreamStatusEvent,
  options: {includeResolvedConfig?: boolean} = {},
): Record<string, unknown> {
  const slim: Record<string, unknown> = {
    type: "stream_status",
    kind: event.kind,
    status: event.status,
  }
  if (event.streamId) slim.streamId = event.streamId
  const ts = event.timestamp
  if (typeof ts === "number" && Number.isFinite(ts)) slim.timestamp = ts
  if (options.includeResolvedConfig && event.resolvedConfig) {
    slim.resolvedConfig = event.resolvedConfig
  }
  return slim
}

export function streamStatusSignature(payload: Record<string, unknown>): string {
  return JSON.stringify(payload)
}
