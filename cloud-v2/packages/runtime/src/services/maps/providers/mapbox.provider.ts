/**
 * @fileoverview Mapbox maps provider.
 *
 * The ONLY Mapbox-aware code in the runtime. Everything vendor-specific lives
 * here: the `api.mapbox.com` endpoints, the access token, polyline6 decoding,
 * and the Mapbox maneuver/profile/exclude vocabulary -> our neutral vocabulary.
 * It returns the protocol-neutral `Route[]` / `{road}` so callers never see a
 * Mapbox shape.
 *
 * Mirrors the request shapes the mobile host already used against Mapbox
 * (mobile/src/services/NavigationService.ts): Directions v5 with
 * geometries=polyline6, overview=full, steps=true, banner_instructions=true;
 * Geocoding v6 reverse with types=address,street.
 */
import { createLogger } from "@mentra/cloud-shared";
import type {
  DirectionsRequest,
  LatLng,
  ManeuverKind,
  Route,
  RouteStep,
  RouteAvoidances,
  TravelMode,
} from "../../../protocol/maps";
import type { MapsProvider } from "./provider";

const logger = createLogger("maps").child({ service: "mapbox.maps.provider" });

const DIRECTIONS_BASE = "https://api.mapbox.com/directions/v5/mapbox";
const GEOCODE_REVERSE_URL = "https://api.mapbox.com/search/geocode/v6/reverse";

/** Read + validate the token at call time (not module load) so tests/boot can set it late. */
function getToken(): string {
  const token = process.env.MAPBOX_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "MAPBOX_ACCESS_TOKEN is not set (required for the Mapbox maps provider)",
    );
  }
  return token;
}

/** Our TravelMode -> Mapbox Directions profile. */
function mapboxProfile(mode: TravelMode | undefined): string {
  switch (mode) {
    case "walking":
      return "walking";
    case "cycling":
      return "cycling";
    case "two_wheeler":
      // Mapbox has no two-wheeler profile; driving is the closest match.
      return "driving";
    case "driving":
    default:
      return "driving-traffic";
  }
}

/** Our avoidance flags -> Mapbox `exclude` param value, or null when none apply. */
function mapboxExclude(avoid: RouteAvoidances | undefined): string | null {
  if (!avoid) return null;
  const ex: string[] = [];
  if (avoid.tolls) ex.push("toll");
  if (avoid.ferries) ex.push("ferry");
  if (avoid.highways) ex.push("motorway");
  return ex.length > 0 ? ex.join(",") : null;
}

/** Mapbox maneuver `type` + `modifier` -> our neutral ManeuverKind. */
function mapboxManeuverToKind(
  type: string | undefined,
  modifier: string | undefined,
): ManeuverKind | undefined {
  switch (type) {
    case "depart":
      return "DEPART";
    case "arrive":
      return "ARRIVE";
    case "new name":
      return "NAME_CHANGE";
    case "continue":
      return "CONTINUE";
    default:
      break;
  }
  switch (modifier) {
    case "uturn":
      return "U_TURN";
    case "sharp left":
      return "SHARP_LEFT";
    case "left":
      return "TURN_LEFT";
    case "slight left":
      return "SLIGHT_LEFT";
    case "straight":
      return "STRAIGHT";
    case "slight right":
      return "SLIGHT_RIGHT";
    case "right":
      return "TURN_RIGHT";
    case "sharp right":
      return "SHARP_RIGHT";
    default:
      return undefined;
  }
}

/** Decode a Mapbox precision-6 polyline into [lng,lat]-ordered LatLng points. */
function decodePolyline6(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const factor = 1e6;

  while (index < encoded.length) {
    let result = 1;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / factor, lng: lng / factor });
  }
  return points;
}

/** Pull a road name out of a Mapbox Directions step, preferring the named ref. */
function stepRoad(step: MapboxStep): string | null {
  if (typeof step.name === "string" && step.name.trim().length > 0) {
    return step.name;
  }
  if (typeof step.ref === "string" && step.ref.trim().length > 0) {
    return step.ref;
  }
  return null;
}

// --- Minimal shapes of the Mapbox responses we read -------------------------
// Deliberately narrow: only the fields this provider consumes, so a Mapbox
// response shape change surfaces here rather than leaking outward.

