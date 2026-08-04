import type {PhotoRequestParams, PhotoSize, PhotoTransferMethod} from "../BluetoothSdk.types"

const PHOTO_TRANSFER_METHODS = new Set<PhotoTransferMethod>(["auto", "direct", "ble"])

function photoTransferMethodForNative(value: unknown): PhotoTransferMethod {
  if (value === undefined) return "auto"
  if (typeof value === "string" && PHOTO_TRANSFER_METHODS.has(value as PhotoTransferMethod)) {
    return value as PhotoTransferMethod
  }
  throw new TypeError(`Invalid transferMethod ${JSON.stringify(value)}. Expected "auto", "direct", or "ble".`)
}

/** Maps unknown/legacy size strings to the current wire format. */
export function normalizePhotoSizeTier(size: string | undefined): PhotoSize {
  switch (size) {
    case "small":
      return "low"
    case "large":
      return "high"
    case "full":
      return "max"
    case "low":
    case "medium":
    case "high":
    case "max":
      return size
    default:
      return "medium"
  }
}

function nonBlankString(value?: string | null): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

/** Expo Android bridge rejects null values in Map<String, Any> — omit optional nullish fields. */
export function photoRequestParamsForNative(params: PhotoRequestParams): Record<string, string | number | boolean> {
  const payload: Record<string, string | number | boolean> = {
    size: normalizePhotoSizeTier(params.size),
    mode: params.mode ?? "photo",
    transferMethod: photoTransferMethodForNative(params.transferMethod),
    webhookUrl: params.webhookUrl ?? "",
    compress: params.compress,
    sound: params.sound,
  }
  const requestId = nonBlankString(params.requestId)
  if (requestId != null) {
    payload.requestId = requestId
  }
  if (params.save != null) {
    payload.save = params.save
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
  if (params.aeExposureDivisor != null && params.aeExposureDivisor > 1) {
    payload.aeExposureDivisor = Math.round(params.aeExposureDivisor)
  }
  if (params.isoCap != null && params.isoCap > 0) {
    payload.isoCap = Math.round(params.isoCap)
  }
  if (params.noiseReduction != null) {
    payload.noiseReduction = params.noiseReduction
  }
  if (params.edgeEnhancement != null) {
    payload.edgeEnhancement = params.edgeEnhancement
  }
  if (params.mfnr != null) {
    payload.mfnr = params.mfnr
  }
  if (params.zsl != null) {
    payload.zsl = params.zsl
  }
  if (params.ispDigitalGain != null) {
    payload.ispDigitalGain = Math.round(params.ispDigitalGain)
  }
  if (params.ispAnalogGain != null && params.ispAnalogGain.length > 0) {
    payload.ispAnalogGain = params.ispAnalogGain
  }
  return payload
}
