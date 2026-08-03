/**
 * NavigationService
 *
 * Thin singleton wrapper around the native Google Navigation SDK exposed
 * by the `crust` Expo module.
 *
 * Mini apps will eventually subscribe through the mini app SDK, which
 * routes via LocalMiniappRuntime and ultimately calls into here. For now,
 * this is also called directly by the developer-settings test button.
 *
 * Works on both Android and iOS via the native GoogleNavigation SDK.
 */

import CrustModule from "@mentra/crust"

import {decodePolyline, parseDurationSeconds} from "./navigation/routesApiCodec"
import {resolveStepRoads} from "./navigation/roadNameResolver"

const LOG_TAG = "NAV_SERVICE"

export type NavManeuver = {
  kind: "maneuver"
  /**
   * Categorical type of the upcoming maneuver. One of: STRAIGHT,
   * SLIGHT_LEFT, SLIGHT_RIGHT, TURN_LEFT, TURN_RIGHT, SHARP_LEFT,
   * SHARP_RIGHT, U_TURN, ARRIVE.
   */
  maneuverType: string
  distanceMeters: number
  /** Road the user is currently on. Null if the SDK didn't supply one. */
  fromRoad?: string | null
  /** Road the user will be on after the maneuver. Null if the SDK didn't supply one. */
  toRoad?: string | null
  distanceToDestinationMeters?: number
  timeToDestinationSeconds?: number
  currentSpeedMps?: number | null
  speedLimitMps?: number | null
  routeHeadingDeg?: number | null
}

export type NavOffRoute = {
  kind: "off_route"
  offRouteDistanceMeters: number
}

export type NavRerouting = {kind: "rerouting"}
export type NavArrived = {kind: "arrived"}
export type NavError = {kind: "error"; message: string}

export type NavUpdate = NavManeuver | NavOffRoute | NavRerouting | NavArrived | NavError

export type NavListener = (update: NavUpdate) => void

export type NavLocation = {
  lat: number
  lng: number
  accuracy: number | null
  timestamp: number
}
export type NavLocationListener = (loc: NavLocation) => void

export type NavRouteStep = {
  lat: number
  lng: number
  routeIndex: number
  road: string | null
  maneuver: string
  distanceMeters: number
}
export type NavRoute = {
  points: Array<{lat: number; lng: number}>
  steps?: NavRouteStep[]
}
export type NavRouteListener = (route: NavRoute) => void

export type NavState = "idle" | "navigating" | "rerouting" | "arrived"

/**
 * Snapshot of the active trip — fed to miniapps that open mid-trip via
 * `navigation.getState()`. Mirrors the SDK's NavState shape closely; the
 * runtime keeps it strictly in sync as nav events arrive.
 */
export type NavTripSnapshot = {
  active: boolean
  mode?: string
  stops?: Array<{lat: number; lng: number}>
  currentStopIndex?: number
  route?: NavRoute
  maneuver?: NavManeuver
  distanceToDestinationMeters?: number
  timeToDestinationSeconds?: number
  currentSpeedMps?: number | null
  speedLimitMps?: number | null
}

class NavigationService {
  private static instance: NavigationService | null = null
  private listeners = new Set<NavListener>()
  private locationListeners = new Set<NavLocationListener>()
  private routeListeners = new Set<NavRouteListener>()
  private subs: Array<{remove: () => void}> = []
  private state: NavState = "idle"
  /** Last emitted route — replayed to late subscribers so they get the
   *  current geometry immediately. */
  private lastRoute: NavRoute | null = null
  /** Last maneuver event observed — used to hydrate getState() on mid-trip mount. */
  private lastManeuver: NavManeuver | null = null
  /** Trip configuration captured at start(), surfaced via getState(). */
  private tripStops: Array<{lat: number; lng: number}> = []
  private tripMode: string = "driving"

  private constructor() {}

