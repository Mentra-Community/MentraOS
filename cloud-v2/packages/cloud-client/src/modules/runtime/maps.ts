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
  ReverseGeocodeResult,
} from "@mentra/cloud-runtime/protocol";

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
} from "@mentra/cloud-runtime/protocol";

const DIRECTIONS_PATH = "/api/maps/directions";
const REVERSE_GEOCODE_PATH = "/api/maps/reverse-geocode";

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

  /** Resolve a coordinate to a road name (`road` is null when none found nearby). */
  reverseGeocode(coord: LatLng): Promise<ReverseGeocodeResult> {
    return this.http.post<ReverseGeocodeResult>(REVERSE_GEOCODE_PATH, coord, {
      idempotent: true,
    });
  }
}
