/**
 * Places client — type-ahead autocomplete + details for the search box.
 *
 * Routes entirely through the miniapp SDK (`session.navigation.place*`), which
 * the host bridges to the v2 cloud maps service (Mapbox Search Box today). There
 * is NO backend Worker and no provider key in this bundle — the cloud holds the
 * token, caches, and bills. This replaced the old Google-Places secret-proxy
 * Worker.
 *
 * One PlacesSession represents one autocomplete-then-details flow. The provider
 * bills the autocomplete keystrokes + the final details call as a single search
 * session when the same `sessionToken` is sent on all of them, so callers should
 * create a session per "search box opening" and `reset()` it after the user
 * picks a result.
 */

import type {MiniappSession} from "@mentra/miniapp"

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

export class PlacesSession {
  private token: string

  constructor(private readonly session: MiniappSession) {
    this.token = newToken()
  }

  /**
   * Type-ahead suggestions for `input`, optionally biased toward `near`. Goes
   * through the SDK → host → v2 cloud maps (Mapbox Search Box). The same
   * `token` is sent on every keystroke + the final `details()` so the cloud
   * bills one search session.
   */
  async autocomplete(input: string, near?: {lat: number; lng: number}): Promise<PlaceSuggestion[]> {
    if (!input.trim()) return []
    const res = await this.session.navigation.placeAutocomplete({
      query: input,
      near,
      sessionToken: this.token,
    })
    if (!res.ok) throw new Error(res.error || "autocomplete failed")
    return res.suggestions ?? []
  }

  /** Resolve a picked suggestion to coordinates. Uses the same session token. */
  async details(placeId: string): Promise<PlaceDetails> {
    const res = await this.session.navigation.placeDetails({
      placeId,
      sessionToken: this.token,
    })
    if (!res.ok || !res.place) throw new Error(res.error || "details failed")
    const {placeId: id, name, address, lat, lng} = res.place
    return {placeId: id, name, address, lat, lng}
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

