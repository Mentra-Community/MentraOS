/**
 * LocationManager - Handles GPS location, reverse geocoding, and weather
 *
 * Features:
 * - Per-session caching to prevent excessive API calls
 * - Lazy geocoding (only fetch when needed)
 * - Google Maps integration for reverse geocoding
 * - Google Weather API integration
 */

import { Client } from "@googlemaps/google-maps-services-js";
import type { User } from "../session/User";
import { isLocationQuery, isWeatherQuery } from "../utils/location-keywords";
import { LOCATION_CACHE_SETTINGS } from "../constants/config";

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const GOOGLE_WEATHER_API_KEY = process.env.GOOGLE_WEATHER_API_KEY;

// Google Maps client
const mapsClient = new Client({});

/**
 * Weather condition data
 */
export interface WeatherCondition {
  temperature: number;         // Fahrenheit
  temperatureCelsius: number;  // Celsius
  condition: string;           // e.g., "Sunny", "Cloudy"
  humidity?: number;
  wind?: string;
}

/**
 * Complete location context
 */
export interface LocationContext {
  // Coordinates
  lat: number;
  lng: number;

  // Geocoded address
  city: string;
  state: string;
  country: string;
  streetAddress?: string;
  neighborhood?: string;

  // Timezone (from SDK)
  timezone?: string;

  // Weather
  weather?: WeatherCondition;

  // Cache metadata
  geocodedAt: number;
  weatherFetchedAt: number;
}

/**
 * LocationManager — handles GPS, geocoding, and weather for a single user session.
 */
export class LocationManager {
  // Current raw coordinates
  private currentLat: number | null = null;
  private currentLng: number | null = null;

  // Timezone stored independently (set from SDK before cachedContext exists)
  private userTimezone: string | null = null;

  // Cached location context (per-session)
  private cachedContext: LocationContext | null = null;
  private lastGeocodedLat: number | null = null;
  private lastGeocodedLng: number | null = null;

  constructor(private user: User) {}

  /**
   * Update raw coordinates (called when SDK sends location update)
   */
  updateCoordinates(lat: number, lng: number): void {
    this.currentLat = lat;
    this.currentLng = lng;
  }

  /**
   * Check if we have valid coordinates
   */
  hasLocation(): boolean {
    return this.currentLat !== null && this.currentLng !== null;
  }

  /**
   * Get current coordinates
   */
  getCoordinates(): { lat: number; lng: number } | null {
    if (!this.hasLocation()) return null;
    return { lat: this.currentLat!, lng: this.currentLng! };
  }

  /**
   * Check if a query needs location data
   */
  queryNeedsLocation(query: string): boolean {
    return isLocationQuery(query) || isWeatherQuery(query);
  }

  /**
   * Check if a query needs weather specifically
   */
  queryNeedsWeather(query: string): boolean {
    return isWeatherQuery(query);
  }

  /**
   * Fetch location context (with caching)
   * Only makes API calls if cache is invalid
   */
  async fetchContextIfNeeded(query: string): Promise<LocationContext | null> {
    if (!this.hasLocation()) {
      console.log(`⚠️ No location available for ${this.user.userId}`);
      return null;
    }

    const lat = this.currentLat!;
    const lng = this.currentLng!;

    // Check if we need to refresh geocoding
    const needsGeocoding = this.shouldRefreshGeocoding(lat, lng);

    // Check if we need to refresh weather
    const needsWeather = this.queryNeedsWeather(query) && this.shouldRefreshWeather();

    // Return cached if nothing needs refresh
    if (!needsGeocoding && !needsWeather && this.cachedContext) {
      console.log(`📦 Using cached location context for ${this.user.userId}`);
      return this.cachedContext;
    }

    // Initialize or update context
    if (!this.cachedContext || needsGeocoding) {
      await this.refreshGeocoding(lat, lng);
    }

    if (needsWeather && this.cachedContext) {
      await this.refreshWeather(lat, lng);
    }

    return this.cachedContext;
  }

  /**
   * Get cached context without making API calls
   */
  getCachedContext(): LocationContext | null {
    return this.cachedContext;
  }

  /**
   * Get the user's timezone (available even before location context is built)
   */
  getTimezone(): string | null {
    return this.cachedContext?.timezone ?? this.userTimezone;
  }

  /**
   * Check if geocoding should be refreshed
   */
  private shouldRefreshGeocoding(lat: number, lng: number): boolean {
    if (!this.cachedContext || this.lastGeocodedLat === null) {
      return true;
    }

    const now = Date.now();
    const cacheAge = now - this.cachedContext.geocodedAt;
    if (cacheAge > LOCATION_CACHE_SETTINGS.geocodeCacheDurationMs) {
      return true;
    }

    // Check if location moved significantly
    const latDiff = Math.abs(lat - this.lastGeocodedLat!);
    const lngDiff = Math.abs(lng - this.lastGeocodedLng!);
    if (latDiff > LOCATION_CACHE_SETTINGS.minMovementDegrees ||
        lngDiff > LOCATION_CACHE_SETTINGS.minMovementDegrees) {
      return true;
    }

    return false;
  }

  /**
   * Check if weather should be refreshed
   */
  private shouldRefreshWeather(): boolean {
    if (!this.cachedContext || !this.cachedContext.weather) {
      return true;
    }

    const now = Date.now();
    const cacheAge = now - this.cachedContext.weatherFetchedAt;
    return cacheAge > LOCATION_CACHE_SETTINGS.weatherCacheDurationMs;
  }