  public static getInstance(): NavigationService {
    if (!NavigationService.instance) {
      NavigationService.instance = new NavigationService()
    }
    return NavigationService.instance
  }

  public getState(): NavState {
    return this.state
  }

  public addListener(listener: NavListener): () => void {
    this.listeners.add(listener)
    if (this.subs.length === 0) {
      this.attachNativeSubs()
    }
    return () => {
      this.listeners.delete(listener)
      if (this.noListeners()) {
        this.detachNativeSubs()
      }
    }
  }

  /**
   * Subscribe to the Google Nav SDK's road-snapped location stream. Only
   * fires while a nav session is active. Returns an unsubscribe fn.
   */
  public addLocationListener(listener: NavLocationListener): () => void {
    this.locationListeners.add(listener)
    if (this.subs.length === 0) {
      this.attachNativeSubs()
    }
    return () => {
      this.locationListeners.delete(listener)
      if (this.noListeners()) {
        this.detachNativeSubs()
      }
    }
  }

  /**
   * Subscribe to the active route's polyline. Fires once per route build
   * (initial + after every reroute). Late subscribers get the current
   * route replayed on subscribe so the UI can render immediately.
   */
  public addRouteListener(listener: NavRouteListener): () => void {
    this.routeListeners.add(listener)
    if (this.subs.length === 0) {
      this.attachNativeSubs()
    }
    if (this.lastRoute) {
      try {
        listener(this.lastRoute)
      } catch (err) {
        console.error(`${LOG_TAG}: route listener threw on replay`, err)
      }
    }
    return () => {
      this.routeListeners.delete(listener)
      if (this.noListeners()) {
        this.detachNativeSubs()
      }
    }
  }

  private noListeners(): boolean {
    return this.listeners.size === 0 && this.locationListeners.size === 0 && this.routeListeners.size === 0
  }

  public async start(
    coords: {lat: number; lng: number},
    options?: {
      simulate?: boolean
      speedMultiplier?: number
      stops?: Array<{lat: number; lng: number}>
      mode?: string
      avoid?: {highways?: boolean; tolls?: boolean; ferries?: boolean}
      missedTurnRerouteMeters?: number
    },
  ): Promise<{ok: boolean; error?: string}> {
    console.log(
      `${LOG_TAG}: start ${coords.lat},${coords.lng} sim=${options?.simulate ?? false} speed=${options?.speedMultiplier ?? 5}`,
    )
    if (this.subs.length === 0) {
      // Listeners may attach after start(); make sure native subs exist
      // so we don't drop early events.
      this.attachNativeSubs()
    }
    const result = await CrustModule.startNavigation(coords.lat, coords.lng, {
      simulate: options?.simulate ?? false,
      speedMultiplier: options?.speedMultiplier ?? 5,
      stops: options?.stops,
      mode: options?.mode ?? "driving",
      avoid: options?.avoid,
      missedTurnRerouteMeters: options?.missedTurnRerouteMeters,
    })
    if (!result.ok) {
      console.warn(`${LOG_TAG}: start failed — ${result.error}`)
      this.state = "idle"
      this.tripStops = []
      this.tripMode = "driving"
    } else {
      this.state = "navigating"
      this.tripStops = options?.stops ?? [{lat: coords.lat, lng: coords.lng}]
      this.tripMode = options?.mode ?? "driving"
    }
    return result
  }

  /**
   * Snapshot of the active trip for `navigation.getState()`. Returns null
   * when no trip is running. The snapshot is built from in-memory state
   * fed by the existing native event stream — no extra IPC.
   */
  public getSnapshot(): NavTripSnapshot | null {
    if (this.state === "idle") return null
    const m = this.lastManeuver
    return {
      active: this.state !== "arrived",
      mode: this.tripMode,
      stops: this.tripStops.length > 0 ? this.tripStops : undefined,
      // Single-destination trips: index is always 0 (final stop). The Nav
      // SDK manages waypoint progression internally, so for now we report 0.
      currentStopIndex: 0,
      route: this.lastRoute ?? undefined,
      maneuver: m ?? undefined,
      distanceToDestinationMeters: m?.distanceToDestinationMeters,
      timeToDestinationSeconds: m?.timeToDestinationSeconds,
      currentSpeedMps: m?.currentSpeedMps,
      speedLimitMps: m?.speedLimitMps,
    }
  }

