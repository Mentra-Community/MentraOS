/**
 * Ramer-Douglas-Peucker polyline simplification for visual rendering.
 *
 * The pivot-detection variant of RDP moved into `@mentra/miniapp`'s
 * internal geometry helpers when pivot tracking was lifted into the
 * SDK. This file is the small leftover that NavMap uses to smooth
 * the visible route polyline before drawing it on the map — pure
 * presentation, no semantics.
 */

import type {LatLng} from "./geometry"

/**
 * Return a simplified copy of `points` for rendering. Drops vertices
 * whose perpendicular distance to the line through their neighbors
 * is below `epsilonMeters`. Default 6m — slightly looser than the
 * pivot extractor's 5m because the map only needs visual fidelity.
 */
export function rdpSmooth(points: LatLng[], epsilonMeters: number = 6): LatLng[] {
  if (points.length < 3) return points.slice()
  const kept = rdpSimplify(points, epsilonMeters)
  return kept.map((i) => points[i])
}

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

function perpDistMeters(p: LatLng, a: LatLng, b: LatLng): number {
  const mPerDegLat = 111_320
  const mPerDegLng = 111_320 * Math.cos((a.lat * Math.PI) / 180)
  const bx = (b.lng - a.lng) * mPerDegLng
  const by = (b.lat - a.lat) * mPerDegLat
  const px = (p.lng - a.lng) * mPerDegLng
  const py = (p.lat - a.lat) * mPerDegLat
  const len = Math.sqrt(bx * bx + by * by)
  if (len === 0) return Math.sqrt(px * px + py * py)
  return Math.abs(bx * -py - -px * by) / len
}
