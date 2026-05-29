/**
 * MinimapRenderer — rasterizes a small heading-up minimap into a PNG
 * for the glasses HUD. Pure JS (no DOM/canvas): we draw into a raw RGB
 * pixel buffer and hand it to the PNG encoder.
 *
 * Heading-up: the user sits at the center as an upward-pointing arrow,
 * and the world is rotated by -heading so whatever direction the user
 * faces is "up". The route polyline is drawn relative to the user.
 *
 * Pure black & white only — the phone converts the bitmap to the
 * glasses' 1-bit format by thresholding, so anti-aliased grays would
 * quantize unpredictably.
 */

import {encodePngBase64} from "./png"
import type {LatLng} from "./geometry"

export type MinimapInput = {
  coords: LatLng | null
  heading: number | null // degrees, 0 = North
  routePoints: LatLng[] | null
  upcomingPivot: LatLng | null
}

// How many meters from the user the minimap edge represents. The user
// is centered, so the visible square is ~2 * VIEW_RADIUS_M on a side.
const VIEW_RADIUS_M = 80

const BLACK = 0
const WHITE = 255

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
    this.buf = new Uint8Array(size * size * 3)
    this.buf.fill(WHITE)
  }

  set(x: number, y: number, v: number): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return
    const i = (y * this.size + x) * 3
    this.buf[i] = v
    this.buf[i + 1] = v
    this.buf[i + 2] = v
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

/**
 * Render the minimap. Returns a base64 PNG, or null when there's no
 * position fix yet (nothing meaningful to draw).
 */
export function renderMinimap(input: MinimapInput, size = 100): string | null {
  const {coords, heading, routePoints, upcomingPivot} = input
  if (!coords) return null

  const r = new Raster(size)
  const center = (size - 1) / 2
  const metersPerPx = VIEW_RADIUS_M / center

  // Heading-up: rotate local (east, north) by -heading so the facing
  // direction maps to screen-up. Screen y grows downward, so north maps
  // to -y. With heading h (clockwise from north):
  //   screenX =  east*cos(h) - north*sin(h)
  //   screenY = -(east*sin(h) + north*cos(h))   ... but for heading-up we
  // rotate the world by -h. Combined, the device-forward axis points up.
  const h = ((heading ?? 0) * Math.PI) / 180
  const sinH = Math.sin(h)
  const cosH = Math.cos(h)

  const project = (p: LatLng): {x: number; y: number} => {
    const m = toLocalMeters(p, coords)
    // Rotate so heading points up. Forward (along heading) -> screen up.
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

  // Route polyline.
  if (routePoints && routePoints.length >= 2) {
    let prev = project(routePoints[0])
    for (let i = 1; i < routePoints.length; i++) {
      const cur = project(routePoints[i])
      r.line(prev.x, prev.y, cur.x, cur.y, BLACK, 3)
      prev = cur
    }
  }

  // Upcoming-turn marker (filled square).
  if (upcomingPivot) {
    const p = project(upcomingPivot)
    r.disc(Math.round(p.x), Math.round(p.y), 3, BLACK)
  }

  // User arrow at center, pointing up (heading-up frame).
  const ax = center
  const ay = center - 9 // tip
  const bx = center - 6
  const by = center + 7 // bottom-left
  const cx = center + 6
  const cy = center + 7 // bottom-right
  r.triangle(ax, ay, bx, by, cx, cy, BLACK)

  return encodePngBase64(r.buf, size, size)
}
