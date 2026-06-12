import type {PhotoRequestParams} from "../BluetoothSdk.types"

/** Expo Android bridge rejects null values in Map<String, Any> — omit optional nullish fields. */
export function photoRequestParamsForNative(params: PhotoRequestParams): Record<string, string | number | boolean> {
  const payload: Record<string, string | number | boolean> = {
    requestId: params.requestId,
    appId: params.appId,
    size: params.size,
    webhookUrl: params.webhookUrl ?? "",
    compress: params.compress,
    flash: true,
    sound: params.sound,
  }
  if (params.authToken != null && params.authToken.length > 0) {
    payload.authToken = params.authToken
  }
  const exposureTimeNs = params.exposureTimeNs
  const hasManualExposure = exposureTimeNs != null && Number.isFinite(exposureTimeNs) && exposureTimeNs > 0
  if (hasManualExposure) {
    payload.exposureTimeNs = exposureTimeNs
  }
  if (hasManualExposure && params.iso != null && Number.isFinite(params.iso) && params.iso > 0) {
    payload.iso = Math.round(params.iso)
  }
  return payload
}