  public async stop(): Promise<{ok: boolean; error?: string}> {
    console.log(`${LOG_TAG}: stop`)
    const result = await CrustModule.stopNavigation()
    this.state = "idle"
    this.lastRoute = null
    this.lastManeuver = null
    this.tripStops = []
    this.tripMode = "driving"
    return result
  }

  /**
   * Trigger the Google Nav SDK Terms & Conditions dialog if the user
   * hasn't accepted yet. Resolves immediately when acceptance is already
   * on file, so it's safe (and intended) to call eagerly on mount.
   */
  public async requestPermission(): Promise<{ok: boolean; accepted: boolean; error?: string}> {
    console.log(`${LOG_TAG}: requestPermission`)
    return await CrustModule.requestNavigationPermission()
  }

  // Dev-only: clear the cached "terms accepted" flags so the next
  // requestPermission() call re-shows Google's dialog. Android only;
  // iOS bridge returns {ok: false, error: "not supported on iOS"}.
  public async resetPermission(): Promise<{ok: boolean; error?: string}> {
    console.log(`${LOG_TAG}: resetPermission`)
    return await CrustModule.resetNavigationPermission()
  }

  /**
   * Dev-only: nudge the simulator off-route to trigger an actual reroute
   * from the Nav SDK. Useful for verifying the rerouting pipeline (UI
   * flips to "Rebuilding route…", route polyline updates, glasses display
   * mirrors the new path). No-op on iOS or with real GPS fixes.
   */
  public async simulateDeviation(offsetMeters: number = 20): Promise<{ok: boolean; error?: string}> {
    console.log(`${LOG_TAG}: simulateDeviation(${offsetMeters}m)`)
    return await CrustModule.simulateDeviation(offsetMeters)
  }

  /**
   * Dev toggle: lock simulated locations onto the wrong sidewalk
   * (perpendicular-right of the route bearing by ~8m). Used to verify
   * the SDK's along-path pivot trigger fires even when the user never
   * comes within the 7m radius of a pivot point. Android-only today; iOS
   * is a no-op stub.
   */
  public async setWrongSidewalkOffset(enabled: boolean): Promise<{ok: boolean; error?: string}> {
    console.log(`${LOG_TAG}: setWrongSidewalkOffset(${enabled})`)
    return await CrustModule.setWrongSidewalkOffset(enabled)
  }

  /**
   * Dev toggle: take over from the Google simulator and walk the user
   * along a modified polyline that skips crossing micro-steps. Lets us
   * reproduce the wrong-sidewalk-then-missed-the-turn scenario for
   * pivot trigger testing. Android-only today; iOS is a no-op stub.
   */
  public async setSkipCrossings(enabled: boolean): Promise<{ok: boolean; error?: string}> {
    console.log(`${LOG_TAG}: setSkipCrossings(${enabled})`)
    return await CrustModule.setSkipCrossings(enabled)
  }

  /**
   * @deprecated Route computation moved to the v2 cloud maps service
   * (cloud.runtime.maps.directions), which holds the provider token
   * server-side and caches results. The miniapp bridge now routes
   * NAVIGATION_COMPUTE_ROUTE to NavigationHandlers -> cloud.maps; this direct
   * Mapbox path is no longer reached from miniapps. Kept only as reference /
   * for any non-bridge caller; do not add new callers.
   *
   * Compute one or more routes without starting a trip. Implemented by
   * calling Mapbox's Directions API (REST) so we don't disturb the active
   * Navigator. Returns `{ok: false}` plus an error string when the engine
   * can't produce a route — mirrors the SDK's ComputeRouteResult shape so
   * the host can pass it back to miniapps unchanged.
   */
  public async computeRoute(payload: Record<string, unknown>): Promise<{
    ok: boolean
    error?: string
    routes?: Array<{
      points: Array<{lat: number; lng: number}>
      totalDistanceMeters: number
      totalDurationSeconds: number
      summary?: string
    }>
  }> {
    return computeRouteViaRoutesApi(payload)
  }

