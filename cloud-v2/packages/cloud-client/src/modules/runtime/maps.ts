/**
 * @fileoverview Runtime maps API: directions + reverse geocoding.
 *
 * A thin client over the runtime's `/api/maps/*` REST endpoints. Both calls are
 * plain request/response (no WebSocket push, unlike camera), so this module only
 * needs the shared HTTP helper. The cloud holds the maps provider token; the
 * consumer (e.g. the navigation miniapp via the SDK) calls these and never sees
 * a provider credential or a vendor-specific response shape.
 *
 * The wire types are canonical in the protocol package (the runtime server uses
 * the same ones); re-export them so a host gets them from this module.
 */
import type { HttpClient } from "../../http";
import type {
  DirectionsRequest,
  DirectionsResult,
  LatLng,
  PlaceAutocompleteResult,
  PlaceDetailsResult,
  ReverseGeocodeResult,
} from "@mentra/cloud-protocol";

export type {
  DirectionsRequest,
  DirectionsResult,
  Route,
  RouteStep,
  LatLng,
  TravelMode,
  ManeuverKind,
  RouteAvoidances,
  ReverseGeocodeResult,
  PlaceSuggestion,
  PlaceAutocompleteResult,
  PlaceDetailsResult,
} from "@mentra/cloud-protocol";

const DIRECTIONS_PATH = "/api/maps/directions";
const REVERSE_GEOCODE_PATH = "/api/maps/reverse-geocode";
const PLACE_AUTOCOMPLETE_PATH = "/api/maps/place-autocomplete";
const PLACE_DETAILS_PATH = "/api/maps/place-details";

export interface MapsDeps {
  http: HttpClient;
}

export class Maps {
  private readonly http: HttpClient;

  constructor(deps: MapsDeps) {
    this.http = deps.http;
  }

  /** Compute routes from origin through stops. Primary route first, alternates after. */
  directions(req: DirectionsRequest): Promise<DirectionsResult> {
    // Idempotent: a directions request is a pure read, safe to retry on a
    // transient network failure.
    return this.http.post<DirectionsResult>(DIRECTIONS_PATH, req, { idempotent: true });
  }

  /**
   * Resolve a coordinate to a short road name (`road`) + full formatted address
   * (`address`). Each is null when none of that kind is found near the coord.
   */
  reverseGeocode(coord: LatLng): Promise<ReverseGeocodeResult> {
    return this.http.post<ReverseGeocodeResult>(REVERSE_GEOCODE_PATH, coord, {
      idempotent: true,
    });
  }

  /**
   * Type-ahead place search. `sessionToken` groups the keystrokes with the
   * following `placeDetails` pick into one billed search session.
   */
  placeAutocomplete(req: {
    query: string;
    near?: LatLng;
    sessionToken: string;
  }): Promise<PlaceAutocompleteResult> {
    // Idempotent: autocomplete is a pure read, safe to retry on a transient blip.
    return this.http.post<PlaceAutocompleteResult>(PLACE_AUTOCOMPLETE_PATH, req, {
      idempotent: true,
    });
  }

  /** Resolve an autocomplete suggestion (`placeId` + same `sessionToken`) to coordinates. */
  placeDetails(req: { placeId: string; sessionToken: string }): Promise<PlaceDetailsResult> {
    return this.http.post<PlaceDetailsResult>(PLACE_DETAILS_PATH, req, {
      idempotent: true,
    });
  }
}
