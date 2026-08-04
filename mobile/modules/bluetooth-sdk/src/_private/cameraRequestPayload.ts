import type {WarmUpCameraParams} from "../BluetoothSdk.types"
import {normalizePhotoSizeTier} from "./photoRequestPayload"

function nonBlankString(value?: string | null): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

/** Expo Android bridge rejects null values in Map<String, Any> — omit optional nullish fields. */
export function warmUpCameraParamsForNative(
  params: WarmUpCameraParams,
): Record<string, string | number | boolean> {
  const payload: Record<string, string | number | boolean> = {
    size: normalizePhotoSizeTier(params.size),
    mode: params.mode ?? "photo",
  }
  const requestId = nonBlankString(params.requestId)
  if (requestId != null) {
    payload.requestId = requestId
  }
  const exposureTimeNs = params.exposureTimeNs
  if (exposureTimeNs != null && Number.isFinite(exposureTimeNs) && exposureTimeNs > 0) {
    payload.exposureTimeNs = exposureTimeNs
  }
  const durationMs = params.durationMs
  if (durationMs != null && Number.isFinite(durationMs) && durationMs > 0) {
    payload.durationMs = Math.round(durationMs)
  }
  if (params.mfnr != null) {
    payload.mfnr = params.mfnr
  }
  if (params.zsl != null) {
    payload.zsl = params.zsl
  }
  return payload
}
