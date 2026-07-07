/**
 * NavigationHandlers — turn-by-turn navigation request handlers for
 * LocalMiniappRuntime. Extracted from LocalMiniappRuntime so the
 * navigation surface (Google Maps Navigation SDK adapter, multi-stop
 * routes, deviation simulator, dev toggles, road-snapped GPS streaming)
 * lives in one file the reviewer can read in isolation.
 *
 * Wire-up: LocalMiniappRuntime owns one instance, constructed with
 * callbacks for sending results / events back to the miniapp. The
 * dispatcher's switch statement delegates each `NAVIGATION_*` case to a
 * handler here. Cross-cutting hooks (cleanup on disconnect, location-
 * stream gating during a trip) are exposed via {@link onDisconnect} and
 * {@link isTripActive}.
 *
 * State owned here:
 *   - navListeners: per-package unsubscribers for the nav-update +
 *     road-snapped-location + route streams. Detached on disconnect,
 *     reattached on the next NAVIGATION_START from the same package.
 *   - activeNavApps: packages with a live nav session. Used by the
 *     dispatcher to gate raw background-GPS forwards (we don't want the
 *     unsnapped fix interleaving with the simulator's snapped output
 *     during a trip).
 */

import {type NavLocation, type NavRoute, type NavUpdate} from "../runtime/config"
import {cloudClientService} from "./CloudClientService"
import navigationService from "./NavigationService"
import {MiniappErrorCode, MiniappResponseType, MiniappStreamType} from "@mentra/miniapp"

const LOG_TAG = "LocalMiniappRuntime"

/**
 * Shape of the per-miniapp envelope sender — matches
 * LocalMiniappRuntime.sendToMiniapp's signature.
 */
type SendToMiniapp = (
  packageName: string,
  envelope: {type: MiniappResponseType; streamType?: MiniappStreamType; data?: unknown},
) => void

/**
 * Shape of the request-result sender — matches
 * LocalMiniappRuntime.sendResult's signature.
 */
type SendResult = (
  packageName: string,
  requestId: string | undefined,
  ok: boolean,
  result?: unknown,
  error?: {code: MiniappErrorCode; message: string},
) => void

export class NavigationHandlers {
  /** packageName → unsubscribe fn for that app's nav event forwarder. */
  private navListeners = new Map<string, () => void>()
  /** Set of packageNames that have called navigation.start() and not yet stop(). */
  private activeNavApps = new Set<string>()

  constructor(
    private readonly sendToMiniapp: SendToMiniapp,
    private readonly sendResult: SendResult,
  ) {}

  /** True iff a trip is currently active for the package (used to gate raw-GPS forwards). */
  isTripActive(packageName: string): boolean {
    return this.activeNavApps.has(packageName)
  }

  /**
   * Detach the per-app nav event forwarder. Called when the mini-app
   * disconnects. The native nav session is left running so the user can
   * reopen the app and reattach without losing their trip; `activeNavApps`
   * is kept intact for the same reason.
   */
  onDisconnect(packageName: string): void {
    const unsub = this.navListeners.get(packageName)
    if (unsub) {
      unsub()
      this.navListeners.delete(packageName)
    }
  }

