/**
 * Pivot point extraction for navigation.
 *
 * The Nav SDK's per-step maneuver stream is too noisy to drive the UI directly
 * (it flips LEFT↔RIGHT on the same physical turn under GPS jitter). Instead we
 * derive our own list of turn pivots from the route polyline once at trip
 * start, then drive the card off that fixed list + a radius check on every GPS
 * update.
 *
 * See issues/navigation-maneuver-card.md for the design rationale.
 */

import {bearingDeg, haversineMeters, signedAngleDiff, type LatLng} from "./geometry"

export type PivotDirection = "left" | "right"

export type PivotPoint = {
  lat: number
  lng: number
  /** Direction of the turn at this pivot. */
  direction: PivotDirection
  /** Index of this point in the simplified polyline (post-RDP). */
  routeIndex: number
  /** Signed heading delta in degrees: +right, -left. */
  headingDelta: number
}

const TURN_THRESHOLD_DEG = 25
const MIN_PIVOT_SPACING_M = 15
/**
 * RDP epsilon. Tuned for walking navigation in city grids. Larger values
 * collapse smooth highway curves into a sequence of fake corners — but for
 * pedestrian routing, real "turns" are always intersections, not curves.
 */
const RDP_EPSILON_M = 5
/** Per-point delta below which we ignore a single point but still accumulate it. */
const MIN_BEND_PER_POINT_DEG = 10
/**
 * If the polyline goes straight for this many meters between two same-direction
 * bends, treat them as TWO separate turns instead of accumulating into one.
 * Without this, three 90° rights forming a U around a block sum into one
 * "right 270°" pivot — but they're really three independent maneuvers.
 */
const STRAIGHT_SEGMENT_BREAK_M = 1

/**
 * Ramer-Douglas-Peucker polyline simplification.
 * Returns indices of points kept (in order). Removes points whose perpendicular
 * distance to the line drawn between its neighbors is below `epsilonMeters`.
 *
 * Implemented iteratively to avoid recursion blowups on long polylines.
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

/**
 * Perpendicular distance from `p` to the infinite line through `a` and `b`,
 * in meters. (RDP needs distance to the line, not the segment — slightly
 * different from `perpDistanceMeters` in geometry.ts which clamps to the
 * segment.)
 */
function perpDistMeters(p: LatLng, a: LatLng, b: LatLng): number {
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
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len === 0) return Math.sqrt(px * px + py * py)
  // Cross product magnitude / line length = perpendicular distance
  return Math.abs(dx * (ay - py) - (ax - px) * dy) / len
}

/**
 * Extract turn pivots from a route polyline.
 *
 * Pipeline:
 *   1. RDP-simplify to remove polyline noise (epsilon = 5m)
 *   2. At each interior point, compute signed heading delta between incoming
 *      and outgoing segment bearings
 *   3. Keep points with |delta| ≥ TURN_THRESHOLD_DEG
 *   4. Merge pivots within MIN_PIVOT_SPACING_M of each other (keep larger delta)
 */