  /**
   * Refresh geocoding data from Google Maps API
   */
  private async refreshGeocoding(lat: number, lng: number): Promise<void> {
    if (!GOOGLE_MAPS_API_KEY) {
      console.warn('⚠️ GOOGLE_MAPS_API_KEY not configured');
      this.initializeContextWithDefaults(lat, lng);
      return;
    }

    console.log(`🌐 Fetching geocoding for ${lat}, ${lng}`);

    try {
      const response = await mapsClient.reverseGeocode({
        params: {
          latlng: { lat, lng },
          key: GOOGLE_MAPS_API_KEY,
        },
        timeout: 5000,
      });

      if (response.data.status !== 'OK' || !response.data.results?.length) {
        console.warn(`⚠️ Geocoding failed: ${response.data.status}`);
        this.initializeContextWithDefaults(lat, lng);
        return;
      }

      const result = response.data.results[0];
      const components = result.address_components;

      // Parse address components
      let streetNumber = '';
      let route = '';
      let neighborhood = '';
      let city = 'Unknown';
      let state = 'Unknown';
      let country = 'Unknown';

      for (const component of components) {
        const types = component.types as string[];

        if (types.includes('street_number')) {
          streetNumber = component.long_name;
        } else if (types.includes('route')) {
          route = component.long_name;
        } else if (types.includes('neighborhood') || types.includes('sublocality')) {
          neighborhood = component.long_name;
        } else if (types.includes('locality')) {
          city = component.long_name;
        } else if (types.includes('administrative_area_level_1')) {
          state = component.long_name;
        } else if (types.includes('country')) {
          country = component.long_name;
        }
      }

      const streetAddress = [streetNumber, route].filter(Boolean).join(' ') || undefined;

      // Update or create context
      const now = Date.now();
      this.cachedContext = {
        lat,
        lng,
        city,
        state,
        country,
        streetAddress,
        neighborhood: neighborhood || undefined,
        geocodedAt: now,
        weatherFetchedAt: this.cachedContext?.weatherFetchedAt || 0,
        weather: this.cachedContext?.weather,
      };

      this.lastGeocodedLat = lat;
      this.lastGeocodedLng = lng;

      console.log(`✅ Geocoding complete: ${city}, ${state}`);

    } catch (error) {
      console.error('❌ Geocoding error:', error);
      this.initializeContextWithDefaults(lat, lng);
    }
  }

  /**
   * Refresh weather data from Google Weather API
   */
  private async refreshWeather(lat: number, lng: number): Promise<void> {
    if (!GOOGLE_WEATHER_API_KEY) {
      console.warn('⚠️ GOOGLE_WEATHER_API_KEY not configured');
      return;
    }

    if (!this.cachedContext) return;

    console.log(`🌤️ Fetching weather for ${lat}, ${lng}`);

    try {
      const url = `https://weather.googleapis.com/v1/currentConditions:lookup?key=${GOOGLE_WEATHER_API_KEY}&location.latitude=${lat}&location.longitude=${lng}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) {
        console.warn(`⚠️ Weather API error: ${response.status}`);
        return;
      }

      const data = await response.json();

      const tempCelsius = Math.round(data.temperature?.degrees ?? 0);
      const tempFahrenheit = Math.round(tempCelsius * 9 / 5 + 32);
      const condition = data.condition?.description || 'Unknown';
      const humidity = data.humidity;
      const windSpeed = data.wind?.speed?.value ? Math.round(data.wind.speed.value * 2.237) : undefined;
      const windDir = data.wind?.direction?.degrees ? this.getWindDirection(data.wind.direction.degrees) : undefined;

      this.cachedContext.weather = {
        temperature: tempFahrenheit,
        temperatureCelsius: tempCelsius,
        condition,
        humidity,
        wind: windSpeed && windDir ? `${windSpeed} mph ${windDir}` : undefined,
      };
      this.cachedContext.weatherFetchedAt = Date.now();

      console.log(`✅ Weather: ${tempFahrenheit}°F, ${condition}`);

    } catch (error) {
      console.error('❌ Weather error:', error);
    }
  }

  /**
   * Initialize context with default values
   */
  private initializeContextWithDefaults(lat: number, lng: number): void {
    const now = Date.now();
    this.cachedContext = {
      lat,
      lng,
      city: 'Unknown',
      state: 'Unknown',
      country: 'Unknown',
      geocodedAt: now,
      weatherFetchedAt: 0,
    };
    this.lastGeocodedLat = lat;
    this.lastGeocodedLng = lng;
  }

  /**
   * Convert wind direction degrees to cardinal direction
   */
  private getWindDirection(degrees: number): string {
    const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                        'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const index = Math.round(degrees / 22.5) % 16;
    return directions[index];
  }

  /**
   * Set timezone (called from SDK settings)
   */
  setTimezone(timezone: string): void {
    this.userTimezone = timezone;
    if (this.cachedContext) {
      this.cachedContext.timezone = timezone;
    }
  }

  /**
   * Clean up (called on session end)
   */
  destroy(): void {
    this.cachedContext = null;
    this.currentLat = null;
    this.currentLng = null;
    this.lastGeocodedLat = null;
    this.lastGeocodedLng = null;
    console.log(`🗑️ LocationManager cleaned up for ${this.user.userId}`);
  }
}
