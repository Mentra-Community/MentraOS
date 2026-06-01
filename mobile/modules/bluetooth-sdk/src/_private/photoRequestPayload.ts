import type {PhotoRequestParams} from "../BluetoothSdk.types"

/** Expo Android bridge rejects null values in Map<String, Any> — omit optional nullish fields. */
export function photoRequestParamsForNative(
  params: PhotoRequestParams,
): Record<string, string | number | boolean> {
  const payload: Record<string, string | number | boolean> = {
    requestId: params.requestId,
    appId: params.appId,
    size: params.size,
    webhookUrl: params.webhookUrl ?? "",
    compress: params.compress,
    flash: true,
    sound: params.sound,
    includeImu: params.includeImu ?? false,
  }
  if (params.authToken != null && params.authToken.length > 0) {
    payload.authToken = params.authToken
  }
  if (params.exposureTimeNs != null && Number.isFinite(params.exposureTimeNs) && params.exposureTimeNs > 0) {
    payload.exposureTimeNs = params.exposureTimeNs
  }
  return payload
}
