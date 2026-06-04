/**
 * Lightweight geo helpers used by the map and orientation logic.
 * Small-angle approximations are fine for the segment lengths we deal
 * with (10s–100s of meters within a single trip).
 */

export type LatLng = {lat: number; lng: number}

/** Great-circle distance in meters (haversine). */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const x =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * R * Math.asin(Math.sqrt(x))
}

/** Compass bearing from `a` to `b`, in degrees [0, 360). */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const toDeg = (r: number) => (r * 180) / Math.PI
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const dLng = toRad(b.lng - a.lng)
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

/** Smallest signed difference: target - actual, in [-180, 180]. */
export function signedAngleDiff(target: number, actual: number): number {
  return ((target - actual + 540) % 360) - 180
}

/** Eight-point cardinal name from a degree heading. */
export function cardinal(deg: number): string {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8
  return names[idx]
}

/**
 * Approximate perpendicular distance from `p` to segment `a→b`, in meters.
 * Good enough for picking the closest segment of a polyline.
 */
export function perpDistanceMeters(p: LatLng, a: LatLng, b: LatLng): number {
  const mPerDegLat = 111_320
  const mPerDegLng = 111_320 * Math.cos((a.lat * Math.PI) / 180)
  const ax = 0
  const ay = 0
  const bx = (b.lng - a.lng) * mPerDegLng
  const by = (b.lat - a.lat) * mPerDegLat
  const px = (p.lng - a.lng) * mPerDegLng
  const py = (p.lat - a.lat) * mPerDegLat
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.sqrt(px * px + py * py)
  let t = (px * dx + py * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const projx = ax + t * dx
  const projy = ay + t * dy
  return Math.sqrt((px - projx) * (px - projx) + (py - projy) * (py - projy))
}

/**
 * Bearing of the route at the user's current position. We find the
 * polyline segment closest to `me` and return its endpoint bearing —
 * i.e. which way the route wants you to face right now.
 */
export function nextSegmentBearing(me: LatLng | null, route: LatLng[] | null): number | null {
  if (!me || !route || route.length < 2) return null
  let bestIdx = 0
  let bestDist = Infinity
  for (let i = 0; i < route.length - 1; i++) {
    const d = perpDistanceMeters(me, route[i], route[i + 1])
    if (d < bestDist) {
      bestDist = d
      bestIdx = i
    }
  }
  return bearingDeg(route[bestIdx], route[bestIdx + 1])
}

export type Crossing = {
  /** Start of the crossing leg (curb on the user's current sidewalk). */
  start: LatLng
  /** End of the crossing leg (curb on the other sidewalk). */
  end: LatLng
}

/**
 * Detect crossing micro-steps in a route polyline. A "crossing" is a
 * short polyline leg (<maxLegMeters) that turns sharply (>minBendDeg)
 * away from the previous leg and then turns sharply back to roughly
 * the original direction on the leg after — characteristic of a
 * crosswalk where the planned route briefly leaves the sidewalk to
 * traverse the road, then resumes along the opposite curb.
 *
 * Heuristic-based; tweakable via `maxLegMeters` and `minBendDeg`.
 * Mirrors the same algorithm as the Android NavigationManager's
 * stripCrossings() so the dev-panel visualization and the simulator
 * walker agree on what counts as a crossing.
 */
export function detectCrossings(
  points: LatLng[],
  opts: {maxLegMeters?: number; minBendDeg?: number; minSidewalkSwitchMeters?: number} = {},
): Crossing[] {
  const maxLeg = opts.maxLegMeters ?? 25
  const minBend = opts.minBendDeg ?? 60
  // Reject pass-through crosswalk traces at intersections where the
  // user stays on the same sidewalk. A real sidewalk-switch leaves the
  // post-crossing polyline ≥4m perpendicular from the pre-crossing line.
  const minSwitch = opts.minSidewalkSwitchMeters ?? 4
  const sampleMeters = 10
  const out: Crossing[] = []
  if (points.length < 4) return out
  for (let i = 1; i < points.length - 2; i++) {
    const prev = points[i - 1]
    const here = points[i]
    const next = points[i + 1]
    const afterNext = points[i + 2]
    const legOut = haversineMeters(here, next)
    if (legOut >= maxLeg) continue
    const bearIn = bearingDeg(prev, here)
    const bearOut = bearingDeg(here, next)
    const bend = Math.abs(((bearIn - bearOut + 540) % 360) - 180)
    if (bend <= minBend) continue
    const bearAfter = bearingDeg(next, afterNext)
    const bendBack = Math.abs(((bearOut - bearAfter + 540) % 360) - 180)
    const inOutDelta = Math.abs(((bearIn - bearAfter + 540) % 360) - 180)
    if (!(bendBack > minBend && inOutDelta < minBend)) continue
    const sample = walkAlongPolyline(points, i + 1, sampleMeters)
    if (!sample) continue
    const displacement = perpDistanceMeters(sample, prev, here)
    if (displacement < minSwitch) continue
    out.push({start: here, end: next})
  }
  return out
}

function walkAlongPolyline(points: LatLng[], startIdx: number, meters: number): LatLng | null {
  if (startIdx >= points.length - 1) return null
  let remaining = meters
  let idx = startIdx
  while (idx < points.length - 1) {
    const a = points[idx]
    const b = points[idx + 1]
    const segLen = haversineMeters(a, b)
    if (remaining <= segLen) {
      const t = segLen > 0 ? remaining / segLen : 0
      return {lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t}
    }
    remaining -= segLen
    idx++
  }
  return null
}
