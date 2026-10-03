import type {StreamStartRequest} from "../BluetoothSdk.types"

/**
 * Normalizes stream start request parameters for the native module bridge.
 * Preserves omission of telemetry when undefined so the glasses use their build default,
 * and forwards explicit true / false.
 */
export function streamRequestParamsForNative(params: StreamStartRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    streamUrl: params.streamUrl,
  }
  if (params.type !== undefined) {
    payload.type = params.type
  }
  if (params.streamId !== undefined) {
    payload.streamId = params.streamId
  }
  if (params.sound !== undefined) {
    payload.sound = params.sound
  }
  if (params.video !== undefined) {
    payload.video = params.video
  }
  if (params.audio !== undefined) {
    payload.audio = params.audio
  }
  if (params.ice !== undefined) {
    payload.ice = params.ice
  }
  if (params.captureAudio !== undefined) {
    payload.captureAudio = params.captureAudio
  }
  if (params.traceId !== undefined && params.traceId.length > 0) {
    payload.traceId = params.traceId
  }
  if (params.authToken !== undefined && params.authToken.length > 0) {
    payload.authToken = params.authToken
  }
  if (params.telemetry !== undefined) {
    payload.telemetry = params.telemetry
  }
  return payload
}