  /**
   * @deprecated Reverse geocoding moved to the v2 cloud maps service
   * (cloud.runtime.maps.reverseGeocode). The miniapp bridge now routes
   * NAVIGATION_REVERSE_GEOCODE to NavigationHandlers -> cloud.maps; this direct
   * Mapbox path is no longer reached from miniapps. Kept only as reference; do
   * not add new callers.
   *
   * Reverse-geocode a coordinate into a short road/route name via
   * Mapbox's Geocoding REST API. Backs the SDK pivot engine's
   * last-resort fallback when a Routes-API instruction didn't carry a
   * parseable road. Returns `{ok: true, road: null}` when the
   * coordinate is genuinely off-grid (mid-park, water) — that's a
   * successful query with no road component, distinct from a failure.
   */
  public async reverseGeocodeRoad(coord: {lat: number; lng: number}): Promise<{
    ok: boolean
    road?: string | null
    error?: string
  }> {
    return reverseGeocodeRoadViaGeocodingApi(coord)
  }

  private attachNativeSubs(): void {
    console.log(`${LOG_TAG}: attachNativeSubs() — listeners=${this.listeners.size}`)
    this.subs.push(
      CrustModule.addListener("onNavManeuver", (data) => {
        this.state = "navigating"
        const event: NavManeuver = {kind: "maneuver", ...data}
        this.lastManeuver = event
        this.fanout(event)
      }),
      CrustModule.addListener("onNavRerouting", () => {
        console.log(`${LOG_TAG}: ← onNavRerouting`)
        this.state = "rerouting"
        this.fanout({kind: "rerouting"})
      }),
      CrustModule.addListener("onNavArrived", () => {
        console.log(`${LOG_TAG}: ← onNavArrived`)
        this.state = "arrived"
        this.lastManeuver = null
        this.fanout({kind: "arrived"})
      }),
      CrustModule.addListener("onNavError", (data) => {
        console.log(`${LOG_TAG}: ← onNavError`, data?.message)
        this.fanout({kind: "error", message: data.message})
      }),
      CrustModule.addListener("onNavLocation", (data) => {
        const loc: NavLocation = {
          lat: data.lat,
          lng: data.lng,
          accuracy: data.accuracy ?? null,
          timestamp: data.timestamp,
        }
        this.locationListeners.forEach((l) => {
          try {
            l(loc)
          } catch (err) {
            console.error(`${LOG_TAG}: location listener threw`, err)
          }
        })
      }),
      CrustModule.addListener("onNavRoute", (data) => {
        const route: NavRoute = {
          points: data.points ?? [],
          steps: data.steps?.map((step) => ({
            ...step,
            road: step.road ?? null,
          })),
        }
        this.lastRoute = route
        console.log(`${LOG_TAG}: ← onNavRoute (${route.points.length} points, steps=${route.steps?.length ?? "null"})`)
        this.routeListeners.forEach((l) => {
          try {
            l(route)
          } catch (err) {
            console.error(`${LOG_TAG}: route listener threw`, err)
          }
        })
      }),
      CrustModule.addListener("onNavOffRoute", (data) => {
        console.log(`${LOG_TAG}: ← onNavOffRoute`, data?.offRouteDistanceMeters)
        this.fanout({kind: "off_route", offRouteDistanceMeters: data?.offRouteDistanceMeters ?? 0})
      }),
    )
  }