interface MapboxManeuver {
  type?: string;
  modifier?: string;
  instruction?: string;
}
interface MapboxStep {
  distance?: number;
  name?: string;
  ref?: string;
  maneuver?: MapboxManeuver;
  geometry?: string;
}
interface MapboxLeg {
  steps?: MapboxStep[];
}
interface MapboxRoute {
  geometry?: string;
  distance?: number;
  duration?: number;
  legs?: MapboxLeg[];
}
interface MapboxDirectionsResponse {
  routes?: MapboxRoute[];
}

/** Normalize one Mapbox route into our neutral Route. */
function toNeutralRoute(mb: MapboxRoute): Route {
  const points = mb.geometry ? decodePolyline6(mb.geometry) : [];
  const tail = points[points.length - 1];

  const flatSteps: MapboxStep[] = (mb.legs ?? []).flatMap((leg) => leg.steps ?? []);
  const steps: RouteStep[] = flatSteps.map((s, i) => {
    const start = s.geometry ? decodePolyline6(s.geometry)[0] : undefined;
    const next = flatSteps[i + 1];
    const nextStart = next?.geometry ? decodePolyline6(next.geometry)[0] : undefined;
    const lat = start?.lat ?? tail?.lat ?? 0;
    const lng = start?.lng ?? tail?.lng ?? 0;
    return {
      lat,
      lng,
      endLat: nextStart?.lat ?? tail?.lat ?? lat,
      endLng: nextStart?.lng ?? tail?.lng ?? lng,
      distanceMeters: s.distance ?? 0,
      maneuver: mapboxManeuverToKind(s.maneuver?.type, s.maneuver?.modifier),
      instruction: s.maneuver?.instruction,
      road: stepRoad(s),
    };
  });

  return {
    points,
    totalDistanceMeters: mb.distance ?? 0,
    totalDurationSeconds: mb.duration ?? 0,
    steps: steps.length > 0 ? steps : undefined,
  };
}

export function createMapboxProvider(): MapsProvider {
  return {
    name: "mapbox",

    async directions(req: DirectionsRequest): Promise<Route[]> {
      const token = getToken();
      const profile = mapboxProfile(req.mode);
      // Mapbox wants `lng,lat;lng,lat;...` with origin first, then each stop.
      const coords = [req.origin, ...req.stops]
        .map((c) => `${c.lng},${c.lat}`)
        .join(";");

      const params = new URLSearchParams({
        access_token: token,
        geometries: "polyline6",
        overview: "full",
        steps: "true",
        banner_instructions: "true",
        alternatives: String((req.alternatives ?? 1) > 1),
      });
      const exclude = mapboxExclude(req.avoid);
      if (exclude) params.set("exclude", exclude);

      // Walking-only: bias Mapbox's routing toward walkways/footpaths so the
      // route follows the SIDEWALK rather than the road centerline — but ONLY
      // where OSM has the sidewalk mapped as a separate footway. Where it isn't
      // mapped, Mapbox has nothing to bias toward and returns the road as
      // before (no fake offset). `walkway_bias` is a walking-profile-only param;
      // Mapbox rejects it on driving/cycling, so it's gated on the profile.
      if (profile === "walking") {
        params.set("walkway_bias", "1");
      }

      const url = `${DIRECTIONS_BASE}/${profile}/${coords}?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        logger.error({ status: res.status, body }, "mapbox directions request failed");
        throw new Error(`mapbox directions failed: ${res.status}`);
      }
      const data = (await res.json()) as MapboxDirectionsResponse;
      return (data.routes ?? []).map(toNeutralRoute);
    },

    async reverseGeocode(coord: LatLng): Promise<{ road: string | null }> {
      const token = getToken();
      const params = new URLSearchParams({
        access_token: token,
        longitude: String(coord.lng),
        latitude: String(coord.lat),
        types: "address,street",
        limit: "1",
      });
      const url = `${GEOCODE_REVERSE_URL}?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        logger.error({ status: res.status, body }, "mapbox reverse geocode failed");
        throw new Error(`mapbox reverse geocode failed: ${res.status}`);
      }
      const data = (await res.json()) as {
        features?: Array<{
          properties?: {
            name?: string;
            context?: { street?: { name?: string } };
          };
        }>;
      };
      const feature = data.features?.[0]?.properties;
      const road = feature?.context?.street?.name ?? feature?.name ?? null;
      return { road: road ?? null };
    },
  };
}
