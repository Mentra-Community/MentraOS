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
const ROAD = 77 // road centerline (70% dimmer ≈ 30% brightness, barely visible so the route dominates)
const ROUTE = 255 // active route overlay (white-hot)
const MARKER = 255 // heading arrow fill (white-hot, drawn on top of everything)
const MARKER_OUTLINE = 0 // heading arrow outline (black halo so it reads over the white route)
const BORDER = 255 // corner-bracket edge marks (white, indicate the bitmap bounds)

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
  /**
   * Hollow circle outline of radius `r` and `thickness` px, centered at
   * (cx, cy). Used for the destination marker on the route. A pixel is "on"
   * when its distance from center falls within [r - thickness, r].
   */
  ring(cx: number, cy: number, r: number, v: number, thickness: number): void {
    cx = Math.round(cx)
    cy = Math.round(cy)
    const rOuter = Math.max(1, Math.round(r))
    const rInner = Math.max(0, rOuter - Math.max(1, Math.round(thickness)))
    const o2 = rOuter * rOuter
    const i2 = rInner * rInner
    for (let dy = -rOuter; dy <= rOuter; dy++) {
      for (let dx = -rOuter; dx <= rOuter; dx++) {
        const d2 = dx * dx + dy * dy
        if (d2 <= o2 && d2 >= i2) this.set(cx + dx, cy + dy, v)
      }
    }
  }

  /** Filled triangle via barycentric coverage test (used for the heading arrow). */
  triangle(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    v: number,
  ): void {
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)))
    const maxX = Math.min(this.w - 1, Math.ceil(Math.max(ax, bx, cx)))
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)))
    const maxY = Math.min(this.h - 1, Math.ceil(Math.max(ay, by, cy)))
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
    if (area === 0) return // degenerate
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5
        const py = y + 0.5
        const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area
        const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area
        const w2 = 1 - w0 - w1
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) this.set(x, y, v)
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
  /** Active route polyline, drawn thicker on top of the road network. */
  route?: LatLng[] | null
  /** Width of the route overlay line (defaults to lineWidthPx + 2). */
  routeWidthPx?: number
  /**
   * Destination point — drawn as a small hollow circle at the end of the
   * route so the user can see where they're headed. Omit / null for none.
   */
  destination?: LatLng | null
  /**
   * "You are here" heading marker, drawn last (on top) as a filled arrow.
   * `at` is projected like any other point; `headingDeg` is a compass bearing
   * (0 = north/up, 90 = east/right) — pass the route's forward direction to
   * point the arrow the way the user should go next.
   */
  marker?: {at: LatLng; headingDeg: number} | null
  /** Arrow size in target pixels (tip-to-base length). Default 9. */
  markerSizePx?: number
  /**
   * Heading-up rotation. When set, the whole map is rotated so this compass
   * bearing (0 = north, 90 = east) points UP on the display — i.e. the map
   * faces the user's direction of travel. Pass the route's forward bearing to
   * keep "the way you're going" always at the top. When omitted/null the map
   * is drawn north-up (legacy behaviour). The heading marker is drawn pointing
   * straight up in this mode, since the rotation already aligns it with travel.
   */
  rotationDeg?: number | null
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

  // Heading-up rotation. Rotate the local-meter frame so the given compass
  // bearing points up. A bearing θ has world vector (sinθ, cosθ) in (east,
  // north); to bring it onto +north we rotate every point by −θ. cos/sin are
  // hoisted out of the per-point hot path. rot==null → identity (north-up).
  const rotDeg = opts.rotationDeg ?? null
  const rotRad = rotDeg != null ? (-rotDeg * Math.PI) / 180 : 0
  const rCos = Math.cos(rotRad)
  const rSin = Math.sin(rotRad)

  const project = (p: LatLng): {x: number; y: number} => {
    const m = toLocalMeters(p, center)
    // Rotate the (east, north) meter vector before projecting to pixels so the
    // chosen bearing ends up pointing up.
    const ex = m.x * rCos - m.y * rSin
    const ny = m.x * rSin + m.y * rCos
    return {
      x: cx + ex * pxPerMeter,
      y: cy - ny * pxPerMeter, // Y flipped: north(-of-rotated-frame) is up
    }
  }

  for (const way of roads) {
    for (let i = 0; i < way.length - 1; i++) {
      const a = project(way[i]!)
      const b = project(way[i + 1]!)
      raster.line(a.x, a.y, b.x, b.y, ROAD, lineWidth * ss)
    }
  }

  // Route overlay: drawn on top, thicker, so it stands out over the network.
  const route = opts.route
  if (route && route.length >= 2) {
    const routeWidth = opts.routeWidthPx ?? lineWidth + 2
    for (let i = 0; i < route.length - 1; i++) {
      const a = project(route[i]!)
      const b = project(route[i + 1]!)
      raster.line(a.x, a.y, b.x, b.y, ROUTE, routeWidth * ss)
    }
  }

  // Destination: a small hollow circle at the route's end so the user can see
  // where they're headed. Drawn after the route, before the heading marker.
  // Kept small + thin so it's "barely visible" — just enough to read as a
  // target without dominating the tiny minimap.
  const destination = opts.destination
  if (destination) {
    const d = project(destination)
    const ringR = 3.9 * ss // ~3.9px target radius (30% larger than the prior 3px)
    const ringT = Math.max(1, Math.round(ss)) // ~1px stroke
    raster.ring(d.x, d.y, ringR, ROUTE, ringT)
  }

  // Heading marker: a filled arrowhead at the user's position, rotated to the
  // route's forward bearing. Drawn last so it sits on top of roads + route.
  const marker = opts.marker
  if (marker) {
    const c = project(marker.at)
    const size = (opts.markerSizePx ?? 14) * ss
    // Bearing 0 = north = up (−y). Rotate the arrow's local geometry by it.
    // In heading-up mode the map is already rotated to travel direction, so the
    // arrow points straight up (effective bearing = headingDeg − rotationDeg,
    // which is ~0 when the marker uses the same bearing the map is rotated to).
    const effHeading = rotDeg != null ? marker.headingDeg - rotDeg : marker.headingDeg
    const rad = (effHeading * Math.PI) / 180
    const sin = Math.sin(rad)
    const cos = Math.cos(rad)
    // Local arrow (pointing up): tip ahead, two base corners behind.
    const tip = {x: 0, y: -size * 0.6}
    const left = {x: -size * 0.45, y: size * 0.4}
    const right = {x: size * 0.45, y: size * 0.4}
    const rot = (p: {x: number; y: number}) => ({
      x: c.x + (p.x * cos - p.y * sin),
      y: c.y + (p.x * sin + p.y * cos),
    })
    // Outline thickness in hi-res px (scales with supersample so it survives the
    // downsample). Expand each vertex outward from the local centroid to grow the
    // black halo triangle, then fill the white arrow inside it.
    const outline = Math.max(1, Math.round(1.5 * ss))
    const ctr = {x: 0, y: (tip.y + left.y + right.y) / 3}
    const grow = (p: {x: number; y: number}) => {
      const dx = p.x - ctr.x
      const dy = p.y - ctr.y
      const len = Math.hypot(dx, dy) || 1
      return {x: p.x + (dx / len) * outline, y: p.y + (dy / len) * outline}
    }
    // Black outline first (enlarged), white fill on top.
    const ot = rot(grow(tip))
    const ol = rot(grow(left))
    const or = rot(grow(right))
    raster.triangle(ot.x, ot.y, ol.x, ol.y, or.x, or.y, MARKER_OUTLINE)
    const t = rot(tip)
    const l = rot(left)
    const r = rot(right)
    raster.triangle(t.x, t.y, l.x, l.y, r.x, r.y, MARKER)
  }

  // Corner brackets: short rounded L-shaped marks at each corner (not a full
  // border). A small quarter-circle arc rounds the turn, with two straight arms
  // running out along each edge. Drawn in hi-res so it survives the downsample.
  {
    const armLen = Math.round(width * 0.066) * ss // length of each bracket arm (70% shorter)
    const r = Math.max(1, Math.round(2 * ss)) // corner radius (~2px)
    const thick = Math.max(1, ss) // stroke thickness
    const W = hiW - 1
    const H = hiH - 1
    const hLine = (x0: number, x1: number, y: number) => raster.line(x0, y, x1, y, BORDER, thick)
    const vLine = (y0: number, y1: number, x: number) => raster.line(x, y0, x, y1, BORDER, thick)
    // Quarter arc of radius r, centered (cx,cy), sweeping from a→b radians.
    const arc = (cx: number, cy: number, a0: number, a1: number) => {
      const steps = Math.max(4, Math.round(r * 2))
      for (let i = 0; i <= steps; i++) {
        const a = a0 + ((a1 - a0) * i) / steps
        raster.line(cx + Math.cos(a) * r, cy + Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r, BORDER, thick)
      }
    }
    // Each corner: arc tangent to both edges (center r in from the corner),
    // then straight arms from the arc's edge-tangent points outward.
    // top-left — arc center (r,r), sweeps 180°→270°
    arc(r, r, Math.PI, 1.5 * Math.PI)
    hLine(r, r + armLen, 0)
    vLine(r, r + armLen, 0)
    // top-right — center (W-r,r), sweeps 270°→360°
    arc(W - r, r, 1.5 * Math.PI, 2 * Math.PI)
    hLine(W - r - armLen, W - r, 0)
    vLine(r, r + armLen, W)
    // bottom-left — center (r,H-r), sweeps 90°→180°
    arc(r, H - r, 0.5 * Math.PI, Math.PI)
    hLine(r, r + armLen, H)
    vLine(H - r - armLen, H - r, 0)
    // bottom-right — center (W-r,H-r), sweeps 0°→90°
    arc(W - r, H - r, 0, 0.5 * Math.PI)
    hLine(W - r - armLen, W - r, H)
    vLine(H - r - armLen, H - r, W)
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
