/**
 * LocationManager — GPS coordinates, reverse geocoding, and weather.
 *
 * PORT NOTE: the cloud app used the Node `@googlemaps/google-maps-services-js`
 * client, which doesn't run in the JSContext. We call the Google Geocoding and
 * Weather REST endpoints directly with fetch instead — the caching, movement
 * threshold, and LocationContext shape are preserved from the cloud version.
 *
 * Keys come from MENTRA_PUBLIC_GOOGLE_MAPS_API_KEY / _WEATHER_API_KEY (inlined
 * at build). If absent, geocoding/weather degrade to "Unknown"/skipped.
 */

import {isLocationQuery, isWeatherQuery} from "../lib/location-keywords"
import {LOCATION_CACHE_SETTINGS} from "../constants/config"

const GOOGLE_MAPS_API_KEY = process.env.MENTRA_PUBLIC_GOOGLE_MAPS_API_KEY
const GOOGLE_WEATHER_API_KEY = process.env.MENTRA_PUBLIC_GOOGLE_WEATHER_API_KEY

export interface WeatherCondition {
  temperature: number // Fahrenheit
  temperatureCelsius: number
  condition: string
  humidity?: number
  wind?: string
}

export interface LocationContext {
  lat: number
  lng: number
  city: string
  state: string
  country: string
  streetAddress?: string
  neighborhood?: string
  timezone?: string
  weather?: WeatherCondition
  geocodedAt: number
  weatherFetchedAt: number
}

export class LocationManager {
  private currentLat: number | null = null
  private currentLng: number | null = null
  private userTimezone: string | null = null

  private cachedContext: LocationContext | null = null
  private lastGeocodedLat: number | null = null
  private lastGeocodedLng: number | null = null

  updateCoordinates(lat: number, lng: number): void {
    this.currentLat = lat
    this.currentLng = lng
  }

  hasLocation(): boolean {
    return this.currentLat !== null && this.currentLng !== null
  }

  getCoordinates(): {lat: number; lng: number} | null {
    if (!this.hasLocation()) return null
    return {lat: this.currentLat!, lng: this.currentLng!}
  }

  queryNeedsLocation(query: string): boolean {
    return isLocationQuery(query) || isWeatherQuery(query)
  }

  queryNeedsWeather(query: string): boolean {
    return isWeatherQuery(query)
  }

  /** Fetch location context with caching; only calls APIs when stale/moved. */
  async fetchContextIfNeeded(query: string): Promise<LocationContext | null> {
    if (!this.hasLocation()) return null

    const lat = this.currentLat!
    const lng = this.currentLng!

    const needsGeocoding = this.shouldRefreshGeocoding(lat, lng)
    const needsWeather = this.queryNeedsWeather(query) && this.shouldRefreshWeather()

    if (!needsGeocoding && !needsWeather && this.cachedContext) {
      return this.cachedContext
    }

    if (!this.cachedContext || needsGeocoding) {
      await this.refreshGeocoding(lat, lng)
    }
    if (needsWeather && this.cachedContext) {
      await this.refreshWeather(lat, lng)
    }
    return this.cachedContext
  }

  getCachedContext(): LocationContext | null {
    return this.cachedContext
  }

  getTimezone(): string | null {
    return this.cachedContext?.timezone ?? this.userTimezone
  }

  setTimezone(timezone: string): void {
    this.userTimezone = timezone
    if (this.cachedContext) this.cachedContext.timezone = timezone
  }

  destroy(): void {
    this.cachedContext = null
    this.currentLat = null
    this.currentLng = null
    this.lastGeocodedLat = null
    this.lastGeocodedLng = null
  }

  private shouldRefreshGeocoding(lat: number, lng: number): boolean {
    if (!this.cachedContext || this.lastGeocodedLat === null) return true

    const cacheAge = Date.now() - this.cachedContext.geocodedAt
    if (cacheAge > LOCATION_CACHE_SETTINGS.geocodeCacheDurationMs) return true

    const latDiff = Math.abs(lat - this.lastGeocodedLat!)
    const lngDiff = Math.abs(lng - this.lastGeocodedLng!)
    return (
      latDiff > LOCATION_CACHE_SETTINGS.minMovementDegrees ||
      lngDiff > LOCATION_CACHE_SETTINGS.minMovementDegrees
    )
  }

