/**
 * Places client — talks directly to Google Places (New) Autocomplete +
 * Details from the WebView.
 *
 * Key resolution mirrors GoogleMapsManager: prod build inlines
 * `EXPO_PUBLIC_GOOGLE_PLACES_API_KEY` via build.ts; dev fetches it from
 * `/api/config`. The key must be HTTP-referrer-restricted in Google Cloud
 * Console since it ships in the client bundle.
 *
 * One PlacesSession represents one autocomplete-then-details flow. Google
 * bills the autocomplete keystrokes + the final details call as a single
 * session when the same `sessionToken` is sent on all of them, so callers
 * should create a session per "search box opening" and reset it after the
 * user picks a result.
 */

export type PlaceSuggestion = {
  placeId: string
  mainText: string
  secondaryText: string
}

export type PlaceDetails = {
  placeId: string
  lat: number
  lng: number
  name: string
  address: string
}

let cachedKeyPromise: Promise<string> | null = null

async function getApiKey(): Promise<string> {
  if (cachedKeyPromise) return cachedKeyPromise
  cachedKeyPromise = (async () => {
    try {
      const fromEnv = process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY
      if (fromEnv) return fromEnv
    } catch {
      // process is not defined in the dev WebView — fall through.
    }
    try {
      const res = await fetch("/api/config")
      if (res.ok) {
        const {googlePlacesApiKey} = (await res.json()) as {googlePlacesApiKey?: string}
        return googlePlacesApiKey ?? ""
      }
    } catch {
      // /api/config not reachable.
    }
    return ""
  })()
  return cachedKeyPromise
}

export class PlacesSession {
  private token: string

  constructor() {
    this.token = newToken()
  }

  async autocomplete(input: string, signal?: AbortSignal): Promise<PlaceSuggestion[]> {
    if (!input.trim()) return []
    const key = await getApiKey()
    if (!key) throw new Error("missing EXPO_PUBLIC_GOOGLE_PLACES_API_KEY")
    const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
      },
      body: JSON.stringify({input, sessionToken: this.token}),
      signal,
    })
    if (!res.ok) throw new Error(`autocomplete ${res.status}`)
    const json = (await res.json()) as {
      suggestions?: Array<{
        placePrediction?: {
          placeId: string
          text?: {text: string}
          structuredFormat?: {
            mainText?: {text: string}
            secondaryText?: {text: string}
          }
        }
      }>
    }
    return (json.suggestions ?? [])
      .map((s) => s.placePrediction)
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => ({
        placeId: p.placeId,
        mainText: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
        secondaryText: p.structuredFormat?.secondaryText?.text ?? "",
      }))
  }

  async details(placeId: string): Promise<PlaceDetails> {
    const key = await getApiKey()
    if (!key) throw new Error("missing EXPO_PUBLIC_GOOGLE_PLACES_API_KEY")
    const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?sessionToken=${encodeURIComponent(this.token)}`
    const res = await fetch(url, {
      headers: {
        "X-Goog-Api-Key": key,
        // Field mask keeps us in the cheapest pricing tier.
        "X-Goog-FieldMask": "id,location,displayName,formattedAddress",
      },
    })
    if (!res.ok) throw new Error(`details ${res.status}`)
    const json = (await res.json()) as {
      id?: string
      location?: {latitude: number; longitude: number}
      displayName?: {text: string}
      formattedAddress?: string
    }
    if (!json.location) throw new Error("details: no location")
    return {
      placeId: json.id ?? placeId,
      lat: json.location.latitude,
      lng: json.location.longitude,
      name: json.displayName?.text ?? "",
      address: json.formattedAddress ?? "",
    }
  }

  /** Rotate the token after a completed pick so the next search is a new
   *  billing session. */
  reset(): void {
    this.token = newToken()
  }
}

function newToken(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}
