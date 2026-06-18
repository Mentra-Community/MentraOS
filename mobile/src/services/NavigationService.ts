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
import restComms from "./RestComms"
import {useSettingsStore} from "@/stores/settings"

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
    return (
      this.listeners.size === 0 &&
      this.locationListeners.size === 0 &&
      this.routeListeners.size === 0
    )
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
   * Compute one or more routes without starting a trip. Implemented by
   * calling Google's Routes API (REST) so we don't disturb the active
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
   * Reverse-geocode a coordinate into a short road/route name via
   * Google's Geocoding REST API. Backs the SDK pivot engine's
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

// Web-service calls (Routes + Geocoding) go through the MentraOS cloud, which
// holds the Google web-service key server-side. The key is never shipped in the
// app — only the on-device Navigation SDK key lives here (in the native
// manifest/Info.plist), locked down by application restriction in GCP.
const NAV_ROUTE_ENDPOINT = "/api/client/navigation/route"
const NAV_REVERSE_GEOCODE_ENDPOINT = "/api/client/navigation/reverse-geocode"

/**
 * Auth header + absolute URL for a cloud navigation endpoint. Uses the same
 * core token and backend base URL as RestComms so these calls follow whichever
 * backend the app is pointed at (local/staging/prod).
 */
function navCloudRequest(endpoint: string): {url: string; headers: Record<string, string>} | null {
  const token = restComms.getCoreToken()
  if (!token) return null
  const baseUrl = useSettingsStore.getState().getRestUrl()
  return {
    url: `${baseUrl}${endpoint}`,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
  }
}

/**
 * Phone-side helper: hit Google Routes API directly. Lives here (not in
 * Kotlin) because the API key is already exposed via env to the WebView,
 * and going through the JS bridge keeps this independent of which
 * platform the user is on. Returns the SDK-shaped result with primary +
 * alternates.
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

  const req = navCloudRequest(NAV_ROUTE_ENDPOINT)
  if (!req) return {ok: false, error: "computeRoute: not authenticated"}

  const finalDest = stops[stops.length - 1]
  const intermediates = stops.slice(0, -1).map((s) => ({location: {latLng: {latitude: s.lat, longitude: s.lng}}}))
  const body: Record<string, unknown> = {
    origin: {location: {latLng: {latitude: oLat, longitude: oLng}}},
    destination: {location: {latLng: {latitude: finalDest.lat, longitude: finalDest.lng}}},
    travelMode: routesApiTravelMode(mode),
    computeAlternativeRoutes: alternatives > 1,
    routeModifiers: {
      avoidHighways: avoid.highways === true,
      avoidTolls: avoid.tolls === true,
      avoidFerries: avoid.ferries === true,
    },
    // Without this Google defaults to OVERVIEW — sparse polyline with
    // vertices that drift 10-20m from actual road centerlines at
    // intersections, putting our turn-pivot dots off the visible roads.
    // HIGH_QUALITY traces the road tightly.
    polylineQuality: "HIGH_QUALITY",
  }
  if (intermediates.length > 0) body.intermediates = intermediates

  try {
    // The cloud proxy adds the Google web-service key and the X-Goog-FieldMask
    // server-side, then returns the Routes API JSON unchanged.
    const res = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      return {ok: false, error: `Routes API ${res.status}`}
    }
    const json = (await res.json()) as {
      routes?: Array<{
        polyline?: {encodedPolyline?: string}
        distanceMeters?: number
        duration?: string
        description?: string
        legs?: Array<{
          steps?: Array<{
            startLocation?: {latLng?: {latitude?: number; longitude?: number}}
            endLocation?: {latLng?: {latitude?: number; longitude?: number}}
            distanceMeters?: number
            navigationInstruction?: {maneuver?: string; instructions?: string}
          }>
        }>
      }>
    }
    // Resolve `road` for every step in each route before returning. The
    // resolver hits Geocoding API for steps whose instruction had no
    // road name (slip lanes, "Slight right", "Destination ahead"). All
    // resolutions per route fire concurrently; alternates resolve in
    // parallel too. Adds latency proportional to the number of unnamed
    // steps — typically 1-3 per walking route in dense urban areas.
    const routes = await Promise.all(
      (json.routes ?? []).slice(0, alternatives).map(async (r) => {
        const rawSteps = (r.legs ?? []).flatMap((leg) =>
          (leg.steps ?? []).map((s) => ({
            lat: s.startLocation?.latLng?.latitude ?? Number.NaN,
            lng: s.startLocation?.latLng?.longitude ?? Number.NaN,
            endLat: s.endLocation?.latLng?.latitude ?? Number.NaN,
            endLng: s.endLocation?.latLng?.longitude ?? Number.NaN,
            distanceMeters: s.distanceMeters ?? 0,
            maneuver: s.navigationInstruction?.maneuver,
            instruction: s.navigationInstruction?.instructions,
          })),
        )
        const steps = await resolveStepRoads(rawSteps, reverseGeocodeRoadViaGeocodingApi)
        return {
          points: decodePolyline(r.polyline?.encodedPolyline ?? ""),
          totalDistanceMeters: r.distanceMeters ?? 0,
          totalDurationSeconds: parseDurationSeconds(r.duration ?? ""),
          summary: r.description,
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

function routesApiTravelMode(mode: string): string {
  switch (mode) {
    case "walking":
      return "WALK"
    case "cycling":
      return "BICYCLE"
    case "two_wheeler":
      return "TWO_WHEELER"
    default:
      return "DRIVE"
  }
}

/**
 * Reverse-geocode a coordinate via the MentraOS cloud (which proxies Google's
 * Geocoding REST API with the server-side key) and return the short name of the
 * `route` address component (e.g. "Octavia Blvd"). When no route component is
 * present in any of the returned results — the coordinate is genuinely off-grid
 * (water, park interior) — resolves with `{ok: true, road: null}`. Network
 * failures and missing auth resolve with `{ok: false, error}`.
 *
 * The cloud applies `result_type=route` and returns the Geocoding JSON
 * unchanged; we rely on Google to default-order results from most-specific to
 * least, then take the first `route` we encounter.
 */
