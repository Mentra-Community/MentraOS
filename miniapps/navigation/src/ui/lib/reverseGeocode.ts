/**
 * Reverse geocoding (lat/lng → address) via the Mapbox Geocoding API v6.
 *
 * The front end migrated off Google Maps, so `window.google` no longer
 * exists — these helpers hit Mapbox's v6 `/reverse` endpoint directly using
 * the same access token the map uses (`getMapbox().apiKey`). Never reject;
 * callers branch on `null`.
 *
 * v6 returns a GeoJSON FeatureCollection. For an `address` feature:
 *   - `properties.full_address` → "369 Hayes Street, San Francisco, …"
 *   - `properties.name`         → "369 Hayes Street" (the address line)
 *   - `properties.context.street.name` → "Hayes Street" (street only)
 */

import {getMapbox} from "@/ui/lib/mapbox"

const MAPBOX_GEOCODE_REVERSE = "https://api.mapbox.com/search/geocode/v6/reverse"

type V6Feature = {
  properties?: {
    feature_type?: string
    name?: string
    full_address?: string
    place_formatted?: string
    context?: {street?: {name?: string}; address?: {name?: string}}
  }
}

/** Resolve the Mapbox token (waits for map init), or "" if unavailable. */
async function token(): Promise<string> {
  try {
    const mb = getMapbox()
    await mb.whenReady()
    return mb.apiKey || ""
  } catch {
    return ""
  }
}

async function fetchReverse(lat: number, lng: number, types: string): Promise<V6Feature[]> {
  const tok = await token()
  if (!tok) return []
  const params = new URLSearchParams({
    longitude: String(lng),
    latitude: String(lat),
    types,
    limit: "1",
    access_token: tok,
  })
  try {
    const res = await fetch(`${MAPBOX_GEOCODE_REVERSE}?${params.toString()}`, {method: "GET"})
    if (!res.ok) {
      console.warn("[NAV-MINI] reverseGeocode: Geocoding API", res.status)
      return []
    }
    const json = (await res.json()) as {features?: V6Feature[]}
    return json.features ?? []
  } catch (err) {
    console.warn("[NAV-MINI] reverseGeocode failed:", err)
    return []
  }
}

/**
 * Full street address for a coordinate — e.g. "369 Hayes Street, San
 * Francisco, California 94102". Requests `address` features so the house
 * number is included; prefers `full_address`, then `name`. Returns null when
 * the token is missing, the request fails, or no address comes back.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  // `address` first (carries the house number); fall back to broader types so
  // we still return SOMETHING for a coord with no exact street address.
  const features = await fetchReverse(lat, lng, "address,street,place")
  const p = features[0]?.properties
  if (!p) return null
  const addr = (p.full_address ?? p.name ?? p.place_formatted ?? "").trim()
  return addr || null
}

/**
 * Reverse-geocode to just the road name (e.g. "Hayes Street"), not the full
 * address. Reads the street from a street-type feature's name, else from
 * `context.street.name`. Returns null when nothing usable comes back.
 */
export async function reverseGeocodeRoadName(lat: number, lng: number): Promise<string | null> {
  const features = await fetchReverse(lat, lng, "address,street")
  for (const f of features) {
    const props = f.properties
    const fromStreetType = props?.feature_type === "street" ? props?.name : undefined
    const name = (fromStreetType ?? props?.context?.street?.name ?? "").trim()
    if (name) return name
  }
  return null
}