  async handleStart(packageName: string, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    console.log(`${LOG_TAG}: handleNavigationStart from ${packageName}`, JSON.stringify(payload))

    // v2 wire shape sends `stops`; v1 shape sends bare lat/lng. Accept both.
    const rawStops = payload.stops as Array<{lat?: unknown; lng?: unknown}> | undefined
    const stops: Array<{lat: number; lng: number}> = []
    if (Array.isArray(rawStops)) {
      for (const s of rawStops) {
        const sLat = Number(s?.lat)
        const sLng = Number(s?.lng)
        if (Number.isFinite(sLat) && Number.isFinite(sLng)) stops.push({lat: sLat, lng: sLng})
      }
    }
    if (stops.length === 0) {
      const lat = Number(payload.lat)
      const lng = Number(payload.lng)
      if (Number.isFinite(lat) && Number.isFinite(lng)) stops.push({lat, lng})
    }
    if (stops.length === 0) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: "stops or lat/lng required",
      })
      return
    }
    const lat = stops[0].lat
    const lng = stops[0].lng
    const simulate = payload.simulate === true
    const speedNum = Number(payload.speedMultiplier)
    const speedMultiplier = Number.isFinite(speedNum) && speedNum > 0 ? speedNum : 5
    const mode = typeof payload.mode === "string" ? payload.mode : "driving"
    const avoidRaw = payload.avoid as Record<string, unknown> | undefined
    const avoid = avoidRaw
      ? {
          highways: avoidRaw.highways === true,
          tolls: avoidRaw.tolls === true,
          ferries: avoidRaw.ferries === true,
        }
      : undefined
    const missedRaw = Number(payload.missedTurnRerouteMeters)
    const missedTurnRerouteMeters = Number.isFinite(missedRaw) && missedRaw > 0 ? missedRaw : undefined

    const navigation = navigationService
    if (!navigation) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: "navigation adapter not configured on host",
      })
      return
    }

    // Reattach the per-app event forwarder (it may have been detached when the
    // mini-app closed its UI without stopping the trip).
    if (!this.navListeners.has(packageName)) {
      const unsubNav = navigation.addListener((update: NavUpdate) => {
        this.sendToMiniapp(packageName, {
          type: MiniappResponseType.EVENT,
          streamType: MiniappStreamType.NAVIGATION_UPDATE,
          data: update,
        })
        // Trip ended naturally — keep the forwarder alive (miniapp may
        // restart nav) but remove from active set so stop() accounting
        // stays accurate.
        if (update.kind === "arrived" || update.kind === "error") {
          this.activeNavApps.delete(packageName)
        }
      })
      // Forward the nav-SDK's road-snapped GPS fixes as a location_update
      // stream, so the miniapp's existing session.events.onLocation(...) just
      // works while a trip is active.
      const unsubLoc = navigation.addLocationListener((loc: NavLocation) => {
        this.sendToMiniapp(packageName, {
          type: MiniappResponseType.EVENT,
          streamType: MiniappStreamType.LOCATION_UPDATE,
          data: {
            lat: loc.lat,
            lng: loc.lng,
            accuracy: loc.accuracy ?? undefined,
            timestamp: loc.timestamp,
          },
        })
      })
      const unsubRoute = navigation.addRouteListener((route: NavRoute) => {
        this.sendToMiniapp(packageName, {
          type: MiniappResponseType.EVENT,
          streamType: MiniappStreamType.NAVIGATION_ROUTE,
          data: route,
        })
      })
      this.navListeners.set(packageName, () => {
        unsubNav()
        unsubLoc()
        unsubRoute()
      })
    }

    // If a trip is already active for this app (user closed the UI and came
    // back), reuse the running session — replay current snapshot and return
    // ok without restarting the native navigator.
    if (this.activeNavApps.has(packageName) && navigation.getState() !== "idle") {
      console.log(`${LOG_TAG}: resuming existing nav session for ${packageName}`)
      const snapshot = navigation.getSnapshot()
      this.sendResult(packageName, requestId, true, {ok: true, resumed: true, snapshot})
      return
    }

    try {
      const result = await navigation.start(
        {lat, lng},
        {simulate, speedMultiplier, stops, mode, avoid, missedTurnRerouteMeters},
      )
      if (result.ok) {
        this.activeNavApps.add(packageName)
      }
      this.sendResult(packageName, requestId, result.ok, result, undefined)
    } catch (err) {
      console.error(`${LOG_TAG}: navigation start error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "navigation start error",
      })
    }
  }

  async handleStop(packageName: string, requestId?: string): Promise<void> {
    try {
      const unsub = this.navListeners.get(packageName)
      if (unsub) {
        unsub()
        this.navListeners.delete(packageName)
      }
      this.activeNavApps.delete(packageName)
      // Only stop the native trip when no other miniapp is still navigating.
      if (this.activeNavApps.size === 0) {
        const navigation = navigationService
        const result = navigation ? await navigation.stop() : {ok: true}
        this.sendResult(packageName, requestId, result.ok, result, undefined)
      } else {
        this.sendResult(packageName, requestId, true, {ok: true}, undefined)
      }
    } catch (err) {
      console.error(`${LOG_TAG}: navigation stop error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "navigation stop error",
      })
    }
  }

  async handleDeviate(packageName: string, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    try {
      const offsetNum = Number(payload.offsetMeters)
      const offsetMeters = Number.isFinite(offsetNum) && offsetNum > 0 ? offsetNum : 20
      const navigation = navigationService
      const result = navigation
        ? await navigation.simulateDeviation(offsetMeters)
        : {ok: false, error: "navigation adapter not configured"}
      this.sendResult(packageName, requestId, result.ok, result, undefined)
    } catch (err) {
      console.error(`${LOG_TAG}: navigation deviate error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "navigation deviate error",
      })
    }
  }

  async handleSetWrongSidewalk(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    try {
      const enabled = payload.enabled === true
      const navigation = navigationService
      const result = navigation
        ? await navigation.setWrongSidewalkOffset(enabled)
        : {ok: false, error: "navigation adapter not configured"}
      this.sendResult(packageName, requestId, result.ok, result, undefined)
    } catch (err) {
      console.error(`${LOG_TAG}: navigation setWrongSidewalkOffset error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "navigation setWrongSidewalkOffset error",
      })
    }
  }

  async handleSetSkipCrossings(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    try {
      const enabled = payload.enabled === true
      const navigation = navigationService
      const result = navigation
        ? await navigation.setSkipCrossings(enabled)
        : {ok: false, error: "navigation adapter not configured"}
      this.sendResult(packageName, requestId, result.ok, result, undefined)
    } catch (err) {
      console.error(`${LOG_TAG}: navigation setSkipCrossings error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "navigation setSkipCrossings error",
      })
    }
  }

  handleGetState(packageName: string, requestId?: string): void {
    const snapshot = navigationService.getSnapshot() ?? null
    this.sendResult(packageName, requestId, true, {state: snapshot})
  }

  async handleRequestPermission(packageName: string, requestId?: string): Promise<void> {
    try {
      const navigation = navigationService
      const result = navigation
        ? await navigation.requestPermission()
        : {ok: false, accepted: false, error: "navigation adapter not configured"}
      this.sendResult(packageName, requestId, true, result)
    } catch (err) {
      console.error(`${LOG_TAG}: navigation requestPermission error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "navigation requestPermission error",
      })
    }
  }

  async handleComputeRoute(packageName: string, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    try {
      // Computed in the v2 cloud (provider-abstracted maps service). The SDK
      // payload shape ({origin, stops, mode, avoid, alternatives}) is the v2
      // DirectionsRequest field-for-field, so it passes straight through. The
      // direct-Mapbox path in NavigationService is deprecated.
      const {routes} = await cloudClientService.maps.directions(payload as never)
      this.sendResult(packageName, requestId, true, {ok: true, routes})
    } catch (err) {
      console.error(`${LOG_TAG}: navigation computeRoute error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "navigation computeRoute error",
      })
    }
  }

  /**
   * Reverse-geocode a coordinate into a short road name + full formatted
   * address. Backs the SDK pivot engine's road-name fallback (`road`) and the
   * navigation miniapp's dropped-pin / POI-tap labels (`address`). Always
   * resolves with `{ok, road?, address?}` — a missing road/address is
   * `{ok: true, road: null, address: null}`, not an error.
   */
  async handleReverseGeocode(packageName: string, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    try {
      const lat = Number(payload.lat)
      const lng = Number(payload.lng)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.INTERNAL,
          message: "lat/lng required",
        })
        return
      }
      // Resolved in the v2 cloud (provider-abstracted maps service). The
      // direct-Mapbox geocoding path in NavigationService is deprecated.
      const {road, address} = await cloudClientService.maps.reverseGeocode({lat, lng})
      this.sendResult(packageName, requestId, true, {ok: true, road, address})
    } catch (err) {
      console.error(`${LOG_TAG}: navigation reverseGeocode error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "navigation reverseGeocode error",
      })
    }
  }

  /**
   * Type-ahead place search. Proxies to the v2 cloud maps service (Mapbox
   * Search Box today). Resolves `{ok: true, suggestions}` — an empty query or no
   * matches is `{ok: true, suggestions: []}`, not an error.
   */
  async handlePlaceAutocomplete(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    try {
      const query = typeof payload.query === "string" ? payload.query : ""
      const sessionToken = typeof payload.sessionToken === "string" ? payload.sessionToken : ""
      const near = this.parseNear(payload.near)

      const {suggestions} = await cloudClientService.maps.placeAutocomplete({query, near, sessionToken})
      this.sendResult(packageName, requestId, true, {ok: true, suggestions})
    } catch (err) {
      console.error(`${LOG_TAG}: navigation placeAutocomplete error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "navigation placeAutocomplete error",
      })
    }
  }

  /**
   * Resolve a suggestion (`placeId` + `sessionToken`) to a full place with
   * coordinates, via the v2 cloud maps service. Resolves `{ok: true, place}`.
   */
  async handlePlaceDetails(packageName: string, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    try {
      const placeId = typeof payload.placeId === "string" ? payload.placeId : ""
      const sessionToken = typeof payload.sessionToken === "string" ? payload.sessionToken : ""
      if (!placeId) {
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.INTERNAL,
          message: "placeId required",
        })
        return
      }

      const place = await cloudClientService.maps.placeDetails({placeId, sessionToken})
      this.sendResult(packageName, requestId, true, {ok: true, place})
    } catch (err) {
      console.error(`${LOG_TAG}: navigation placeDetails error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "navigation placeDetails error",
      })
    }
  }

  /** Coerce an inbound `near` payload to a {lat,lng}, or undefined when absent/invalid. */
  private parseNear(raw: unknown): {lat: number; lng: number} | undefined {
    if (!raw || typeof raw !== "object") return undefined
    const obj = raw as Record<string, unknown>
    const lat = Number(obj.lat)
    const lng = Number(obj.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined
    return {lat, lng}
  }
}
