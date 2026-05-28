/**
 * Promise wrapper over Google Maps' `Geocoder.geocode` for reverse
 * geocoding (lat/lng → formatted address). Resolves to the first
 * result's `formatted_address`, or `null` when the SDK isn't loaded,
 * the request fails, or no result comes back. Never rejects — callers
 * branch on null.
 */

type GeocoderResultLike = {formatted_address?: string}
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
