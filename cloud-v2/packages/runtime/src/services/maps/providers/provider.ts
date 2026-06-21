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
  Route,
} from "../../../protocol/maps";

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
   * Resolve a coordinate to a road name. Resolves `{ road: null }` when nothing
   * was found near the coordinate (a successful empty answer); throws only on an
   * actual provider/transport failure.
   */
  reverseGeocode(coord: LatLng): Promise<{ road: string | null }>;
}
