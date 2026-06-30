import type {WarmUpCameraParams} from "../BluetoothSdk.types"
import {normalizePhotoSizeTier} from "./photoRequestPayload"
import {generatedCameraRequestId, nonBlankRequestId} from "./requestIds"

/** Expo Android bridge rejects null values in Map<String, Any> — omit optional nullish fields. */
export function warmUpCameraParamsForNative(
  params: WarmUpCameraParams,
): Record<string, string | number> {
  const payload: Record<string, string | number> = {
    requestId: nonBlankRequestId(params.requestId) ?? generatedCameraRequestId("warm"),
    size: normalizePhotoSizeTier(params.size),
  }
  const exposureTimeNs = params.exposureTimeNs
  if (exposureTimeNs != null && Number.isFinite(exposureTimeNs) && exposureTimeNs > 0) {
    payload.exposureTimeNs = exposureTimeNs
  }
  const durationMs = params.durationMs
  if (durationMs != null && Number.isFinite(durationMs) && durationMs > 0) {
    payload.durationMs = Math.round(durationMs)
  }
  return payload
}
