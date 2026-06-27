/**
 * Reverse geocoding (lat/lng → address / road name) for the UI WebView.
 *
 * These helpers do NOT call a maps provider directly. They proxy through the
 * background's `places:reverse-geocode` RPC, which calls the miniapp SDK, which
 * routes the request to the v2 cloud maps service (provider-abstracted, Mapbox
 * today). That service is the single auth + cache + rate-limit point: the
 * WebView never holds a maps token, and identical coords are de-duped/cached
 * cloud-side instead of burning a billed provider call per dropped pin.
 *
 * Never reject; callers branch on `null`. A failed lookup resolves to null.
 */

const REVERSE_GEOCODE_CHANNEL = "places:reverse-geocode"

/** Proxy one reverse-geocode through the background → SDK → cloud maps service. */
async function fetchReverse(
  lat: number,
  lng: number,
): Promise<{road: string | null; address: string | null} | null> {
  // Guard against non-finite input before spending a cloud round-trip.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  try {
    return await mentra.request(REVERSE_GEOCODE_CHANNEL, {lat, lng})
  } catch (err) {
    console.warn("[NAV-MINI] reverseGeocode failed:", err)
    return null
  }
}

/**
 * Full street address for a coordinate — e.g. "369 Hayes Street, San
 * Francisco, California 94102". Returns null when nothing usable comes back
 * (failed request, or no address near the coordinate).
 */
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const result = await fetchReverse(lat, lng)
  const addr = (result?.address ?? "").trim()
  return addr || null
}

/**
 * Reverse-geocode to just the road name (e.g. "Hayes Street"), not the full
 * address. Returns null when nothing usable comes back.
 */
export async function reverseGeocodeRoadName(lat: number, lng: number): Promise<string | null> {
  const result = await fetchReverse(lat, lng)
  const road = (result?.road ?? "").trim()
  return road || null
}