  private detachNativeSubs(): void {
    this.subs.forEach((s) => s.remove())
    this.subs = []
  }

  private fanout(update: NavUpdate): void {
    this.listeners.forEach((l) => {
      try {
        l(update)
      } catch (err) {
        console.error(`${LOG_TAG}: listener threw`, err)
      }
    })
  }
}

const navigationService = NavigationService.getInstance()
export default navigationService

// ---------------------------------------------------------------------------
// Routes API (REST)
// ---------------------------------------------------------------------------

// Mapbox migration: Routes + Geocoding now go DIRECT to Mapbox from the
// phone process, authenticated with the public runtime token
// (EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN, inlined at build). No cloud proxy in
// this cut — the token is a public pk.… that's safe to ship; moving it
// server-side (re-introducing the proxy) is a later hardening step. See
// issues/mapbox-navigation-migration.md §8a.
const MAPBOX_DIRECTIONS_BASE = "https://api.mapbox.com/directions/v5/mapbox"
const MAPBOX_GEOCODE_REVERSE = "https://api.mapbox.com/search/geocode/v6/reverse"

/** The public Mapbox token, inlined at build time. Empty in misconfigured builds. */
function mapboxToken(): string {
  return process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN ?? ""
}

/**
 * @deprecated Superseded by the v2 cloud maps service
 * (cloud.runtime.maps.directions). This direct-to-Mapbox call from the device
 * is no longer on the miniapp path; the token now lives server-side. Retained
 * for reference only — do not add new callers.
 *
 * Phone-side helper: hit the Mapbox Directions API directly. Lives here
 * (not in Kotlin) so it's platform-independent across the JS bridge.
 * Returns the SDK-shaped result with primary + alternates.
 *
 * Mapbox Directions differs from Google Routes in shape: numeric
 * `distance`/`duration`, `polyline6` geometry per-route AND per-step, and
 * `maneuver = {location:[lng,lat], type, modifier, instruction}`. We
 * synthesize the SDK's `ComputedRouteStep` (lat/lng start, endLat/endLng
 * = next step's start) from the ordered step list.
 */
