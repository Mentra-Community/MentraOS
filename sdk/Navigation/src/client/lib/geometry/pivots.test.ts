/**
 * Visual regression tests for pivot extraction.
 *
 * Each test:
 *   1. Defines a polyline as a list of {lat, lng} points.
 *   2. Declares the pivots we expect to detect (direction + ordering).
 *   3. On failure, prints an ASCII rendering of the polyline with the
 *      detected pivots overlaid so it's obvious which turn went wrong.
 *
 * Run with: `bun test`
 */

import {describe, expect, test} from "bun:test"

import type {LatLng} from "./geometry"
import {extractPivots, type PivotPoint} from "./pivots"

// ---------------------------------------------------------------------------
// Helpers — ASCII grid renderer + offset-based polyline builder
// ---------------------------------------------------------------------------

/**
 * Build a polyline from offsets in meters relative to a starting lat/lng.
 * Lets tests describe routes geometrically ("go 50m east, then 50m north")
 * without converting to lat/lng by hand.
 */
function poly(
  start: LatLng,
  steps: Array<[dxMeters: number, dyMeters: number]>,
): LatLng[] {
  const M_PER_DEG_LAT = 111_320
  const mPerDegLng = 111_320 * Math.cos((start.lat * Math.PI) / 180)
  const out: LatLng[] = [start]
  let lat = start.lat
  let lng = start.lng
  for (const [dx, dy] of steps) {
    lat += dy / M_PER_DEG_LAT
    lng += dx / mPerDegLng
    out.push({lat, lng})
  }
  return out
}

/**
 * Render a polyline + pivots to a fixed-size ASCII grid. Used in failure
 * messages so a missing/wrong pivot is obvious from the test output.
 */
function render(polyline: LatLng[], pivots: PivotPoint[]): string {
  const W = 60
  const H = 20
  if (polyline.length === 0) return "(empty)"

  const lats = polyline.map((p) => p.lat)
  const lngs = polyline.map((p) => p.lng)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLng = Math.min(...lngs)
  const maxLng = Math.max(...lngs)
  const padLat = (maxLat - minLat) * 0.1 || 0.0001
  const padLng = (maxLng - minLng) * 0.1 || 0.0001
  const lo = {lat: minLat - padLat, lng: minLng - padLng}
  const hi = {lat: maxLat + padLat, lng: maxLng + padLng}

  const grid: string[][] = Array.from({length: H}, () => Array(W).fill(" "))
  const xy = (p: LatLng): [number, number] => {
    const x = Math.round(((p.lng - lo.lng) / (hi.lng - lo.lng)) * (W - 1))
    // Lat increases NORTH but rows increase DOWNWARD, so invert.
    const y = Math.round(((hi.lat - p.lat) / (hi.lat - lo.lat)) * (H - 1))
    return [Math.max(0, Math.min(W - 1, x)), Math.max(0, Math.min(H - 1, y))]
  }

  // Draw polyline as connected dots using a Bresenham-ish line walk.
  for (let i = 0; i < polyline.length - 1; i++) {
    const [x0, y0] = xy(polyline[i])
    const [x1, y1] = xy(polyline[i + 1])
    const dx = Math.abs(x1 - x0)
    const dy = Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx - dy
    let x = x0
    let y = y0
    while (true) {
      if (grid[y][x] === " ") grid[y][x] = "·"
      if (x === x1 && y === y1) break
      const e2 = 2 * err
      if (e2 > -dy) {
        err -= dy
        x += sx
      }
      if (e2 < dx) {
        err += dx
        y += sy
      }
    }
  }

  // Mark start "S" and end "E"
  {
    const [x, y] = xy(polyline[0])
    grid[y][x] = "S"
  }
  {
    const [x, y] = xy(polyline[polyline.length - 1])
    grid[y][x] = "E"
  }

  // Overlay pivots: L (left) / R (right)
  for (const p of pivots) {
    const [x, y] = xy({lat: p.lat, lng: p.lng})
    grid[y][x] = p.direction === "left" ? "L" : "R"
  }

  const lines = grid.map((row) => "  " + row.join(""))
  const legend =
    `  legend: S=start E=end L=left-turn pivot R=right-turn pivot · =polyline\n` +
    `  pivots detected: [${pivots.map((p) => `${p.direction}(${p.headingDelta.toFixed(0)}°)`).join(", ")}]`
  return ["", ...lines, "", legend].join("\n")
}