  private shouldRefreshWeather(): boolean {
    if (!this.cachedContext || !this.cachedContext.weather) return true
    const cacheAge = Date.now() - this.cachedContext.weatherFetchedAt
    return cacheAge > LOCATION_CACHE_SETTINGS.weatherCacheDurationMs
  }

  private async refreshGeocoding(lat: number, lng: number): Promise<void> {
    if (!GOOGLE_MAPS_API_KEY) {
      this.initializeContextWithDefaults(lat, lng)
      return
    }

    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_MAPS_API_KEY}`
      const response = await fetch(url, {headers: {Accept: "application/json"}})
      if (!response.ok) {
        this.initializeContextWithDefaults(lat, lng)
        return
      }

      const data = (await response.json()) as any
      if (data.status !== "OK" || !data.results?.length) {
        this.initializeContextWithDefaults(lat, lng)
        return
      }

      const components = data.results[0].address_components as Array<{
        long_name: string
        types: string[]
      }>

      let streetNumber = ""
      let route = ""
      let neighborhood = ""
      let city = "Unknown"
      let state = "Unknown"
      let country = "Unknown"

      for (const component of components) {
        const types = component.types
        if (types.includes("street_number")) streetNumber = component.long_name
        else if (types.includes("route")) route = component.long_name
        else if (types.includes("neighborhood") || types.includes("sublocality"))
          neighborhood = component.long_name
        else if (types.includes("locality")) city = component.long_name
        else if (types.includes("administrative_area_level_1")) state = component.long_name
        else if (types.includes("country")) country = component.long_name
      }

      const streetAddress = [streetNumber, route].filter(Boolean).join(" ") || undefined

      this.cachedContext = {
        lat,
        lng,
        city,
        state,
        country,
        streetAddress,
        neighborhood: neighborhood || undefined,
        timezone: this.cachedContext?.timezone ?? this.userTimezone ?? undefined,
        geocodedAt: Date.now(),
        weatherFetchedAt: this.cachedContext?.weatherFetchedAt || 0,
        weather: this.cachedContext?.weather,
      }
      this.lastGeocodedLat = lat
      this.lastGeocodedLng = lng
    } catch (error) {
      console.error("Geocoding error:", error)
      this.initializeContextWithDefaults(lat, lng)
    }
  }

  private async refreshWeather(lat: number, lng: number): Promise<void> {
    if (!GOOGLE_WEATHER_API_KEY || !this.cachedContext) return

    try {
      const url = `https://weather.googleapis.com/v1/currentConditions:lookup?key=${GOOGLE_WEATHER_API_KEY}&location.latitude=${lat}&location.longitude=${lng}`
      const response = await fetch(url, {headers: {Accept: "application/json"}})
      if (!response.ok) return

      const data = (await response.json()) as any
      const tempCelsius = Math.round(data.temperature?.degrees ?? 0)
      const tempFahrenheit = Math.round((tempCelsius * 9) / 5 + 32)
      const condition = data.condition?.description || "Unknown"
      const humidity = data.humidity
      const windSpeed = data.wind?.speed?.value
        ? Math.round(data.wind.speed.value * 2.237)
        : undefined
      const windDir = data.wind?.direction?.degrees
        ? this.getWindDirection(data.wind.direction.degrees)
        : undefined

      this.cachedContext.weather = {
        temperature: tempFahrenheit,
        temperatureCelsius: tempCelsius,
        condition,
        humidity,
        wind: windSpeed && windDir ? `${windSpeed} mph ${windDir}` : undefined,
      }
      this.cachedContext.weatherFetchedAt = Date.now()
    } catch (error) {
      console.error("Weather error:", error)
    }
  }

  private initializeContextWithDefaults(lat: number, lng: number): void {
    this.cachedContext = {
      lat,
      lng,
      city: "Unknown",
      state: "Unknown",
      country: "Unknown",
      timezone: this.cachedContext?.timezone ?? this.userTimezone ?? undefined,
      geocodedAt: Date.now(),
      weatherFetchedAt: 0,
    }
    this.lastGeocodedLat = lat
    this.lastGeocodedLng = lng
  }

  private getWindDirection(degrees: number): string {
    const directions = [
      "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
      "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
    ]
    return directions[Math.round(degrees / 22.5) % 16]
  }
}
