/**
 * Promise wrapper over Google Maps' `Geocoder.geocode` for reverse
 * geocoding (lat/lng → formatted address). Resolves to the first
 * result's `formatted_address`, or `null` when the SDK isn't loaded,
 * the request fails, or no result comes back. Never rejects — callers
 * branch on null.
 */

type GeocoderAddressComponent = {long_name?: string; short_name?: string; types?: string[]}
type GeocoderResultLike = {formatted_address?: string; address_components?: GeocoderAddressComponent[]}
type GeocoderRequestLike = {location: {lat: number; lng: number}}
type GeocoderLike = {
  geocode(
    request: GeocoderRequestLike,
    callback: (results: GeocoderResultLike[] | null, status: string) => void,
  ): void
}

export function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const g = (window as unknown as {google?: {maps?: {Geocoder?: new () => GeocoderLike}}}).google
  const GeocoderCtor = g?.maps?.Geocoder
  if (!GeocoderCtor) return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const geocoder = new GeocoderCtor()
      geocoder.geocode({location: {lat, lng}}, (results, status) => {
        const formatted = status === "OK" && results?.[0]?.formatted_address
        resolve(formatted || null)
      })
    } catch (err) {
      console.warn("[NAV-MINI] reverseGeocode failed:", err)
      resolve(null)
    }
  })
}

/**
 * Reverse-geocode to just the road name (e.g. "Hayes St"), not the full
 * formatted address. Pulls the `route` component out of the geocoder's
 * structured response — the same field Google Maps uses for the road
 * label. Returns null when the SDK isn't loaded, the request fails, no
 * result comes back, or the nearest result has no road (e.g. middle of
 * a park / plaza with no named path nearby). Never rejects.
 */
export function reverseGeocodeRoadName(lat: number, lng: number): Promise<string | null> {
  const g = (window as unknown as {google?: {maps?: {Geocoder?: new () => GeocoderLike}}}).google
  const GeocoderCtor = g?.maps?.Geocoder
  if (!GeocoderCtor) return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const geocoder = new GeocoderCtor()
      geocoder.geocode({location: {lat, lng}}, (results, status) => {
        if (status !== "OK" || !results || results.length === 0) {
          resolve(null)
          return
        }
        // Walk results from closest to furthest, take the first one that
        // has a `route` component. The closest result is often a building
        // or POI that doesn't carry a road name; the next-out usually
        // does. Stops at the first hit.
        for (const r of results) {
          const route = r.address_components?.find((c) => c.types?.includes("route"))
          const name = route?.short_name || route?.long_name
          if (name) {
            resolve(name)
            return
          }
        }
        resolve(null)
      })
    } catch (err) {
      console.warn("[NAV-MINI] reverseGeocodeRoadName failed:", err)
      resolve(null)
    }
  })
}