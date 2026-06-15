/**
 * MinimapRenderer — rasterizes a small heading-up minimap into an 8-bit
 * grayscale BMP for the glasses HUD. Pure JS (no DOM/canvas): we draw into a
 * raw 1-byte-per-pixel buffer and hand it to the BMP encoder.
 *
 * We have no street/tile data in the background JSContext, so the minimap is
 * built entirely from what the trip already gives us — the user's position +
 * heading, the route polyline, and the upcoming turn. To make that read like
 * a map rather than a bare squiggle we add:
 *   - heading-up orientation (the device-forward axis always points up),
 *   - concentric distance rings (25 m / 50 m) for a sense of scale,
 *   - a rotating "N" tick so north is still findable,
 *   - the route split into traveled (dim) vs. remaining (bold),
 *   - crosswalk ticks where the route briefly leaves the sidewalk,
 *   - the upcoming-turn marker and the centered user arrow.
 *
 * Grays: the encoder is 8-bit, so we use a few levels — BOLD for the live
 * route/arrow, DIM for the traveled trail, FAINT for rings/north furniture.
 */

import {encodeBmpBase64} from "./bmp"
import {detectCrossings, haversineMeters, perpDistanceMeters, type LatLng} from "./geometry"

export type MinimapInput = {
  coords: LatLng | null
  heading: number | null // degrees, 0 = North
  routePoints: LatLng[] | null
  upcomingPivot: LatLng | null
}

// How many meters from the user the minimap edge represents. The user
// is centered, so the visible square is ~2 * VIEW_RADIUS_M on a side.
export const VIEW_RADIUS_M = 80

// Grayscale levels (0 = black background ... 255 = white-hot).
const WHITE = 0 // background
const FAINT = 90 // rings, north furniture
const DIM = 150 // already-traveled route
const BOLD = 255 // live route, arrow, markers

// Distance rings drawn for scale (meters from the user).
const RING_RADII_M = [25, 50]

/** Equirectangular projection to local meters, user at origin. */
function toLocalMeters(p: LatLng, origin: LatLng): {x: number; y: number} {
  const mPerDegLat = 111_320
  const mPerDegLng = 111_320 * Math.cos((origin.lat * Math.PI) / 180)
  return {
    x: (p.lng - origin.lng) * mPerDegLng, // east+
    y: (p.lat - origin.lat) * mPerDegLat, // north+
  }
}

class Raster {
  readonly buf: Uint8Array
  constructor(readonly size: number) {
    this.buf = new Uint8Array(size * size) // 8-bit grayscale, 1 byte/px
    this.buf.fill(WHITE)
  }

  set(x: number, y: number, v: number): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return
    this.buf[y * this.size + x] = v
  }

  /** Filled disc — used as a brush so lines/markers have thickness. */
  disc(cx: number, cy: number, r: number, v: number): void {
    const r2 = r * r
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r2) this.set(cx + dx, cy + dy, v)
      }
    }
  }

  /** Thick line via a disc brush stepped along the segment (Bresenham). */
  line(x0: number, y0: number, x1: number, y1: number, v: number, thickness: number): void {
    x0 = Math.round(x0)
    y0 = Math.round(y0)
    x1 = Math.round(x1)
    y1 = Math.round(y1)
    const r = Math.max(0, Math.floor(thickness / 2))
    const dx = Math.abs(x1 - x0)
    const dy = -Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    for (;;) {
      this.disc(x0, y0, r, v)
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 >= dy) {
        err += dy
        x0 += sx
      }
      if (e2 <= dx) {
        err += dx
        y0 += sy
      }
    }
  }

  /** 1px circle outline (midpoint algorithm) — used for the distance rings. */
  circle(cx: number, cy: number, r: number, v: number): void {
    if (r < 1) return
    let x = r
    let y = 0
    let err = 1 - r
    const plot8 = (px: number, py: number) => {
      this.set(cx + px, cy + py, v)
      this.set(cx - px, cy + py, v)
      this.set(cx + px, cy - py, v)
      this.set(cx - px, cy - py, v)
      this.set(cx + py, cy + px, v)
      this.set(cx - py, cy + px, v)
      this.set(cx + py, cy - px, v)
      this.set(cx - py, cy - px, v)
    }
    while (x >= y) {
      plot8(x, y)
      y++
      if (err < 0) {
        err += 2 * y + 1
      } else {
        x--
        err += 2 * (y - x) + 1
      }
    }
  }

  /** Filled triangle (scanline fill) — the user arrow. */
  triangle(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    v: number,
  ): void {
    const minY = Math.floor(Math.min(ay, by, cy))
    const maxY = Math.ceil(Math.max(ay, by, cy))
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
    if (area === 0) return
    for (let y = minY; y <= maxY; y++) {
      for (let x = Math.floor(Math.min(ax, bx, cx)); x <= Math.ceil(Math.max(ax, bx, cx)); x++) {
        // Barycentric inside-test.
        const w0 = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
        const w1 = (cx - bx) * (y - by) - (cy - by) * (x - bx)
        const w2 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx)
        if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) {
          this.set(x, y, v)
        }
      }
    }
  }
}