async function computeRouteViaRoutesApi(payload: Record<string, unknown>): Promise<{
  ok: boolean
  error?: string
  routes?: Array<{
    points: Array<{lat: number; lng: number}>
    totalDistanceMeters: number
    totalDurationSeconds: number
    summary?: string
    steps?: Array<{
      lat: number
      lng: number
      endLat: number
      endLng: number
      distanceMeters: number
      maneuver?: string
      instruction?: string
      road?: string | null
    }>
  }>
}> {
  const origin = payload.origin as {lat?: unknown; lng?: unknown} | undefined
  const stopsRaw = payload.stops as Array<{lat?: unknown; lng?: unknown}> | undefined
  const mode = (typeof payload.mode === "string" ? payload.mode : "driving").toLowerCase()
  const alt = Number(payload.alternatives)
  const alternatives = Number.isFinite(alt) && alt > 0 ? alt : 1
  const avoid = (payload.avoid as Record<string, unknown> | undefined) ?? {}

  const oLat = Number(origin?.lat)
  const oLng = Number(origin?.lng)
  if (!Number.isFinite(oLat) || !Number.isFinite(oLng)) {
    return {ok: false, error: "computeRoute: origin.lat/lng required"}
  }
  const stops = (Array.isArray(stopsRaw) ? stopsRaw : [])
    .map((s) => ({lat: Number(s?.lat), lng: Number(s?.lng)}))
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
  if (stops.length === 0) {
    return {ok: false, error: "computeRoute: at least one stop required"}
  }

  const token = mapboxToken()
  if (!token) return {ok: false, error: "computeRoute: EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN not set"}

  // Mapbox path is a semicolon-joined `lng,lat` list: origin then each stop.
  const coords = [`${oLng},${oLat}`, ...stops.map((s) => `${s.lng},${s.lat}`)].join(";")
  const exclude = mapboxExclude(avoid)
  const params = new URLSearchParams({
    alternatives: String(alternatives > 1),
    geometries: "polyline6",
    overview: "full",
    steps: "true",
    banner_instructions: "true",
    voice_instructions: "false",
    access_token: token,
  })
  if (exclude) params.set("exclude", exclude)
  const url = `${MAPBOX_DIRECTIONS_BASE}/${mapboxProfile(mode)}/${coords}?${params.toString()}`

  try {
    const res = await fetch(url, {method: "GET"})
    if (!res.ok) {
      return {ok: false, error: `Directions API ${res.status}`}
    }
    const json = (await res.json()) as {
      code?: string
      message?: string
      routes?: Array<{
        geometry?: string
        distance?: number
        duration?: string | number
        weight_name?: string
        legs?: Array<{
          summary?: string
          steps?: Array<{
            geometry?: string
            name?: string
            distance?: number
            maneuver?: {location?: [number, number]; type?: string; modifier?: string; instruction?: string}
          }>
        }>
      }>
    }
    if (json.code && json.code !== "Ok") {
      return {ok: false, error: json.message ?? `Directions code ${json.code}`}
    }
    // Resolve `road` for every step whose Mapbox `name` was blank (slip
    // lanes, unnamed paths, arrival legs) via reverse-geocode. Per-route
    // and per-alternate resolution fire concurrently.
    const routes = await Promise.all(
      (json.routes ?? []).slice(0, alternatives).map(async (r) => {
        const legs = r.legs ?? []
        const flatSteps = legs.flatMap((leg) => leg.steps ?? [])
        const rawSteps = flatSteps.map((s, i) => {
          const here = s.maneuver?.location // [lng, lat]
          const next = flatSteps[i + 1]?.maneuver?.location
          const lat = here?.[1] ?? Number.NaN
          const lng = here?.[0] ?? Number.NaN
          return {
            lat,
            lng,
            // End of step i == start of step i+1; final step ends at itself.
            endLat: next?.[1] ?? lat,
            endLng: next?.[0] ?? lng,
            distanceMeters: Math.round(s.distance ?? 0),
            maneuver: mapboxManeuverToKind(s.maneuver?.type, s.maneuver?.modifier),
            instruction: s.maneuver?.instruction,
            // Mapbox gives the road name inline as `step.name`; prefer it
            // over geocoding. Blank names fall through to resolveStepRoads.
            road: s.name && s.name.trim().length > 0 ? s.name.trim() : undefined,
          }
        })
        const steps = await resolveStepRoads(rawSteps, reverseGeocodeRoadViaGeocodingApi)
        return {
          points: decodePolyline(r.geometry ?? "", 6),
          totalDistanceMeters: Math.round(r.distance ?? 0),
          totalDurationSeconds: parseDurationSeconds(r.duration ?? 0),
          summary: legs[0]?.summary,
          steps: steps.length > 0 ? steps : undefined,
        }
      }),
    )
    if (routes.length === 0) return {ok: false, error: "no routes returned"}
    return {ok: true, routes}
  } catch (err) {
    return {ok: false, error: err instanceof Error ? err.message : "computeRoute failed"}
  }
}

/** SDK-agnostic mode → Mapbox Directions profile. two_wheeler → driving. */
function mapboxProfile(mode: string): string {
  switch (mode) {
    case "walking":
      return "walking"
    case "cycling":
      return "cycling"
    case "two_wheeler":
      return "driving"
    default:
      return "driving-traffic"
  }
}

/** Avoid flags → Mapbox `exclude` param. Null when nothing to exclude. */
function mapboxExclude(avoid: Record<string, unknown>): string | null {
  const ex: string[] = []
  if (avoid.tolls === true) ex.push("toll")
  if (avoid.ferries === true) ex.push("ferry")
  if (avoid.highways === true) ex.push("motorway")
  return ex.length > 0 ? ex.join(",") : null
}