export function extractPivots(rawPoints: LatLng[]): PivotPoint[] {
  if (rawPoints.length < 3) return []

  // Step 1 — RDP simplify
  const keptIdx = rdpSimplify(rawPoints, RDP_EPSILON_M)
  const simplified: LatLng[] = keptIdx.map((i) => rawPoints[i])
  if (simplified.length < 3) return []

  // Step 2 — compute per-point signed deltas
  const deltas: number[] = []
  for (let i = 1; i < simplified.length - 1; i++) {
    const inBearing = bearingDeg(simplified[i - 1], simplified[i])
    const outBearing = bearingDeg(simplified[i], simplified[i + 1])
    deltas.push(signedAngleDiff(outBearing, inBearing)) // +right, -left
  }

  // Step 3 — accumulate consecutive same-direction bends. A 90° corner that
  // Google's polyline rounds off across 4-5 points (e.g. 4 × 22°) is the
  // common case where a single-point threshold misses real turns. We collect
  // a run of points whose deltas all bend the same way (accounting for tiny
  // wobbles via MIN_BEND_PER_POINT_DEG) and emit one pivot per run if the
  // *summed* delta crosses TURN_THRESHOLD_DEG.
  const candidates: PivotPoint[] = []
  let runStart = -1
  let runSum = 0
  let runSign = 0 // +1 right, -1 left
  const flushRun = (endExclusive: number) => {
    if (runStart === -1) return
    if (Math.abs(runSum) >= TURN_THRESHOLD_DEG) {
      // Anchor the pivot at the point with the largest individual delta in
      // the run — that's the geometric "knee" of the corner.
      let bestIdx = runStart
      let bestAbs = 0
      for (let k = runStart; k < endExclusive; k++) {
        const a = Math.abs(deltas[k])
        if (a > bestAbs) {
          bestAbs = a
          bestIdx = k
        }
      }
      const polyIdx = bestIdx + 1 // deltas[k] corresponds to simplified[k+1]
      candidates.push({
        lat: simplified[polyIdx].lat,
        lng: simplified[polyIdx].lng,
        direction: runSum > 0 ? "right" : "left",
        routeIndex: polyIdx,
        headingDelta: runSum,
      })
    }
    runStart = -1
    runSum = 0
    runSign = 0
  }
  // Track distance walked since the last meaningful bend. If we've gone
  // ≥STRAIGHT_SEGMENT_BREAK_M between two same-direction bends, that's two
  // separate intersections, not one continuous curve.
  let metersSinceLastBend = 0
  for (let k = 0; k < deltas.length; k++) {
    const d = deltas[k]
    const sign = d > 0 ? 1 : d < 0 ? -1 : 0
    const segLen = haversineMeters(simplified[k + 1], simplified[k + 2])

    // Tiny wobble (≤MIN_BEND_PER_POINT_DEG) — part of a curve, not a bend.
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
      // Same direction. If the gap since the last bend was a long straight
      // stretch, this is a separate turn.
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
      // Direction reversed → flush, start new.
      flushRun(k)
      runStart = k
      runSum = d
      runSign = sign
      metersSinceLastBend = segLen
    }
  }
  flushRun(deltas.length)

  // Step 4 — merge SAME-DIRECTION pivots that are too close (zigzag noise).
  // Opposite-direction pivots within the spacing threshold are real chicanes
  // (e.g. right-then-immediately-left) and must be preserved.
  const merged: PivotPoint[] = []
  for (const p of candidates) {
    const last = merged[merged.length - 1]
    if (
      last &&
      last.direction === p.direction &&
      haversineMeters({lat: last.lat, lng: last.lng}, {lat: p.lat, lng: p.lng}) < MIN_PIVOT_SPACING_M
    ) {
      // Keep whichever has the larger heading delta
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
 * Public RDP wrapper for polyline rendering — returns the simplified
 * point list directly. Use a larger epsilon (default 6m) than the pivot
 * extractor for a visually smoother rendered route, since the map only
 * needs visual fidelity, not pivot-detection precision.
 */
export function rdpSmooth(points: LatLng[], epsilonMeters: number = 6): LatLng[] {
  if (points.length < 3) return points.slice()
  const kept = rdpSimplify(points, epsilonMeters)
  return kept.map((i) => points[i])
}

/**
 * Find the closest point in `polyline` to `position`, returning its index.
 * Used as a fallback when GPS doesn't enter the pivot radius — we can detect
 * "user has passed pivot N" by checking if their closest polyline index has
 * advanced past pivot N's `routeIndex`.
 */
export function closestPolylineIndex(position: LatLng, polyline: LatLng[]): number {
  let bestIdx = 0
  let bestDist = Infinity
  for (let i = 0; i < polyline.length; i++) {
    const d = haversineMeters(position, polyline[i])
    if (d < bestDist) {
      bestDist = d
      bestIdx = i
    }
  }
  return bestIdx
}