/** Index of the route segment whose perpendicular distance to `me` is least. */
function nearestSegmentIndex(me: LatLng, route: LatLng[]): number {
  let bestIdx = 0
  let bestDist = Infinity
  for (let i = 0; i < route.length - 1; i++) {
    const d = perpDistanceMeters(me, route[i], route[i + 1])
    if (d < bestDist) {
      bestDist = d
      bestIdx = i
    }
  }
  return bestIdx
}

/**
 * Render the minimap. Returns a base64 BMP, or null when there's no
 * position fix yet (nothing meaningful to draw).
 */
export function renderMinimap(input: MinimapInput, size = 100): string | null {
  const {coords, heading, routePoints, upcomingPivot} = input
  if (!coords) return null

  const r = new Raster(size)
  const center = (size - 1) / 2
  const metersPerPx = VIEW_RADIUS_M / center

  // Heading-up: rotate local (east, north) by -heading so the device-forward
  // axis maps to screen-up. Screen y grows downward, so forward maps to -y.
  const h = ((heading ?? 0) * Math.PI) / 180
  const sinH = Math.sin(h)
  const cosH = Math.cos(h)

  const project = (p: LatLng): {x: number; y: number} => {
    const m = toLocalMeters(p, coords)
    const east = m.x
    const north = m.y
    const rx = east * cosH - north * sinH
    const ry = east * sinH + north * cosH
    // rx = right of user, ry = forward of user. Map forward to up (-y).
    return {
      x: center + rx / metersPerPx,
      y: center - ry / metersPerPx,
    }
  }

  // Corner brackets instead of a full border — short dashes meeting at each
  // corner (drawn before the route so the route renders on top). Inset by 1px.
  const lo = 1
  const hi = size - 2
  const len = Math.max(4, Math.round(size * 0.18)) // dash length per arm
  r.line(lo, lo, lo + len, lo, FAINT, 2)
  r.line(lo, lo, lo, lo + len, FAINT, 2)
  r.line(hi, lo, hi - len, lo, FAINT, 2)
  r.line(hi, lo, hi, lo + len, FAINT, 2)
  r.line(lo, hi, lo + len, hi, FAINT, 2)
  r.line(lo, hi, lo, hi - len, FAINT, 2)
  r.line(hi, hi, hi - len, hi, FAINT, 2)
  r.line(hi, hi, hi, hi - len, FAINT, 2)

  // Route polyline, split into traveled (dim) and remaining (bold) at the
  // segment closest to the user, so the path ahead stands out.
  if (routePoints && routePoints.length >= 2) {
    const splitIdx = nearestSegmentIndex(coords, routePoints)
    let prev = project(routePoints[0]!)
    for (let i = 1; i < routePoints.length; i++) {
      const cur = project(routePoints[i]!)
      const traveled = i - 1 < splitIdx
      r.line(prev.x, prev.y, cur.x, cur.y, traveled ? DIM : BOLD, traveled ? 2 : 3)
      prev = cur
    }

    // Crosswalk ticks: small bold dots where the route crosses a road.
    for (const c of detectCrossings(routePoints)) {
      const mid = {lat: (c.start.lat + c.end.lat) / 2, lng: (c.start.lng + c.end.lng) / 2}
      const p = project(mid)
      r.disc(Math.round(p.x), Math.round(p.y), 1, BOLD)
    }
  }

  // Upcoming-turn marker (filled disc), only when it's within view.
  if (upcomingPivot && haversineMeters(coords, upcomingPivot) <= VIEW_RADIUS_M) {
    const p = project(upcomingPivot)
    r.disc(Math.round(p.x), Math.round(p.y), 3, BOLD)
  }

  // User arrow at center, pointing up (heading-up frame).
  const ax = center
  const ay = center - 9 // tip
  const bx = center - 6
  const by = center + 7 // bottom-left
  const cx = center + 6
  const cy = center + 7 // bottom-right
  r.triangle(ax, ay, bx, by, cx, cy, BOLD)

  return encodeBmpBase64(r.buf, size, size)
}
