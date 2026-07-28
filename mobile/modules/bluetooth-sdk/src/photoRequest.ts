import type {PhotoDestination, PhotoExposure, PhotoRequestParams, PhotoTransferMethod} from "./BluetoothSdk.types"
import {photoRequestParamsForNative} from "./_private/photoRequestPayload"

/**
 * Flat dict handed to the native `requestPhoto` implementation. Same shape as
 * the legacy payload plus the destination fields; nullish values are omitted
 * (Expo Android bridge rejects null in Map<String, Any>), with "no webhook"
 * encoded as an empty `webhookUrl` and an absent `authToken`.
 */
export type NativePhotoRequest = Record<string, string | number | boolean> & {
  destinationKind: PhotoDestination["kind"]
  saveToCameraRoll: boolean
  save: boolean
  transferMethod: PhotoTransferMethod
  webhookUrl: string
}

const DESTINATION_LEGACY_FIELDS = ["webhookUrl", "authToken", "transferMethod", "save", "compress"] as const
const EXPOSURE_LEGACY_FIELDS = ["exposureTimeNs", "iso", "aeExposureDivisor", "isoCap", "zsl", "mfnr"] as const

function assertNoLegacyFields(
  params: PhotoRequestParams,
  fields: readonly (keyof PhotoRequestParams)[],
  unionName: "destination" | "exposure",
): void {
  const mixed = fields.filter((field) => params[field] != null)
  if (mixed.length > 0) {
    throw new TypeError(
      `requestPhoto: ${unionName} cannot be combined with the deprecated flat field(s) ${mixed.join(", ")}. ` +
        `Move them into the ${unionName} object.`,
    )
  }
}

function resolveDestination(params: PhotoRequestParams): PhotoDestination {
  if (params.destination != null) {
    assertNoLegacyFields(params, DESTINATION_LEGACY_FIELDS, "destination")
    return params.destination
  }
  const url = params.webhookUrl?.trim()
  if (url) {
    return {
      kind: "webhook",
      url,
      authToken: params.authToken ?? undefined,
      transferMethod: params.transferMethod,
      keepOnGlasses: !!params.save,
      compress: params.compress,
    }
  }
  if (params.save) {
    return {kind: "glasses"}
  }
  throw new TypeError(
    'requestPhoto: no destination. Pass destination: {kind: "webhook" | "phone" | "glasses"} ' +
      "(or the deprecated webhookUrl / save fields).",
  )
}

function resolveExposure(params: PhotoRequestParams): PhotoExposure {
  if (params.exposure != null) {
    assertNoLegacyFields(params, EXPOSURE_LEGACY_FIELDS, "exposure")
    return params.exposure
  }
  if (params.exposureTimeNs != null) {
    return {kind: "manual", timeNs: params.exposureTimeNs, iso: params.iso ?? undefined}
  }
  if (params.aeExposureDivisor != null || params.isoCap != null) {
    return {kind: "scan", aeExposureDivisor: params.aeExposureDivisor, isoCap: params.isoCap}
  }
  return {kind: "auto", zsl: params.zsl, mfnr: params.mfnr}
}

/** Host part of an absolute URL; avoids the incomplete React Native URL implementation. */
function webhookHost(url: string): string | undefined {
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/.exec(url.trim())
  if (!match) {
    return undefined
  }
  const hostPort = match[1].slice(match[1].lastIndexOf("@") + 1)
  if (hostPort.startsWith("[")) {
    const end = hostPort.indexOf("]")
    return end === -1 ? undefined : hostPort.slice(1, end).toLowerCase()
  }
  const colon = hostPort.indexOf(":")
  return (colon === -1 ? hostPort : hostPort.slice(0, colon)).toLowerCase()
}

function isPhoneOnlyHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host.startsWith("169.254.")
}

/**
 * Validates a public {@link PhotoRequestParams} shape (union arms XOR the
 * deprecated flat fields) and flattens it to the {@link NativePhotoRequest}
 * dict the native bridge understands.
 */
export function normalizePhotoRequestParams(params: PhotoRequestParams): NativePhotoRequest {
  const destination = resolveDestination(params)
  const exposure = resolveExposure(params)

  if (destination.kind === "webhook" && destination.transferMethod === "direct") {
    const host = webhookHost(destination.url)
    if (host != null && isPhoneOnlyHost(host)) {
      throw new TypeError(
        `requestPhoto: webhook host "${host}" is only reachable from this phone, so ` +
          'transferMethod "direct" can never deliver there. Use "auto" or "ble".',
      )
    }
  }

  const {
    destination: _destination,
    exposure: _exposure,
    webhookUrl: _webhookUrl,
    authToken: _authToken,
    transferMethod: _transferMethod,
    save: _save,
    compress: _compress,
    exposureTimeNs: _exposureTimeNs,
    iso: _iso,
    aeExposureDivisor: _aeExposureDivisor,
    isoCap: _isoCap,
    zsl: _zsl,
    mfnr: _mfnr,
    ...captureFields
  } = params
  const flat: PhotoRequestParams = {...captureFields}

  switch (destination.kind) {
    case "webhook":
      flat.webhookUrl = destination.url
      flat.authToken = destination.authToken ?? null
      flat.transferMethod = destination.transferMethod
      flat.save = destination.keepOnGlasses ?? false
      flat.compress = destination.compress
      break
    case "phone":
      flat.transferMethod = "ble"
      flat.save = destination.keepOnGlasses ?? false
      break
    case "glasses":
      flat.transferMethod = "auto"
      flat.save = true
      break
  }

  switch (exposure.kind) {
    case "manual":
      flat.exposureTimeNs = exposure.timeNs
      flat.iso = exposure.iso
      break
    case "scan":
      flat.aeExposureDivisor = exposure.aeExposureDivisor
      flat.isoCap = exposure.isoCap
      break
    case "auto":
      flat.zsl = exposure.zsl
      flat.mfnr = exposure.mfnr
      break
  }

  return {
    ...photoRequestParamsForNative(flat),
    destinationKind: destination.kind,
    saveToCameraRoll: destination.kind === "phone" && destination.saveToCameraRoll === true,
  } as NativePhotoRequest
}
