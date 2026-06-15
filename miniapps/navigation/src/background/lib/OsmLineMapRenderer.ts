/**
 * OsmLineMapRenderer — PoC: draw the bare road network around a point as a
 * two-tone line map for the glasses.
 *
 * Pipeline: Overpass (live, DEV ONLY) → highway ways as lat/lng polylines →
 * equirectangular projection to pixels → thick Bresenham raster into an 8-bit
 * buffer → encodeBmpBase64. Mirrors MinimapRenderer's Raster/projection so the
 * two can converge later.
 *
 * ⚠️ Uses the public Overpass API directly — fine for a dev proof-of-concept,
 * NOT for production (OSM fair-use). See issues/barebones-osm-line-map.md for
 * the real offline-extract pipeline.
 */

import {encodeBmpBase64} from "./bmp"
import type {LatLng} from "./geometry"

const BLACK = 0 // background
const ROAD = 255 // road centerline (white-hot)

/** Equirectangular projection to local meters, origin-centered. */
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
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.buf = new Uint8Array(w * h)
    this.buf.fill(BLACK)
  }
  private set(x: number, y: number, v: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    this.buf[y * this.w + x] = v
  }
  private disc(cx: number, cy: number, r: number, v: number): void {
    if (r <= 0) {
      this.set(cx, cy, v)
      return
    }
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
}

export type OsmLineMapOptions = {
  center: LatLng
  width: number
  height: number
  /** Half-extent of the view in meters (visible area is ~2× this per axis). */
  viewRadiusMeters?: number
  lineWidthPx?: number
  /** Anti-aliasing: render at this multiple of the target size, then average down. Default 3. */
  supersample?: number
}

/**
 * Fetch highway geometry around `center` from Overpass (DEV ONLY) and return it
 * as lat/lng polylines. One polyline per OSM way.
 */
export async function fetchOsmRoads(
  center: LatLng,
  viewRadiusMeters: number,
): Promise<LatLng[][]> {
  // Keep only real drivable road classes — NOT footways/sidewalks/paths/
  // cycleways/service lanes, which OSM stores as separate parallel ways and
  // would draw as a mess of extra lines next to each street. This whitelist
  // gives one centerline per street. `out geom` returns inline node geometry.
  const ROAD_CLASSES =
    "motorway|trunk|primary|secondary|tertiary|unclassified|residential|" +
    "living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link"
  const query =
    `[out:json][timeout:25];` +
    `way["highway"~"^(${ROAD_CLASSES})$"](around:${viewRadiusMeters},${center.lat},${center.lng});` +
    `out geom;`

  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      // Overpass rejects requests with no/blank UA (HTTP 406). Identify the app.
      "User-Agent": "MentraOS-Navigation-PoC/0.1 (OSM line map dev test)",
    },
    body: `data=${encodeURIComponent(query)}`,
  })
  if (!res.ok) {
    throw new Error(`Overpass HTTP ${res.status}`)
  }
  const json = (await res.json()) as {
    elements?: Array<{type: string; geometry?: Array<{lat: number; lon: number}>}>
  }

  const polylines: LatLng[][] = []
  for (const el of json.elements ?? []) {
    if (el.type !== "way" || !el.geometry) continue
    const pts = el.geometry.map((g) => ({lat: g.lat, lng: g.lon}))
    if (pts.length >= 2) polylines.push(pts)
  }
  return polylines
}

/**
 * Rasterize road polylines into a base64 grayscale BMP centered on `center`.
 * Pure function — no network. North-up, aspect-ratio preserved, Y flipped.
 */
export function renderOsmLineMap(roads: LatLng[][], opts: OsmLineMapOptions): string {
  const {center, width, height} = opts
  const viewRadius = opts.viewRadiusMeters ?? 400
  const lineWidth = opts.lineWidthPx ?? 1
  // Supersample: draw at SS× resolution with hard pixels, then box-average down
  // to the target size. The averaging turns staircased diagonal edges into gray
  // pixels (anti-aliasing) — and the G2 keeps 16 gray levels, so the smoothing
  // survives instead of being thresholded back to jaggies.
  const ss = Math.max(1, Math.round(opts.supersample ?? 3))

  const hiW = width * ss
  const hiH = height * ss
  const raster = new Raster(hiW, hiH)

  // meters → pixels at the hi-res scale; fit 2×viewRadius into the smaller axis
  // so aspect ratio is preserved (no stretching).
  const pxPerMeter = Math.min(hiW, hiH) / (viewRadius * 2)
  const cx = hiW / 2
  const cy = hiH / 2

  const project = (p: LatLng): {x: number; y: number} => {
    const m = toLocalMeters(p, center)
    return {
      x: cx + m.x * pxPerMeter,
      y: cy - m.y * pxPerMeter, // Y flipped: north is up
    }
  }

  for (const way of roads) {
    for (let i = 0; i < way.length - 1; i++) {
      const a = project(way[i]!)
      const b = project(way[i + 1]!)
      raster.line(a.x, a.y, b.x, b.y, ROAD, lineWidth * ss)
    }
  }

  // Box-downsample hi-res → target: each output pixel is the average of its
  // ss×ss source block, producing smooth grayscale edges.
  const out = new Uint8Array(width * height)
  if (ss === 1) {
    out.set(raster.buf)
  } else {
    const area = ss * ss
    for (let oy = 0; oy < height; oy++) {
      for (let ox = 0; ox < width; ox++) {
        let sum = 0
        for (let sy = 0; sy < ss; sy++) {
          const row = (oy * ss + sy) * hiW + ox * ss
          for (let sx = 0; sx < ss; sx++) sum += raster.buf[row + sx]!
        }
        out[oy * width + ox] = Math.round(sum / area)
      }
    }
  }

  return encodeBmpBase64(out, width, height)
}

/** Convenience: fetch + render in one call. */
export async function buildOsmLineMap(opts: OsmLineMapOptions): Promise<string> {
  const viewRadius = opts.viewRadiusMeters ?? 400
  const roads = await fetchOsmRoads(opts.center, viewRadius)
  console.log(`[OSM-MAP] fetched ${roads.length} road ways around ${opts.center.lat},${opts.center.lng}`)
  return renderOsmLineMap(roads, opts)
}
