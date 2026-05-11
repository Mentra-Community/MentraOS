/**
 * @fileoverview Private geometry helpers for the pivot engine.
 *
 * Lifted (with light edits) from the Navigation miniapp's
 * `src/client/lib/geometry/{geometry,pivots}.ts`. Lives inside the
 * SDK now so the public `navigation.getPivots()` / `onPivot()` APIs
 * are fully self-contained — no consumer has to ship its own
 * polyline-simplification + pivot-extraction code.
 *
 * Not exported from the SDK barrel. Internal only.
 */

import type {LatLng} from "../navigation"

export type PivotDirection = "left" | "right"

/** Raw pivot returned by `extractPivots` — pre-enrichment, geometry only. */
export type RawPivot = {
  lat: number
  lng: number
  direction: PivotDirection
  /** Index of this point in the *simplified* polyline (post-RDP). */
  simplifiedRouteIndex: number
  /** Approximate index in the ORIGINAL polyline (pre-RDP). Best-effort lookup. */
  rawRouteIndex: number
  /** Signed heading delta in degrees: +right, -left. */
  headingDelta: number
}

const TURN_THRESHOLD_DEG = 25
const SAME_DIR_MERGE_M = 25
const RDP_EPSILON_M = 5
const MIN_BEND_PER_POINT_DEG = 10
const STRAIGHT_SEGMENT_BREAK_M = 1

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

/**
 * Ramer-Douglas-Peucker polyline simplification. Returns indices into
 * the ORIGINAL `points` array that survive the pass.
 */
function rdpSimplify(points: LatLng[], epsilonMeters: number): number[] {
  if (points.length < 3) return points.map((_, i) => i)

  const keep = new Array(points.length).fill(false)
  keep[0] = true
  keep[points.length - 1] = true

  const stack: Array<[number, number]> = [[0, points.length - 1]]
  while (stack.length) {
    const [lo, hi] = stack.pop()!
    let maxDist = 0
    let maxIdx = -1
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistMeters(points[i], points[lo], points[hi])
      if (d > maxDist) {
        maxDist = d
        maxIdx = i
      }
    }
    if (maxIdx !== -1 && maxDist > epsilonMeters) {
      keep[maxIdx] = true
      stack.push([lo, maxIdx], [maxIdx, hi])
    }
  }

  const out: number[] = []
  for (let i = 0; i < keep.length; i++) if (keep[i]) out.push(i)
  return out
}

/** Perpendicular distance from `p` to the infinite line a–b, in meters. */
function perpDistMeters(p: LatLng, a: LatLng, b: LatLng): number {
  const mPerDegLat = 111_320
  const mPerDegLng = 111_320 * Math.cos((a.lat * Math.PI) / 180)
  const bx = (b.lng - a.lng) * mPerDegLng
  const by = (b.lat - a.lat) * mPerDegLat
  const px = (p.lng - a.lng) * mPerDegLng
  const py = (p.lat - a.lat) * mPerDegLat
  const dx = bx
  const dy = by
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len === 0) return Math.sqrt(px * px + py * py)
  return Math.abs(dx * -py - -px * dy) / len
}

/**
 * Extract raw turn pivots from a polyline. Returns a sparse list of
 * meaningful turns — STRAIGHT segments, polyline noise, and tiny
 * wobbles are filtered out.
 *
 * Algorithm:
 *   1. RDP-simplify with epsilon = 5m
 *   2. Accumulate consecutive same-direction bends into runs
 *   3. Emit one pivot per run whose summed heading delta clears 25°
 *   4. Merge same-direction pivots within 25m of each other
 */
export function extractPivots(rawPoints: LatLng[]): RawPivot[] {
  if (rawPoints.length < 3) return []

  const keptIdx = rdpSimplify(rawPoints, RDP_EPSILON_M)
  const simplified: LatLng[] = keptIdx.map((i) => rawPoints[i])
  if (simplified.length < 3) return []

  // Per-point signed deltas
  const deltas: number[] = []
  for (let i = 1; i < simplified.length - 1; i++) {
    const inBearing = bearingDeg(simplified[i - 1], simplified[i])
    const outBearing = bearingDeg(simplified[i], simplified[i + 1])
    deltas.push(signedAngleDiff(outBearing, inBearing))
  }

  const candidates: RawPivot[] = []
  let runStart = -1
  let runSum = 0
  let runSign = 0
  const flushRun = (endExclusive: number) => {
    if (runStart === -1) return
    if (Math.abs(runSum) >= TURN_THRESHOLD_DEG) {
      let bestIdx = runStart
      let bestAbs = 0
      for (let k = runStart; k < endExclusive; k++) {
        const a = Math.abs(deltas[k])
        if (a > bestAbs) {
          bestAbs = a
          bestIdx = k
        }
      }
      const simplifiedIdx = bestIdx + 1
      candidates.push({
        lat: simplified[simplifiedIdx].lat,
        lng: simplified[simplifiedIdx].lng,
        direction: runSum > 0 ? "right" : "left",
        simplifiedRouteIndex: simplifiedIdx,
        rawRouteIndex: keptIdx[simplifiedIdx],
        headingDelta: runSum,
      })
    }
    runStart = -1
    runSum = 0
    runSign = 0
  }

  let metersSinceLastBend = 0
  for (let k = 0; k < deltas.length; k++) {
    const d = deltas[k]
    const sign = d > 0 ? 1 : d < 0 ? -1 : 0
    const segLen = haversineMeters(simplified[k + 1], simplified[k + 2])

    if (sign === 0 || Math.abs(d) < MIN_BEND_PER_POINT_DEG) {
      if (runStart !== -1) {
        if (sign === runSign || sign === 0) runSum += d
        metersSinceLastBend += segLen
        if (metersSinceLastBend >= STRAIGHT_SEGMENT_BREAK_M) {
          flushRun(k + 1)
        }
      }
      continue
    }

    if (runStart === -1) {
      runStart = k
      runSum = d
      runSign = sign
      metersSinceLastBend = segLen
    } else if (sign === runSign) {
      if (metersSinceLastBend >= STRAIGHT_SEGMENT_BREAK_M) {
        flushRun(k)
        runStart = k
        runSum = d
        runSign = sign
      } else {
        runSum += d
      }
      metersSinceLastBend = segLen
    } else {
      flushRun(k)
      runStart = k
      runSum = d
      runSign = sign
      metersSinceLastBend = segLen
    }
  }
  flushRun(deltas.length)

  // Merge same-direction pivots that are close together.
  const merged: RawPivot[] = []
  for (const p of candidates) {
    const last = merged[merged.length - 1]
    if (
      last &&
      last.direction === p.direction &&
      haversineMeters({lat: last.lat, lng: last.lng}, {lat: p.lat, lng: p.lng}) < SAME_DIR_MERGE_M
    ) {
      if (Math.abs(p.headingDelta) > Math.abs(last.headingDelta)) {
        merged[merged.length - 1] = p
      }
      continue
    }
    merged.push(p)
  }

  return merged
}

/**
 * Cumulative haversine distance along a polyline from index 0 to
 * each point. Returned array is the same length as `points` —
 * `cumulative[i]` is meters from start to `points[i]`.
 */
export function cumulativeDistances(points: LatLng[]): number[] {
  const out: number[] = new Array(points.length)
  out[0] = 0
  for (let i = 1; i < points.length; i++) {
    out[i] = out[i - 1] + haversineMeters(points[i - 1], points[i])
  }
  return out
}