async function reverseGeocodeRoadViaGeocodingApi(coord: {lat: number; lng: number}): Promise<{
  ok: boolean
  road?: string | null
  error?: string
}> {
  if (!Number.isFinite(coord.lat) || !Number.isFinite(coord.lng)) {
    return {ok: false, error: "reverseGeocode: invalid coord"}
  }
  const req = navCloudRequest(NAV_REVERSE_GEOCODE_ENDPOINT)
  if (!req) return {ok: false, error: "reverseGeocode: not authenticated"}
  try {
    const res = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify({lat: coord.lat, lng: coord.lng}),
    })
    if (!res.ok) return {ok: false, error: `Geocoding API ${res.status}`}
    const json = (await res.json()) as {
      status?: string
      results?: Array<{
        address_components?: Array<{short_name?: string; long_name?: string; types?: string[]}>
      }>
    }
    if (json.status && json.status !== "OK" && json.status !== "ZERO_RESULTS") {
      return {ok: false, error: `Geocoding API status ${json.status}`}
    }
    // First "route" component in the first result is the road name we want.
    // Prefer short_name ("Octavia Blvd" over "Octavia Boulevard").
    for (const result of json.results ?? []) {
      for (const comp of result.address_components ?? []) {
        if ((comp.types ?? []).includes("route")) {
          const name = (comp.short_name ?? comp.long_name ?? "").trim()
          if (name) return {ok: true, road: name}
        }
      }
    }
    return {ok: true, road: null}
  } catch (err) {
    return {ok: false, error: err instanceof Error ? err.message : "reverseGeocode failed"}
  }
}

