/**
 * Fetch Google Static Maps images and save them next to this file, so we can
 * eyeball what kind of picture the glasses bitmap pipeline could render from a
 * real map tile (different zooms / sizes / map types).
 *
 * The API key is read from PUBLIC_MAP_NAV_VIEWER (the navigation miniapp's
 * map key — Bun auto-loads it from .env). NOTE: that key is normally restricted
 * to the Maps JavaScript API + an HTTP-referrer; the Static Maps API is a
 * different endpoint, so if it's restricted you'll get a 403 / "API key not
 * authorized" PNG back. In that case enable "Maps Static API" for the key
 * (or use an unrestricted key) — see the console URL in .env.example.
 *
 * Run:  bun run src/test/bitmaps/fetch-static-maps.ts
 */

const API_KEY = process.env.PUBLIC_MAP_NAV_VIEWER

if (!API_KEY || API_KEY.startsWith("your_") || API_KEY.startsWith("YOUR_")) {
  console.error(
    "✗ PUBLIC_MAP_NAV_VIEWER is not set (or is a placeholder). Add it to .env.",
  )
  process.exit(1)
}

const BASE = "https://maps.googleapis.com/maps/api/staticmap"

// Center used in the examples (Lower Manhattan).
const CENTER = "40.714728,-73.998672"

// A spread of variations so we can compare what reads well on a 1-bit-ish
// glasses display: zoom levels, output sizes, and map types.
type MapRequest = {name: string; params: Record<string, string>}

const REQUESTS: MapRequest[] = [
  {name: "z12-400x400", params: {center: CENTER, zoom: "12", size: "400x400"}},
  {name: "z14-400x400", params: {center: CENTER, zoom: "14", size: "400x400"}},
  {name: "z16-400x400", params: {center: CENTER, zoom: "16", size: "400x400"}},
  // Match the glasses container shapes we've been testing.
  {name: "z14-200x88", params: {center: CENTER, zoom: "14", size: "200x88"}},
  {name: "z14-200x100", params: {center: CENTER, zoom: "14", size: "200x100"}},
  // Map type variations — roadmap vs high-contrast options.
  {name: "z14-roadmap", params: {center: CENTER, zoom: "14", size: "400x400", maptype: "roadmap"}},
  {name: "z14-terrain", params: {center: CENTER, zoom: "14", size: "400x400", maptype: "terrain"}},
  {name: "z14-satellite", params: {center: CENTER, zoom: "14", size: "400x400", maptype: "satellite"}},
]

function buildUrl(params: Record<string, string>): string {
  const q = new URLSearchParams({...params, key: API_KEY!})
  return `${BASE}?${q.toString()}`
}

// The key is HTTP-referrer-restricted, but a CLI fetch sends no referrer and
// gets rejected. We forge a Referer header matching one of the key's allowed
// referrer patterns so the request is accepted WITHOUT loosening the key.
// Override via STATIC_MAPS_REFERER if the key allows a different domain.
const REFERER = process.env.STATIC_MAPS_REFERER ?? "https://console.mentra.glass/"

const outDir = new URL(".", import.meta.url).pathname

async function fetchOne(req: MapRequest): Promise<void> {
  const url = buildUrl(req.params)
  // Log the URL with the key redacted so it's safe to paste.
  console.log(`→ ${req.name}: ${url.replace(API_KEY!, "***")}`)

  const res = await fetch(url, {headers: {Referer: REFERER}})
  const buf = new Uint8Array(await res.arrayBuffer())

  if (!res.ok) {
    console.error(`  ✗ HTTP ${res.status} — saving body for inspection`)
  }

  const file = `${outDir}${req.name}.png`
  await Bun.write(file, buf)
  console.log(`  ✓ saved ${file} (${(buf.length / 1024).toFixed(1)} KB)`)
}

export {}

console.log(`Fetching ${REQUESTS.length} static maps → ${outDir}`)
console.log(`Referer: ${REFERER}\n`)
for (const req of REQUESTS) {
  try {
    await fetchOne(req)
  } catch (err) {
    console.error(`  ✗ ${req.name} failed:`, err)
  }
}
console.log("\nDone.")
