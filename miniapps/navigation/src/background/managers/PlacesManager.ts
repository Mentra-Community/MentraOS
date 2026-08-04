/**
 * PlacesManager
 *
 * Background-side Places facade. Wraps `PlacesSession` so the
 * `NavigationController` can expose `places:autocomplete` and
 * `places:details` as RPC channels. The underlying session token is
 * reset after every successful `details()` so the next autocomplete
 * begins a fresh billing session.
 *
 * Place search goes through the miniapp SDK → host → v2 cloud maps service
 * (Mapbox Search Box). There is no backend Worker. The request/response SDK
 * bridge has no mid-flight cancellation, so a superseded keystroke can't abort
 * an in-flight call — the UI's debounce limits wasted calls and the cloud
 * coalesces identical prefixes, so this is fine.
 */

import {PlacesSession} from "../lib/places"
import type {PlaceDetails, PlaceSuggestion} from "../lib/places"
import type {MiniappSession} from "@mentra/miniapp"

export class PlacesManager {
  private session: PlacesSession

  constructor(session: MiniappSession) {
    this.session = new PlacesSession(session)
  }

  autocomplete(
    query: string,
    near: {lat: number; lng: number} | undefined,
  ): Promise<PlaceSuggestion[]> {
    return this.session.autocomplete(query, near)
  }

  async details(placeId: string): Promise<PlaceDetails> {
    const result = await this.session.details(placeId)
    // Rotate the session token after a successful pick so the next
    // autocomplete is billed as a new session.
    this.session.reset()
    return result
  }
}
