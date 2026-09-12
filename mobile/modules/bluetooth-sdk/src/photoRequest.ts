import type {PhotoDestination, PhotoRequestParams, PhotoTransferMethod} from "./BluetoothSdk.types"
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

function resolveDestination(params: PhotoRequestParams): PhotoDestination {
  if (params.destination != null) {
    const mixed = DESTINATION_LEGACY_FIELDS.filter((field) => params[field] != null)
    if (mixed.length > 0) {
      throw new TypeError(
        `requestPhoto: destination cannot be combined with the deprecated flat field(s) ${mixed.join(", ")}. ` +
          "Move them into the destination object.",
      )
    }
    if (params.destination.kind === "webhook" && !params.destination.url?.trim()) {
      // An empty webhook would reach the glasses as "no delivery target" and silently
      // turn into an archival (glasses-only) capture.
      throw new TypeError('requestPhoto: destination {kind: "webhook"} requires a non-empty url.')
    }
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

/**
 * Four octets of a numeric IPv4 host, accepting every form the platform network
 * stacks (inet_aton) accept — not just dotted quads: 1 to 4 components, each
 * decimal, `0x` hex or leading-zero octal, with the last component filling the
 * remaining bytes (`127.1` → 127.0.0.1, `2130706433` → 127.0.0.1,
 * `169.254.1` → 169.254.0.1). Undefined for anything that is not numeric.
 */
function parseIPv4(host: string): number[] | undefined {
  const parts = host.split(".")
  if (parts.length < 1 || parts.length > 4) return undefined
  const values: number[] = []
  for (const part of parts) {
    let value: number
    if (/^0x[0-9a-f]+$/i.test(part)) value = parseInt(part.slice(2), 16)
    else if (/^0[0-7]+$/.test(part)) value = parseInt(part, 8)
    else if (/^\d+$/.test(part)) value = Number(part)
    else return undefined
    values.push(value)
  }
  const last = values[values.length - 1]
  const lastBytes = 5 - values.length // the final component spans the remaining bytes
  if (values.slice(0, -1).some((value) => value > 255) || last >= 2 ** (8 * lastBytes)) return undefined
  const octets = values.slice(0, -1)
  for (let shift = lastBytes - 1; shift >= 0; shift--) octets.push((last >>> (8 * shift)) & 0xff)
  return octets
}

/** Eight 16-bit groups of an IPv6 literal (zone id and embedded IPv4 handled), or undefined. */
function parseIPv6(host: string): number[] | undefined {
  let text = host.toLowerCase()
  const zone = text.indexOf("%")
  if (zone !== -1) text = text.slice(0, zone)
  if (text.includes(".")) {
    const lastColon = text.lastIndexOf(":")
    const embedded = parseIPv4(text.slice(lastColon + 1))
    if (!embedded) return undefined
    text = `${text.slice(0, lastColon + 1)}${((embedded[0] << 8) | embedded[1]).toString(16)}:${(
      (embedded[2] << 8) |
      embedded[3]
    ).toString(16)}`
  }
  const halves = text.split("::")
  if (halves.length > 2) return undefined
  const toGroups = (part: string): number[] | undefined => {
    if (part === "") return []
    const groups = part.split(":").map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN))
    return groups.some((group) => Number.isNaN(group)) ? undefined : groups
  }
  const head = toGroups(halves[0])
  const tail = halves.length === 2 ? toGroups(halves[1]) : []
  if (!head || !tail) return undefined
  const missing = 8 - head.length - tail.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined
  return [...head, ...new Array<number>(missing).fill(0), ...tail]
}

/**
 * Hosts only the phone itself can reach: `localhost`, IPv4 loopback (127/8) and
 * link-local (169.254/16), IPv6 loopback (::1) and link-local (fe80::/10), and
 * IPv4-mapped forms of the IPv4 ranges. Compared as addresses, not spellings.
 * The glasses can never deliver directly to any of these; only the phone-side
 * BLE relay can.
 */
function isPhoneOnlyHost(host: string): boolean {
  if (host === "localhost") return true
  const isPhoneOnlyIPv4 = (octets: number[]): boolean => octets[0] === 127 || (octets[0] === 169 && octets[1] === 254)
  const v4 = parseIPv4(host)
  if (v4) return isPhoneOnlyIPv4(v4)
  const v6 = parseIPv6(host)
  if (!v6) return false
  if (v6.slice(0, 7).every((group) => group === 0) && v6[7] === 1) return true // ::1
  if ((v6[0] & 0xffc0) === 0xfe80) return true // fe80::/10
  if (v6.slice(0, 5).every((group) => group === 0) && v6[5] === 0xffff) {
    // ::ffff:a.b.c.d
    return isPhoneOnlyIPv4([v6[6] >> 8, v6[6] & 0xff, v6[7] >> 8, v6[7] & 0xff])
  }
  return false
}

/**
 * Validates a public {@link PhotoRequestParams} shape (a destination arm XOR
 * the deprecated flat delivery fields) and flattens it to the
 * {@link NativePhotoRequest} dict the native bridge understands.
 */
export function normalizePhotoRequestParams(params: PhotoRequestParams): NativePhotoRequest {
  const destination = resolveDestination(params)

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
    webhookUrl: _webhookUrl,
    authToken: _authToken,
    transferMethod: _transferMethod,
    save: _save,
    compress: _compress,
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

  return {
    ...photoRequestParamsForNative(flat),
    destinationKind: destination.kind,
    saveToCameraRoll: destination.kind === "phone" && destination.saveToCameraRoll === true,
  } as NativePhotoRequest
}