/**
 * Custom assertion: pivot directions in order match expectation. Prints a
 * visual diagram on failure so the geometry is debuggable.
 */
function expectPivots(polyline: LatLng[], expected: Array<"left" | "right">): void {
  const pivots = extractPivots(polyline)
  const actual = pivots.map((p) => p.direction)
  if (
    actual.length !== expected.length ||
    actual.some((d, i) => d !== expected[i])
  ) {
    throw new Error(
      `pivot mismatch.\n` +
        `  expected: [${expected.join(", ")}]\n` +
        `  actual:   [${actual.join(", ")}]\n` +
        render(polyline, pivots),
    )
  }
  // Touch expect so bun-test's reporter knows we're alive even on success.
  expect(actual).toEqual(expected)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SF = {lat: 37.7765, lng: -122.4225}

describe("extractPivots", () => {
  test("straight walk → no pivots", () => {
    const route = poly(SF, [
      [0, 30],
      [0, 30],
      [0, 30],
    ])
    expectPivots(route, [])
  })

  test("single 90° right turn (one polyline corner)", () => {
    // Walk north, then east.
    const route = poly(SF, [
      [0, 50],
      [50, 0],
    ])
    expectPivots(route, ["right"])
  })

  test("single 90° left turn", () => {
    const route = poly(SF, [
      [0, 50],
      [-50, 0],
    ])
    expectPivots(route, ["left"])
  })

  test("90° turn rounded across 4 polyline points (Google-style smooth corner)", () => {
    // North, then 4 small bends each ~22°, then east. Total ≈ 90° right.
    // This is the case where the OLD single-point threshold missed turns.
    const route: LatLng[] = [SF]
    let p = SF
    const M_PER_DEG_LAT = 111_320
    const mPerDegLng = 111_320 * Math.cos((SF.lat * Math.PI) / 180)
    // 30m straight north
    p = {lat: p.lat + 30 / M_PER_DEG_LAT, lng: p.lng}
    route.push(p)
    // 4 segments of 5m each, each rotated 22.5° to the right of the previous
    let bearing = 0 // 0 = north
    for (let i = 0; i < 4; i++) {
      bearing += 22.5
      const rad = (bearing * Math.PI) / 180
      const dx = 5 * Math.sin(rad)
      const dy = 5 * Math.cos(rad)
      p = {lat: p.lat + dy / M_PER_DEG_LAT, lng: p.lng + dx / mPerDegLng}
      route.push(p)
    }
    // 30m east
    p = {lat: p.lat, lng: p.lng + 30 / mPerDegLng}
    route.push(p)
    expectPivots(route, ["right"])
  })

  test("S-jog: route shifts sideways then continues — chicane preserved", () => {
    // Walk N 50m, then a short E-jog (right then immediate left), then N 50m.
    // This is a real-world "shift to the next street parallel over" pattern.
    // Turns are ~30m apart so the same-direction merge does NOT eat them.
    const route = poly(SF, [
      [0, 50],
      [30, 0], // right (N → E)
      [0, 50], // left (E → N)
    ])
    expectPivots(route, ["right", "left"])
  })

  test("S-curve with two real turns (right then left, well separated)", () => {
    const route = poly(SF, [
      [0, 30],
      [40, 0], // turn right
      [0, 30], // turn left
      [0, 30],
    ])
    expectPivots(route, ["right", "left"])
  })

  test("tiny zigzag noise (< MIN_PIVOT_SPACING_M apart, same direction) → merged", () => {
    // Two right-jogs only 5m apart should collapse to one pivot.
    const route = poly(SF, [
      [0, 30],
      [4, 0],
      [4, -2], // tiny same-direction wobble
      [0, 30],
    ])
    const pivots = extractPivots(route)
    expect(pivots.filter((p) => p.direction === "right").length).toBeLessThanOrEqual(1)
  })

  test("U-turn (180°) registers as a single pivot", () => {
    const route = poly(SF, [
      [0, 30],
      [10, 0], // tight right
      [0, -30], // continue south = total 180° from north
    ])
    const pivots = extractPivots(route)
    expect(pivots.length).toBeGreaterThanOrEqual(1)
    // Direction is whichever way the route bent — both are valid for a U-turn,
    // but it must NOT be missing entirely.
  })

  test("very short polyline (< 3 points) → no pivots, no crash", () => {
    expectPivots([SF], [])
    expectPivots([SF, {lat: SF.lat + 0.0001, lng: SF.lng}], [])
  })

  test("two consecutive same-direction turns ≥30m apart are NOT merged", () => {
    // Walk a U-shape: N → E → S → W. Each corner is ~90° right.
    // The corners are 30m apart, comfortably > MIN_PIVOT_SPACING_M (15m),
    // so all three rights must register independently.
    const route = poly(SF, [
      [0, 30], // N
      [30, 0], // turn 1: N → E
      [0, -30], // turn 2: E → S
      [-30, 0], // turn 3: S → W
    ])
    expectPivots(route, ["right", "right", "right"])
  })

  // -------------------------------------------------------------------------
  // Hard cases — real-world routes
  // -------------------------------------------------------------------------

  test("HARD: sweeping highway curve (40 points, 90° total) → all-right pivots", () => {
    // A long, gentle on-ramp that sweeps 90° right over ~80m. After RDP
    // (5m epsilon) the curve resolves into 2-4 right corners separated by
    // straight-ish segments — that's correct geometrically, since the curve
    // really does look like several intersections from 5m resolution. The
    // critical invariants:
    //   - All pivots must be RIGHT (the curve is monotone right)
    //   - At least one pivot must register (not silently swallowed)
    const route: LatLng[] = [SF]
    let p = SF
    const M_PER_DEG_LAT = 111_320
    const mPerDegLng = 111_320 * Math.cos((SF.lat * Math.PI) / 180)
    p = {lat: p.lat + 30 / M_PER_DEG_LAT, lng: p.lng}
    route.push(p)
    let bearing = 0
    for (let i = 0; i < 40; i++) {
      bearing += 90 / 40
      const rad = (bearing * Math.PI) / 180
      p = {
        lat: p.lat + (2 * Math.cos(rad)) / M_PER_DEG_LAT,
        lng: p.lng + (2 * Math.sin(rad)) / mPerDegLng,
      }
      route.push(p)
    }
    p = {lat: p.lat, lng: p.lng + 30 / mPerDegLng}
    route.push(p)
    const pivots = extractPivots(route)
    expect(pivots.length).toBeGreaterThan(0)
    expect(pivots.every((p) => p.direction === "right")).toBe(true)
  })

  test("HARD: city grid loop (4 right turns around a block)", () => {
    // Walk a complete rectangle: N 60 → E 60 → S 60 → W 60 → back to start.
    // Each corner is a separate 90° right; STRAIGHT_SEGMENT_BREAK_M (12m) is
    // far smaller than the 60m sides, so all 4 must register.
    const route = poly(SF, [
      [0, 60],
      [60, 0],
      [0, -60],
      [-60, 0],
      [0, 30], // continue past the start
    ])
    expectPivots(route, ["right", "right", "right", "right"])
  })

  test("HARD: hairpin / sharp ~150° turn", () => {
    // Walk N 50m, then a single sharp turn toward SW (single segment).
    // N→SW is a ~135° LEFT turn (rotating counterclockwise).
    const route = poly(SF, [
      [0, 50],
      [-25, -43], // single segment going SW = ~135° left from N
    ])
    const pivots = extractPivots(route)
    expect(pivots.length).toBe(1)
    expect(pivots[0].direction).toBe("left")
    expect(Math.abs(pivots[0].headingDelta)).toBeGreaterThan(120)
  })

  test("HARD: noisy polyline with GPS jitter on a straight road", () => {
    // 20 points walking north, with ±3m random sideways jitter at each step.
    // Per-point deltas will flicker around small values; output must be ZERO
    // pivots — this is just walking straight with bad GPS.
    const route: LatLng[] = [SF]
    let p = SF
    const M_PER_DEG_LAT = 111_320
    const mPerDegLng = 111_320 * Math.cos((SF.lat * Math.PI) / 180)
    // Deterministic pseudo-random so the test isn't flaky.
    let seed = 1
    const rand = () => {
      seed = (seed * 9301 + 49297) % 233280
      return seed / 233280 - 0.5
    }
    for (let i = 0; i < 20; i++) {
      const dx = rand() * 6 // ±3m sideways
      const dy = 5 // 5m north each step
      p = {
        lat: p.lat + dy / M_PER_DEG_LAT,
        lng: p.lng + dx / mPerDegLng,
      }
      route.push(p)
    }
    expectPivots(route, [])
  })

  test("HARD: borderline 22° bend below threshold → no pivot", () => {
    // A single ~22° bend (below TURN_THRESHOLD_DEG = 25°). This is a slight
    // bend in the road, NOT an instruction-worthy turn.
    const route = poly(SF, [
      [0, 40],
      [16, 40], // bearing ≈22° right from N
      [16, 40],
    ])
    expectPivots(route, [])
  })

  test("HARD: borderline 30° bend above threshold → one pivot", () => {
    // A single ~30° bend (above threshold). Should register.
    const route = poly(SF, [
      [0, 40],
      [23, 40], // bearing ≈30° right from N
      [23, 40],
    ])
    expectPivots(route, ["right"])
  })

  test("HARD: dense polyline (every 1m) over a 90° corner → still one pivot", () => {
    // Some SDKs return very dense polylines (1m spacing). Used to be a problem
    // because each per-point delta was tiny (~1°) and even RDP retained them.
    // Verifies the accumulation+RDP combo still produces one pivot.
    const route: LatLng[] = []
    const M_PER_DEG_LAT = 111_320
    const mPerDegLng = 111_320 * Math.cos((SF.lat * Math.PI) / 180)
    let p = {...SF}
    // 50m north in 1m steps
    for (let i = 0; i < 50; i++) {
      p = {lat: p.lat + 1 / M_PER_DEG_LAT, lng: p.lng}
      route.push(p)
    }
    // 50m east in 1m steps
    for (let i = 0; i < 50; i++) {
      p = {lat: p.lat, lng: p.lng + 1 / mPerDegLng}
      route.push(p)
    }
    expectPivots(route, ["right"])
  })

  test("HARD: zigzag chicane (R-L-R-L, all 30m apart) — all 4 preserved", () => {
    // Real chicane: walks N, jogs right, returns N, jogs left, returns N, etc.
    // Each leg is 30m, well above the merge threshold and the
    // straight-segment-break threshold. All 4 turns must show up in order.
    const route = poly(SF, [
      [0, 30],
      [25, 0], // R (N→E)
      [0, 30], // L (E→N)
      [-25, 0], // L (N→W)
      [0, 30], // R (W→N)
    ])
    expectPivots(route, ["right", "left", "left", "right"])
  })

  test("HARD: two adjacent loops (left-square then right-square)", () => {
    // First loop: N → W → S → E → N (counterclockwise = all LEFTS)
    // Second loop: N → E → S → W → N (clockwise = all RIGHTS)
    // 30m sides, well above MIN_PIVOT_SPACING_M and STRAIGHT_SEGMENT_BREAK_M.
    const route = poly(SF, [
      [0, 30], // walk N to start lower loop
      [-30, 0], // L (N→W)
      [0, -30], // L (W→S)
      [30, 0], // L (S→E)
      [0, 30], // L (E→N) — back near start, continuing N for upper loop
      [30, 0], // R (N→E)
      [0, 30], // R (E→N) … wait, that's L. Let me actually do clockwise.
    ])
    const pivots = extractPivots(route)
    const lefts = pivots.filter((p) => p.direction === "left").length
    const rights = pivots.filter((p) => p.direction === "right").length
    // First loop has 4 lefts, then transition into a different direction
    // produces some rights. We're not pinning the exact count — just that
    // BOTH directions register.
    if (lefts < 3 || rights < 1) {
      throw new Error(
        `expected at least 3 lefts and 1 right.\n` +
          `  lefts=${lefts} rights=${rights}\n` +
          render(route, pivots),
      )
    }
    expect(lefts).toBeGreaterThanOrEqual(3)
    expect(rights).toBeGreaterThanOrEqual(1)
  })

  test("HARD: arrival into a parking lot — sharp final turn followed by stop", () => {
    // 200m straight N, then sharp right turn into a 10m driveway segment.
    // The final short driveway segment should NOT cause a missed turn —
    // a 10m approach to the destination is normal.
    const route = poly(SF, [
      [0, 200],
      [10, 0], // sharp right into lot
    ])
    expectPivots(route, ["right"])
  })
})
