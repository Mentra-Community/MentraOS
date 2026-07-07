/**
 * Pure decoders used by `NavigationService.computeRoute` when talking to
 * Mapbox's Directions API directly (no native dependency).
 *
 * Kept in their own module so unit tests don't have to bring up the
 * `crust` native module to exercise them. The algorithms are unit
 * testable; the surrounding service is not.
 *
 * Migrated from Google Routes API: Mapbox returns numeric `distance`
 * (meters) / `duration` (seconds) rather than Google's `"123s"` protobuf
 * strings, and `polyline6` (precision-6) geometry rather than Google's
 * precision-5 encoded polyline. `parseDurationSeconds` is retained for
 * back-compat but Mapbox callers pass the numeric value through directly.
 */

export type LatLng = {lat: number; lng: number}

/**
 * Back-compat: Google Routes API encoded durations as protobuf strings
 * ("123s"). Mapbox returns a number, so new callers should not need this.
 * Accepts a number (passed through) or a "123s" string.
 */
export function parseDurationSeconds(s: string | number): number {
  if (typeof s === "number") return Number.isFinite(s) ? Math.round(s) : 0
  const match = s.match(/^(\d+)/)
  return match ? Number(match[1]) : 0
}

/**
 * Decode an encoded polyline. The standard Google/Mapbox polyline
 * algorithm, parameterized by coordinate precision:
 *   - precision 5 (Google Routes, Mapbox `polyline`): factor 1e5
 *   - precision 6 (Mapbox `polyline6`): factor 1e6
 *
 * We request `geometries=polyline6` from Mapbox Directions for the extra
 * precision (tighter road-centerline tracing keeps the turn-pivot dots on
 * the visible road), so the default precision here is 6.
 *
 * Reference: https://docs.mapbox.com/api/navigation/directions/#route-object
 */
export function decodePolyline(encoded: string, precision: number = 6): LatLng[] {
  if (!encoded) return []
  const factor = Math.pow(10, precision)
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
    points.push({lat: lat / factor, lng: lng / factor})
  }
  return points
}
