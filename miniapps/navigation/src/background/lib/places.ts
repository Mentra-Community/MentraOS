/**
 * Places client — talks to Google Places (New) Autocomplete + Details
 * THROUGH the secret-proxy Worker (sdk/Navigation/worker), so the Google
 * API key never ships in this bundle. The Worker holds the key and
 * forwards to Google.
 *
 * Auth is a placeholder: we send an `X-User-Email` header. When a real
 * logged-in session exists, `session.userId` carries it; otherwise we fall
 * back to a hardcoded address (PLACEHOLDER_USER_EMAIL). This is NOT real
 * auth — it's the swap-in seam for the future signed-token layer. The real
 * guardrail today is the GCP quota cap on the (now server-side) Places key.
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
  /** User-defined label when saved as a favorite or custom place */
  savedName?: string
  /**
   * True while a reverse-geocode is in flight for a dropped pin. The
   * `name` / `address` fields are placeholders (raw lat/lng) until this
   * flips back to false. UI consumers render a skeleton while this is
   * true so the user doesn't see the bare coordinates flash on screen
   * before the real address lands.
   */
  isGeocoding?: boolean
}

/**
 * A place saved by the user. Optionally tagged as `"home"` or `"work"`
 * so the IdleDrawer can surface those two as fixed quick-access slots.
 * Anything else is just an untagged saved place — there is no
 * favorite/custom distinction anymore.
 */
export type SavedPlaceType = "home" | "work"

export type SavedPlace = PlaceDetails & {
  type?: SavedPlaceType
}

// Base URL of the secret-proxy Worker (sdk/Navigation/worker). The Worker
// holds the Google Places key and forwards to Google; this bundle never sees
// the key. Injected at build time via build.ts `define`.
const PROXY_BASE_URL = process.env.PROXY_BASE_URL ?? ""

// Placeholder identity sent to the proxy as X-User-Email. When a real
// logged-in session exists, `session.userId` is threaded in (see
// PlacesSession constructor); otherwise we fall back to this. NOT real auth —
// the swap-in seam for the future signed-token layer.
const PLACEHOLDER_USER_EMAIL = "something@mentraglass.com"

export class PlacesSession {
  private token: string
  private readonly userEmail: string

  constructor(userEmail?: string) {
    this.token = newToken()
    this.userEmail = userEmail && userEmail.trim() ? userEmail : PLACEHOLDER_USER_EMAIL
  }

  async autocomplete(input: string, signal?: AbortSignal): Promise<PlaceSuggestion[]> {
    if (!input.trim()) return []
    // Fail loudly at call time (build.ts only warns): with an empty base
    // URL the fetch would silently hit a relative path on the WebView's
    // own origin and produce a confusing failure instead.
    if (!PROXY_BASE_URL) throw new Error("missing PROXY_BASE_URL")
    const res = await fetch(`${PROXY_BASE_URL}/places/autocomplete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-Email": this.userEmail,
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

  async details(placeId: string, signal?: AbortSignal): Promise<PlaceDetails> {
    if (!PROXY_BASE_URL) throw new Error("missing PROXY_BASE_URL")
    const url =
      `${PROXY_BASE_URL}/places/details/${encodeURIComponent(placeId)}` +
      `?sessionToken=${encodeURIComponent(this.token)}`
    // The Worker applies the field mask server-side (fixed to the cheapest
    // pricing tier) — clients can't widen it, so we don't send one.
    const res = await fetch(url, {
      headers: {
        "X-User-Email": this.userEmail,
      },
      signal,
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

