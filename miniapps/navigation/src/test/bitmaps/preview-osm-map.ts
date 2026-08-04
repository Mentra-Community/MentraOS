/**
 * Desktop preview for the OSM line-map renderer — no glasses needed.
 *
 * Fetches roads, renders the exact same base64 BMP the glasses get, decodes it
 * back to a PNG, upscales it so it's visible, saves to disk, and (on macOS)
 * opens it. Use this to iterate on zoom / line width / center quickly.
 *
 * Usage:
 *   bun run src/test/bitmaps/preview-osm-map.ts                    # defaults
 *   bun run src/test/bitmaps/preview-osm-map.ts <lat> <lng> <radiusM> <size> <lineW> <upscale>
 *
 * Example (zoomed in on Manhattan, 8× upscale):
 *   bun run src/test/bitmaps/preview-osm-map.ts 40.714728 -73.998672 133 88 1 8
 */

import {$} from "bun"
import {buildOsmLineMap} from "../../background/lib/OsmLineMapRenderer"

const lat = Number(process.argv[2] ?? 40.714728)
const lng = Number(process.argv[3] ?? -73.998672)
const radius = Number(process.argv[4] ?? 133)
const size = Number(process.argv[5] ?? 88)
const lineW = Number(process.argv[6] ?? 1)
const upscale = Number(process.argv[7] ?? 4)

console.log(`Rendering OSM map: center=${lat},${lng} radius=${radius}m size=${size}×${size} lineW=${lineW}`)

const base64 = await buildOsmLineMap({
  center: {lat, lng},
  width: size,
  height: size,
  viewRadiusMeters: radius,
  lineWidthPx: lineW,
})

// Decode the base64 BMP (exactly what the glasses receive) and save it.
const bmpBytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
const outDir = new URL(".", import.meta.url).pathname
const bmpPath = `${outDir}preview-osm.bmp`
const pngPath = `${outDir}preview-osm.png`
await Bun.write(bmpPath, bmpBytes)

// Convert BMP → PNG and upscale (nearest-neighbour stays crisp for line art)
// so the tiny 88px image is actually viewable on a desktop monitor.
const upPx = size * upscale
await $`sips -s format png ${bmpPath} -z ${upPx} ${upPx} --out ${pngPath}`.quiet()

console.log(`✓ saved ${pngPath} (${size}×${size} upscaled ${upscale}× → ${upPx}px)`)

// Open it on macOS so you see it immediately.
try {
  await $`open ${pngPath}`.quiet()
  console.log("→ opened in Preview")
} catch {
  console.log("(could not auto-open; open the PNG manually)")
}
