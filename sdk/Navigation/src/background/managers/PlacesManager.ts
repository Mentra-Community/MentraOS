/**
 * PlacesManager
 *
 * Background-side Places facade. Wraps `PlacesSession` so the
 * `NavigationController` can expose `places:autocomplete` and
 * `places:details` as RPC channels. The underlying session token is
 * reset after every successful `details()` so the next autocomplete
 * begins a fresh Google billing session.
 *
 * Cancellation flows from the UI side via `mentra.request(..., {signal})`
 * → background's `session.ui.handle` ctx.signal → the `PlacesSession`
 * method's `signal` arg → the underlying `fetch(url, {signal})`. A
 * keystroke that's superseded by a newer keystroke cancels the
 * outstanding REST call cleanly.
 */

import {PlacesSession} from "../lib/places"
import type {PlaceDetails, PlaceSuggestion} from "../lib/places"

export class PlacesManager {
  private session: PlacesSession

  /**
   * @param userEmail Identity forwarded to the secret-proxy Worker as
   *   X-User-Email. Pass `session.userId` (the logged-in user) when available;
   *   PlacesSession falls back to a placeholder when it's empty.
   */
  constructor(userEmail?: string) {
    this.session = new PlacesSession(userEmail)
  }

  autocomplete(
    query: string,
    near: {lat: number; lng: number} | undefined,
    signal?: AbortSignal,
  ): Promise<PlaceSuggestion[]> {
    // `near` is currently unused — PlacesSession.autocomplete doesn't
    // forward it. Reserved for future bias-by-location enrichment so
    // the channel signature already accepts it.
    void near
    return this.session.autocomplete(query, signal)
  }

  async details(placeId: string, signal?: AbortSignal): Promise<PlaceDetails> {
    const result = await this.session.details(placeId, signal)
    // Rotate the session token after a successful pick so the next
    // autocomplete is billed as a new session.
    this.session.reset()
    return result
  }
}
