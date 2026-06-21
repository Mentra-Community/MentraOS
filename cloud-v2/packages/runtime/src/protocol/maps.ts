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
  /** Up to N alternate routes (provider permitting). Default 1. */
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
 * The REST response for `POST /api/maps/reverse-geocode`. `road` is null when no
 * road was found near the coordinate; that is a successful empty answer, not an
 * error (an actual failure is a non-2xx response).
 */
export const reverseGeocodeResultSchema = z.object({
  road: z.string().nullable(),
});
export type ReverseGeocodeResult = z.infer<typeof reverseGeocodeResultSchema>;
