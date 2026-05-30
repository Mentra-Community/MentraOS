/**
 * Pure decoders used by `NavigationService.computeRoute` when talking to
 * Google's Routes API directly (no native dependency).
 *
 * Kept in their own module so unit tests don't have to bring up the
 * `crust` native module to exercise them. The algorithms are unit
 * testable; the surrounding service is not.
 */

export type LatLng = {lat: number; lng: number}

/** Routes API encodes durations as protobuf strings ("123s"). */
export function parseDurationSeconds(s: string): number {
  const match = s.match(/^(\d+)/)
  return match ? Number(match[1]) : 0
}

/**
 * Decode a Google encoded polyline. Identical algorithm to
 * google.maps.geometry.encoding.decodePath but available here in the
 * non-WebView phone process where window.google is undefined.
 *
 * Reference: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
export function decodePolyline(encoded: string): LatLng[] {
  if (!encoded) return []
  const points: LatLng[] = []
  let index = 0
  let lat = 0
  let lng = 0
  while (index < encoded.length) {
    let result = 0
    let shift = 0
    let b: number
    do {
      b = encoded.charCodeAt(index++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    lat += result & 1 ? ~(result >> 1) : result >> 1
    result = 0
    shift = 0
    do {
      b = encoded.charCodeAt(index++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    lng += result & 1 ? ~(result >> 1) : result >> 1
    points.push({lat: lat / 1e5, lng: lng / 1e5})
  }
  return points
}