/**
 * Map Mapbox `maneuver.type` + `modifier` to the SDK's ManeuverKind
 * vocabulary — the JS-side mirror of NavigationManager.kt's mapManeuver
 * (issues/mapbox-navigation-migration.md §7). Kept here so the
 * computeRoute preview path labels turns the same way the live trip does.
 */
function mapboxManeuverToKind(type?: string, modifier?: string): string | undefined {
  switch (type) {
    case "depart":
      return "DEPART"
    case "arrive":
      return "ARRIVE"
    case "new name":
      return "NAME_CHANGE"
    case "continue":
    case "merge":
      return "CONTINUE"
    case "notification":
      return "STRAIGHT"
    default:
      break
  }
  switch (modifier) {
    case "uturn":
      return "U_TURN"
    case "sharp left":
      return "SHARP_LEFT"
    case "left":
      return "TURN_LEFT"
    case "slight left":
      return "SLIGHT_LEFT"
    case "straight":
      return "STRAIGHT"
    case "slight right":
      return "SLIGHT_RIGHT"
    case "right":
      return "TURN_RIGHT"
    case "sharp right":
      return "SHARP_RIGHT"
    default:
      return type ? "STRAIGHT" : undefined
  }
}

/**
 * @deprecated Superseded by the v2 cloud maps service
 * (cloud.runtime.maps.reverseGeocode). This direct-to-Mapbox call from the
 * device is no longer on the miniapp path; the token now lives server-side.
 * Retained for reference only — do not add new callers.
 *
 * Reverse-geocode a coordinate via the Mapbox Geocoding v6 API directly and
 * return the road/street name (e.g. "Octavia Blvd"). When no street is
 * present — the coordinate is genuinely off-grid (water, park interior) —
 * resolves with `{ok: true, road: null}`. Network failures and missing
 * token resolve with `{ok: false, error}`.
 *
 * Mapbox v6 returns a GeoJSON FeatureCollection; the street name lives at
 * `features[0].properties.context.street.name`. We also accept a feature
 * whose own `feature_type` is `street` (its `name` is the road). We prefer
 * the most-specific feature (the first), matching how the Google-era code
 * took the first `route` component.
 */
async function reverseGeocodeRoadViaGeocodingApi(coord: {lat: number; lng: number}): Promise<{
  ok: boolean
  road?: string | null
  error?: string
}> {
  if (!Number.isFinite(coord.lat) || !Number.isFinite(coord.lng)) {
    return {ok: false, error: "reverseGeocode: invalid coord"}
  }
  const token = mapboxToken()
  if (!token) return {ok: false, error: "reverseGeocode: EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN not set"}
  const params = new URLSearchParams({
    longitude: String(coord.lng),
    latitude: String(coord.lat),
    // Bias toward address/street features so the street context is present.
    types: "address,street",
    limit: "1",
    access_token: token,
  })
  try {
    const res = await fetch(`${MAPBOX_GEOCODE_REVERSE}?${params.toString()}`, {method: "GET"})
    if (!res.ok) return {ok: false, error: `Geocoding API ${res.status}`}
    const json = (await res.json()) as {
      features?: Array<{
        properties?: {
          feature_type?: string
          name?: string
          context?: {street?: {name?: string}}
        }
      }>
    }
    for (const feature of json.features ?? []) {
      const props = feature.properties
      // A street-type feature's own name is the road; otherwise read the
      // street from context.
      const fromStreetType = props?.feature_type === "street" ? props?.name : undefined
      const name = (fromStreetType ?? props?.context?.street?.name ?? "").trim()
      if (name) return {ok: true, road: name}
    }
    return {ok: true, road: null}
  } catch (err) {
    return {ok: false, error: err instanceof Error ? err.message : "reverseGeocode failed"}
  }
}
