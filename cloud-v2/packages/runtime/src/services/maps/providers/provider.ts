/**
 * @fileoverview The maps provider contract.
 *
 * This interface is the line where a vendor's dialect becomes our one neutral
 * vocabulary. It speaks ONLY in the protocol-neutral types from
 * `protocol/maps` (LatLng, Route, TravelMode, ...) — never a vendor's JSON
 * shape. Each implementation owns its own HTTP endpoints, auth token, response
 * decoding, and maneuver/profile mapping, and returns these neutral types.
 *
 * Mapbox (mapbox.provider) is the only implementation today. Adding a vendor
 * (Google, etc.) is therefore: write one `create<Vendor>Provider()` that
 * satisfies this interface, then teach `maps.service` to select it by env var.
 * Nothing else in the service, API, protocol, or client changes.
 *
 * Following the codebase convention (StorageProvider, StreamProvider), providers
 * are built by a factory function and expose a `readonly name` for diagnostics.
 */
import type {
  DirectionsRequest,
  LatLng,
  PlaceDetailsResult,
  PlaceSuggestion,
  Route,
} from "@mentra/cloud-protocol/maps";

export interface MapsProvider {
  /** Diagnostic label, e.g. "mapbox". */
  readonly name: string;

  /**
   * Compute one or more routes from `origin` through `stops`. Returns the
   * primary route first, alternates after. Throws on a provider/transport
   * failure; an empty `[]` means the provider found no route.
   */
  directions(req: DirectionsRequest): Promise<Route[]>;

  /**
   * Resolve a coordinate to a short road name (`road`) and a full formatted
   * street address (`address`). Either field is null when nothing of that kind
   * was found near the coordinate (a successful empty answer); throws only on an
   * actual provider/transport failure.
   */
  reverseGeocode(coord: LatLng): Promise<{ road: string | null; address: string | null }>;

  /**
   * Type-ahead place search. Returns lightweight suggestions for `query`,
   * optionally biased toward `near`. `sessionToken` groups this with the
   * following `placeDetails` call into one billed search session. Resolves `[]`
   * for an empty/whitespace query; throws only on a provider/transport failure.
   */
  placeAutocomplete(
    query: string,
    near: LatLng | undefined,
    sessionToken: string,
  ): Promise<PlaceSuggestion[]>;

  /**
   * Resolve a suggestion's `placeId` (from `placeAutocomplete`) to a full place
   * with coordinates. `sessionToken` must match the autocomplete that produced
   * the id so the provider closes the billing session. Throws on a
   * provider/transport failure or an unresolvable id.
   */
  placeDetails(placeId: string, sessionToken: string): Promise<PlaceDetailsResult>;
}
