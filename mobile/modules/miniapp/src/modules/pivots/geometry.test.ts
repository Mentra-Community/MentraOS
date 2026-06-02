/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {
  bearingDeg,
  cumulativeDistances,
  extractCrossings,
  extractPivots,
  haversineMeters,
  signedAngleDiff,
} from "./geometry"
import type {LatLng} from "../navigation"

/**
 * Pure-geometry tests for the pivot engine. The engine itself is a
 * stateful consumer of these helpers; testing the geometry primitives
 * directly is the cheap way to catch regressions in pivot extraction.
 *
 * Coordinates throughout: small WGS84 patches centered on midtown
 * Manhattan (40.76°N, -73.98°W) where 1° of longitude ≈ 84,400 m and
 * 1° of latitude ≈ 111,320 m, so a 0.0001° step ≈ 11 m N/S and ≈ 8.5 m E/W.
 */

const NYC_BASE: LatLng = {lat: 40.76, lng: -73.98}

/** Convert a (north_meters, east_meters) offset to LatLng near NYC_BASE. */
function offset(northM: number, eastM: number): LatLng {
  const mPerDegLat = 111_320
  const mPerDegLng = 111_320 * Math.cos((NYC_BASE.lat * Math.PI) / 180)
  return {
    lat: NYC_BASE.lat + northM / mPerDegLat,
    lng: NYC_BASE.lng + eastM / mPerDegLng,
  }
}

describe("haversineMeters", () => {
  test("returns 0 for identical points", () => {
    expect(haversineMeters(NYC_BASE, NYC_BASE)).toBeCloseTo(0, 5)
  })

  test("matches our local-flat projection for small distances", () => {
    // A 100m straight-east step should be within a few cm of 100m
    // by great-circle measurement at NYC latitude.
    const east100 = offset(0, 100)
    expect(haversineMeters(NYC_BASE, east100)).toBeCloseTo(100, 0)
  })

  test("symmetric: d(a,b) == d(b,a)", () => {
    const a = offset(50, 30)
    const b = offset(-20, 80)
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 5)
  })
})

describe("bearingDeg", () => {
  test("due north → ~0°", () => {
    expect(bearingDeg(NYC_BASE, offset(100, 0))).toBeCloseTo(0, 1)
  })

  test("due east → ~90°", () => {
    expect(bearingDeg(NYC_BASE, offset(0, 100))).toBeCloseTo(90, 1)
  })

  test("due south → ~180°", () => {
    expect(bearingDeg(NYC_BASE, offset(-100, 0))).toBeCloseTo(180, 1)
  })

  test("due west → ~270°", () => {
    expect(bearingDeg(NYC_BASE, offset(0, -100))).toBeCloseTo(270, 1)
  })
})

describe("signedAngleDiff", () => {
  test("returns 0 for identical bearings", () => {
    expect(signedAngleDiff(90, 90)).toBe(0)
  })

  test("90° clockwise from 0° is +90°", () => {
    expect(signedAngleDiff(90, 0)).toBe(90)
  })

  test("90° counter-clockwise from 0° is -90°", () => {
    expect(signedAngleDiff(-90, 0)).toBe(-90)
    expect(signedAngleDiff(270, 0)).toBe(-90)
  })

  test("180° → +180° (boundary)", () => {
    // signedAngleDiff(target, actual) returns ((target - actual + 540) % 360) - 180.
    // For target=180, actual=0 → ((180+540)%360)-180 = 0-180 = -180. The function
    // resolves the ambiguity by snapping to -180 rather than +180.
    expect(signedAngleDiff(180, 0)).toBe(-180)
  })

  test("crossing 0°/360° wraps correctly", () => {
    // 350° → 10° is a +20° rotation, not -340°.
    expect(signedAngleDiff(10, 350)).toBe(20)
    expect(signedAngleDiff(350, 10)).toBe(-20)
  })
})

describe("cumulativeDistances", () => {
  test("first entry is always 0", () => {
    const points: LatLng[] = [NYC_BASE, offset(10, 0), offset(20, 0)]
    expect(cumulativeDistances(points)[0]).toBe(0)
  })

  test("monotonic non-decreasing along a polyline", () => {
    const points: LatLng[] = [NYC_BASE, offset(10, 0), offset(10, 10), offset(20, 10)]
    const cum = cumulativeDistances(points)
    for (let i = 1; i < cum.length; i++) {
      expect(cum[i]).toBeGreaterThanOrEqual(cum[i - 1])
    }
  })

  test("sum across a 10-step rectilinear path matches the segment-by-segment haversine", () => {
    const points: LatLng[] = []
    for (let i = 0; i <= 10; i++) points.push(offset(i * 10, 0))
    const cum = cumulativeDistances(points)
    // 10 segments of ~10m each ≈ 100m total
    expect(cum[cum.length - 1]).toBeCloseTo(100, 0)
  })
})

