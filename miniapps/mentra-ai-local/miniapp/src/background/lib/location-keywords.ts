/**
 * Location Query Detection
 *
 * Fast classifier to detect if a user query is location-related.
 * Used for lazy geocoding - only fetch location data when needed.
 */

// Keywords that indicate a location-related question
const LOCATION_KEYWORDS = [
  // Direct location questions
  'where am i',
  'my location',
  'location',
  'my address',
  'current location',
  'my current address',

  // City/area questions
  'what city',
  'which city',
  'what town',
  'what state',
  'what country',
  'what neighborhood',
  'what area',
  'what street',
  'which street',

  // Proximity questions
  'nearby',
  'near me',
  'around here',
  'close to me',
  'closest',
  'nearest',
  'in this area',

  // Navigation/directions
  'directions to',
  'how to get to',
  'navigate to',
  'route to',
  'how far',
  'distance to',
  'walking distance',
  'driving distance',

  // Local recommendations
  'restaurants nearby',
  'coffee near',
  'food near',
  'stores near',
  'shops near',
  'places near',
  'things to do near',
  'what\'s around',
];

// Weather keywords (also need location)
const WEATHER_KEYWORDS = [
  'weather',
  'temperature',
  'forecast',
  'rain',
  'sunny',
  'cloudy',
  'snow',
  'humidity',
  'wind speed',
];

/**
 * Check if a query is location-related
 * @param query - The user's query text
 * @returns true if the query needs location data
 */
export function isLocationQuery(query: string): boolean {
  const q = query.toLowerCase();

  // Check location keywords
  if (LOCATION_KEYWORDS.some(kw => q.includes(kw))) {
    return true;
  }

  // Check weather keywords
  if (WEATHER_KEYWORDS.some(kw => q.includes(kw))) {
    return true;
  }

  return false;
}

/**
 * Check if query specifically needs geocoding (street/city/neighborhood)
 * vs just weather which only needs lat/lng
 */
export function needsGeocoding(query: string): boolean {
  const q = query.toLowerCase();

  // Weather only needs lat/lng, not full geocoding
  if (WEATHER_KEYWORDS.some(kw => q.includes(kw))) {
    // Unless they're asking "weather in [city]" which doesn't need our location
    if (!q.includes(' in ') && !q.includes(' at ')) {
      return false; // Just weather at current location - lat/lng is enough
    }
  }

  // All other location queries need geocoding
  return LOCATION_KEYWORDS.some(kw => q.includes(kw));
}

/**
 * Check if query is weather-related
 * @param query - The user's query text
 * @returns true if the query is about weather
 */
export function isWeatherQuery(query: string): boolean {
  const q = query.toLowerCase();
  return WEATHER_KEYWORDS.some(kw => q.includes(kw));
}

/**
 * Get the type of location query for logging/debugging
 */
export function getLocationQueryType(query: string): 'none' | 'weather_only' | 'full_location' {
  const q = query.toLowerCase();

  if (LOCATION_KEYWORDS.some(kw => q.includes(kw))) {
    return 'full_location';
  }

  if (WEATHER_KEYWORDS.some(kw => q.includes(kw))) {
    return 'weather_only';
  }

  return 'none';
}
