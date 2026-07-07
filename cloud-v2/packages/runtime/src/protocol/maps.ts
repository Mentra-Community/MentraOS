/**
 * @fileoverview Canonical maps wire types: directions + reverse geocoding.
 *
 * zod schemas + inferred TS types for the maps service. Both flows are plain
 * REST request/result (no WebSocket push, unlike camera), so nothing here is
 * registered into the message union. Pure + isomorphic: no server imports, safe
 * to bundle into the client.
 *
 * The vocabulary (TravelMode, ManeuverKind, avoidances, the route/step shapes)
 * deliberately mirrors the mobile miniapp navigation SDK
 * (mobile/modules/miniapp/src/modules/navigation.ts) so the contract is identical
 * end-to-end: miniapp SDK <-> cloud-client <-> runtime. These are the PROVIDER-
 * NEUTRAL types; each provider (Mapbox, Google) normalizes its own response into
 * these inside its provider file, so this contract never leaks a vendor's shape.
 *
 * See docs/issues/002-cloud-runtime/maps/spec.md.
 */
import { z } from "zod";

// --- Shared geometry --------------------------------------------------------

export const latLngSchema = z.object({
  lat: z.number(),
  lng: z.number(),
});
export type LatLng = z.infer<typeof latLngSchema>;

/** Travel profile. Providers map this to their own profile vocabulary. */
export const travelModeSchema = z.enum(["walking", "driving", "cycling", "two_wheeler"]);
export type TravelMode = z.infer<typeof travelModeSchema>;

/** Routing preferences. All flags default to false. */
export const routeAvoidancesSchema = z.object({
  highways: z.boolean().optional(),
  tolls: z.boolean().optional(),
  ferries: z.boolean().optional(),
});
export type RouteAvoidances = z.infer<typeof routeAvoidancesSchema>;

/**
 * Neutral maneuver vocabulary. Each provider maps its own maneuver type/modifier
 * vocabulary into exactly these values; consumers never see vendor strings.
 */
export const maneuverKindSchema = z.enum([
  "STRAIGHT",
  "CONTINUE",
  "SLIGHT_LEFT",
  "SLIGHT_RIGHT",
  "TURN_LEFT",
  "TURN_RIGHT",
  "SHARP_LEFT",
  "SHARP_RIGHT",
  "U_TURN",
  "NAME_CHANGE",
  "DEPART",
  "ARRIVE",
  "CROSS_STREET",
]);
export type ManeuverKind = z.infer<typeof maneuverKindSchema>;

// --- Directions -------------------------------------------------------------

export const directionsRequestSchema = z.object({
  origin: latLngSchema,
  /** Ordered stops; last is the final destination. Must have >= 1 entry. */
  stops: z.array(latLngSchema).min(1),
  /** Defaults to "driving" when omitted. */
  mode: travelModeSchema.optional(),
  avoid: routeAvoidancesSchema.optional(),
  /**
   * Total number of routes to return — the primary plus any alternates, provider
   * permitting. 1 (the default) means the primary route only, no alternates; a
   * value > 1 asks the provider for alternates. (Mirrors the prior on-device
   * behavior: Mapbox `alternatives` is requested only when this exceeds 1.)
   */
  alternatives: z.number().int().positive().optional(),
});
export type DirectionsRequest = z.infer<typeof directionsRequestSchema>;

/** One step of a computed route. The maneuver ENDS the segment. */
export const routeStepSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  endLat: z.number(),
  endLng: z.number(),
  distanceMeters: z.number(),
  maneuver: maneuverKindSchema.optional(),
  /** Full instruction from the provider (e.g. "Turn left onto Fell St"). */
  instruction: z.string().optional(),
  /** Resolved road name. Prefer this over parsing `instruction`. */
  road: z.string().nullable().optional(),
});
export type RouteStep = z.infer<typeof routeStepSchema>;

export const routeSchema = z.object({
  points: z.array(latLngSchema),
  totalDistanceMeters: z.number(),
  totalDurationSeconds: z.number(),
  summary: z.string().optional(),
  steps: z.array(routeStepSchema).optional(),
});
export type Route = z.infer<typeof routeSchema>;

/** The REST response for `POST /api/maps/directions`. Primary route first. */
export const directionsResultSchema = z.object({
  routes: z.array(routeSchema),
});
export type DirectionsResult = z.infer<typeof directionsResultSchema>;

// --- Reverse geocoding ------------------------------------------------------

export const reverseGeocodeRequestSchema = latLngSchema;
export type ReverseGeocodeRequest = z.infer<typeof reverseGeocodeRequestSchema>;

/**
 * The REST response for `POST /api/maps/reverse-geocode`.
 *
 * - `road`    — short street name (e.g. "Hayes Street"). Backs the pivot
 *   engine's road-name fallback.
 * - `address` — full formatted street address with house number + locality
 *   (e.g. "369 Hayes Street, San Francisco, California 94102"). Backs the
 *   navigation miniapp's dropped-pin / POI-tap labels.
 *
 * Either field is null when nothing of that kind was found near the coordinate;
 * that is a successful empty answer, not an error (an actual failure is a
 * non-2xx response).
 */
export const reverseGeocodeResultSchema = z.object({
  road: z.string().nullable(),
  address: z.string().nullable(),
});
export type ReverseGeocodeResult = z.infer<typeof reverseGeocodeResultSchema>;

// --- Place search (autocomplete + details) ----------------------------------
//
// A two-step "type-ahead then pick" flow, provider-neutral like the rest of this
// file. `placeAutocomplete` lists lightweight suggestions as the user types;
// `placeDetails` resolves the chosen suggestion to coordinates. A `sessionToken`
// threads BOTH calls so the provider can bill the keystrokes + the final detail
// fetch as ONE search session (Mapbox Search Box and Google Places both work
// this way). Callers create one token per "search box opening" and rotate it
// after a pick.

export const placeAutocompleteRequestSchema = z.object({
  /** The user's partial query. Empty/whitespace yields no suggestions. */
  query: z.string(),
  /** Optional location bias — rank results near this coordinate. */
  near: latLngSchema.optional(),
  /** Opaque per-search-session token; the same value should go on `placeDetails`. */
  sessionToken: z.string(),
});
export type PlaceAutocompleteRequest = z.infer<typeof placeAutocompleteRequestSchema>;

/** One type-ahead suggestion. `placeId` is fed back into `placeDetails`. */
export const placeSuggestionSchema = z.object({
  placeId: z.string(),
  /** Primary line, e.g. "Blue Bottle Coffee". */
  mainText: z.string(),
  /** Secondary line, e.g. "66 Mint St, San Francisco". Empty when none. */
  secondaryText: z.string(),
});
export type PlaceSuggestion = z.infer<typeof placeSuggestionSchema>;

export const placeAutocompleteResultSchema = z.object({
  suggestions: z.array(placeSuggestionSchema),
});
export type PlaceAutocompleteResult = z.infer<typeof placeAutocompleteResultSchema>;

export const placeDetailsRequestSchema = z.object({
  /** A `placeId` returned by a prior `placeAutocomplete` suggestion. */
  placeId: z.string(),
  /** The same session token used for the autocomplete that produced this id. */
  sessionToken: z.string(),
});
export type PlaceDetailsRequest = z.infer<typeof placeDetailsRequestSchema>;

/** The resolved place: a name, formatted address, and coordinates to route to. */
export const placeDetailsResultSchema = z.object({
  placeId: z.string(),
  name: z.string(),
  address: z.string(),
  lat: z.number(),
  lng: z.number(),
});
export type PlaceDetailsResult = z.infer<typeof placeDetailsResultSchema>;