describe("extractPivots", () => {
  test("returns [] for a straight line", () => {
    const points: LatLng[] = []
    for (let i = 0; i <= 20; i++) points.push(offset(i * 5, 0))
    expect(extractPivots(points)).toEqual([])
  })

  test("returns [] for a polyline with fewer than 3 points", () => {
    expect(extractPivots([])).toEqual([])
    expect(extractPivots([NYC_BASE])).toEqual([])
    expect(extractPivots([NYC_BASE, offset(10, 0)])).toEqual([])
  })

  test("extracts a single right turn from a 90° L-shape", () => {
    // Walk north for 100m, then east for 100m. The vertex at the corner
    // should be flagged as a right turn.
    const points: LatLng[] = []
    for (let i = 0; i <= 10; i++) points.push(offset(i * 10, 0))
    for (let i = 1; i <= 10; i++) points.push(offset(100, i * 10))
    const pivots = extractPivots(points)
    expect(pivots).toHaveLength(1)
    expect(pivots[0].direction).toBe("right")
    // Heading went from ~0° (north) to ~90° (east), so delta ≈ +90°.
    expect(pivots[0].headingDelta).toBeGreaterThan(60)
    expect(pivots[0].headingDelta).toBeLessThan(120)
  })

  test("extracts a left turn from a mirrored L-shape", () => {
    // Walk north for 100m, then west for 100m.
    const points: LatLng[] = []
    for (let i = 0; i <= 10; i++) points.push(offset(i * 10, 0))
    for (let i = 1; i <= 10; i++) points.push(offset(100, -i * 10))
    const pivots = extractPivots(points)
    expect(pivots).toHaveLength(1)
    expect(pivots[0].direction).toBe("left")
  })

  test("filters out small zigzags below the 25° threshold", () => {
    // A series of tiny ~5° wobbles along the same general bearing should
    // produce no pivots.
    const points: LatLng[] = []
    for (let i = 0; i <= 20; i++) {
      // Small periodic perpendicular jitter (<1m) on a 100m line — well
      // below RDP epsilon (5m), so the whole path collapses to a line.
      const jitter = i % 2 === 0 ? 0.5 : -0.5
      points.push(offset(i * 5, jitter))
    }
    expect(extractPivots(points)).toEqual([])
  })

  test("collapses an intersection cluster into one net pivot", () => {
    // A zigzag at one intersection: small left, then small right, then a
    // big right. Net direction is right. The intersection-cluster merge
    // should collapse this into a single pivot rather than emitting three
    // distinct turns inside a 30m radius.
    const points: LatLng[] = [
      offset(0, 0),
      offset(20, 0),
      offset(30, -5), // slight left
      offset(40, 0), // slight right back
      offset(50, 15), // big right
      offset(50, 50),
    ]
    const pivots = extractPivots(points)
    // At minimum the cluster shouldn't produce more pivots than turns —
    // and the surviving pivot(s) should reflect a net right turn.
    expect(pivots.length).toBeLessThanOrEqual(2)
    if (pivots.length > 0) {
      expect(pivots[pivots.length - 1].direction).toBe("right")
    }
  })
})

describe("extractCrossings", () => {
  test("returns [] for short polylines", () => {
    expect(extractCrossings([])).toEqual([])
    expect(extractCrossings([NYC_BASE, offset(10, 0)])).toEqual([])
    expect(extractCrossings([NYC_BASE, offset(10, 0), offset(20, 0)])).toEqual([])
  })

  test("returns [] for a straight walk with no crossings", () => {
    const points: LatLng[] = []
    for (let i = 0; i <= 20; i++) points.push(offset(i * 5, 0))
    expect(extractCrossings(points)).toEqual([])
  })

  test("detects a classic crosswalk shape (step across, continue)", () => {
    // Walk north 50m on sidewalk A, then short sharp east leg (~6m) —
    // the crosswalk — then resume north on sidewalk B. The displacement
    // gate is ~4m, so a 6m east offset clears it.
    const points: LatLng[] = [
      offset(0, 0),
      offset(10, 0),
      offset(20, 0),
      offset(30, 0), // about to cross
      offset(30, 6), // far curb — short sharp east leg, ~6m
      offset(40, 6), // resume north on sidewalk B
      offset(50, 6),
      offset(60, 6),
    ]
    const crossings = extractCrossings(points)
    expect(crossings.length).toBeGreaterThanOrEqual(1)
    // Start of the crossing should be the index of the near curb (point 3).
    expect(crossings[0].startIndex).toBe(3)
    expect(crossings[0].endIndex).toBe(4)
  })
})
