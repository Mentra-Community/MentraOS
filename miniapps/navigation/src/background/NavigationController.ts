/**
 * NavigationController — the always-on logic for the Mentra Map
 * miniapp. Owns MiniappSession subscriptions, trip state, the glasses
 * HUD logic, storage reads/writes, and Places REST. Lives for the
 * entire session — closing the WebView does NOT stop navigation.
 *
 * The UI WebView is a thin renderer fed via session.ui.send and the
 * UI's mentra.send / mentra.request bus declared in shared/channels.ts.
 */

import type {
  MiniappSession,
  NavRoute,
  NavUpdate,
  Pivot,
  StartNavigationOptions,
  UIModule,
} from "@mentra/miniapp/background"

import type {Channels} from "../shared/channels"
import type {Coords, DevSettings, LogEntry, NavSnapshot, TripState, UnitSystem} from "../shared/types"

import {CompassManager} from "./managers/CompassManager"
import {DisplayManager} from "./managers/DisplayManager"
import {LocationManager} from "./managers/LocationManager"
import {NavigationManager} from "./managers/NavigationManager"
import {PlacesManager} from "./managers/PlacesManager"
import {SimpleStorageManager} from "./managers/SimpleStorageManager"
import {formatDistance} from "./lib/formatDistance"
import {distanceToPolylineMeters, haversineMeters, remainingRouteMeters, sideOfFinalSegment, type LatLng} from "./lib/geometry"
import {TEST_BITMAP_288_B64} from "./lib/testBitmap"
import {buildOsmLineMap, fetchOsmRoads, renderOsmLineMap} from "./lib/OsmLineMapRenderer"

export class NavigationController {
  private readonly ui: UIModule<Channels>
  private readonly location: LocationManager
  private readonly compass: CompassManager
  private readonly display: DisplayManager
  private readonly navigation: NavigationManager
  private readonly storage: SimpleStorageManager
  private readonly places: PlacesManager

  // PoC OSM map: current view center, mutated by the pan buttons. Starts at
  // Hayes Valley, SF.
  private osmMapCenter = {lat: 37.7766853, lng: -122.4229361}
  private readonly OSM_MAP_SIZE = 88
  private readonly OSM_MAP_RADIUS_M = 133

  private unsubs: Array<() => void> = []
  private started = false
  private logSeq = 0
  private lastHudKey = ""
  private lastMinimapPng: string | null = null
  private showMinimap = false
  // OSM-roads minimap cache: roads fetched around a center, reused while the
  // user stays near it (re-fetch only when they move past a threshold).
  private osmRoadsCache: LatLng[][] | null = null
  private osmRoadsCenter: LatLng | null = null
  private osmFetchInFlight = false
  private lastCoordsAt = 0
  private gettingFix = false
  // Tracks whether a trip has completed (arrived or stopped) in this
  // session. Used to suppress the "Welcome to Mentra Maps!" message
  // after the first arrival — the welcome line should only show at
  // the very start of the session, not every time the user finishes
  // and returns to idle.
  private hasCompletedTrip = false

  // Last logged threshold bucket for the off-route diagnostic so we
  // only print on crossings, not every coord update.
  // 0 = under OFF_ROUTE_ADVISORY_M, 1 = advisory band, 2 = ≥OFF_ROUTE_TRIGGER_M.
  private lastOffRouteBucket = 0

  // True while the user is in the 15–30m advisory band. Drives the
  // glasses HUD's "Go back to route" frame between the moment we
  // notice the drift and the moment auto-rebuild kicks in at 30m.
  // Cleared when we return under 15m or when status flips to
  // rerouting (>=30m crossing).
  private offRouteAdvisory = false
  // Live perpendicular distance to the route while in the advisory
  // band. Refreshed on every coord tick (not just bucket transitions)
  // so the HUD's "Go back 10m" countdown ticks down as the user
  // moves toward the route. Null when not in the band.
  private offRouteAdvisoryDistanceM: number | null = null

  // Trip-start anchor: position recorded at trip start, used to gate
  // auto-rebuilds. Suppresses the "user is inside a 50m-radius building"
  // case where the initial fix is already >30m off-route — until the
  // user has moved >REBUILD_MIN_MOVE_M from the start point, we won't
  // auto-rebuild.
  private tripStartCoords: {lat: number; lng: number} | null = null
  // Last StartNavigationOptions so an auto-rebuild can re-fire the same
  // mode / simulate / speedMultiplier without the UI having to re-send.
  private lastStartOpts: (StartNavigationOptions & {destinationName?: string}) | null = null
  // Cooldown: timestamp of the last auto-rebuild. Suppresses back-to-
  // back rebuilds while a fresh route is still being computed.
  private lastAutoRebuildAt = 0
  // Pending auto-rebuild timer. When we cross >30m we don't rebuild
  // immediately — we flip the HUD to "Rebuilding route…" and wait
  // REBUILD_DELAY_MS, then re-check distance and either fire or
  // cancel. Tracked so we can cancel it on stop/arrived/dispose and
  // ignore further bucket-2 transitions while one is already pending.
  private pendingRebuildTimer: ReturnType<typeof setTimeout> | null = null

  // Canonical state (mirrored to UI).
  private coords: Coords | null = null
  private heading: number | null = null
  private trip: TripState = {
    status: "idle",
    running: false,
    maneuver: null,
    activeDestination: null,
    activeDestinationName: null,
    routePoints: null,
    routeSteps: null,
    offRouteAt: null,
    arrivalSide: null,
  }
  private activePivot: Pivot | null = null
  private upcomingPivot: Pivot | null = null
  private log: LogEntry[] = []
  private devSettings: DevSettings = {
    simulate: false,
    speedMultiplier: 5,
    wrongSidewalk: false,
    skipCrossings: false,
    useRawInstructions: true,
  }

  // User's distance-unit preference. Loaded from storage in start() and
  // mirrored into every snapshot. Drives formatDistance() across the
  // glasses HUD and (via the snapshot) the UI. Defaults to metric until
  // the stored value loads.
  private unitSystem: UnitSystem = "metric"

  // Cached raw Google `navigationInstruction.instructions` strings, in
  // step order, from the most recent successful Routes API call. Drives
  // the `useRawInstructions` debug toggle — the live SDK doesn't carry
  // these through `NavStep`, so we zip the cached array into the live
  // step list by index. Refetched on reroute (see onRoute handler) so
  // the toggle keeps working after the route changes.
  private cachedInstructions: string[] | null = null
  // Guards against parallel refetches when the SDK fires multiple
  // onRoute events in quick succession during a reroute.
  private refetchingInstructions = false

  constructor(private readonly session: MiniappSession) {
    this.ui = session.ui as unknown as UIModule<Channels>
    this.location = new LocationManager(session)
    this.compass = new CompassManager(session)
    this.display = new DisplayManager(session)
    this.navigation = new NavigationManager(session)
    this.storage = new SimpleStorageManager(session)
    // session.userId carries the logged-in user when a real session backs the
    // miniapp; PlacesManager forwards it to the proxy as X-User-Email (with a
    // placeholder fallback when it's empty).
    this.places = new PlacesManager(session.userId)
  }

  start(): void {
    if (this.started) return
    this.started = true

    this.wireSensorSubscriptions()
    this.wireRpcHandlers()
    this.wireUIBroadcasts()
    this.wireHUDPump()
    this.primeNavigationPermission()
    this.seedInitialFix()
    this.loadUnitSystem()

    this.session.onBeforeDisconnect(() => this.dispose())
  }

  // ── Sensor → state pump ──────────────────────────────────────────────

  private wireSensorSubscriptions(): void {
    // Location
    this.unsubs.push(
      this.location.onUpdate((d) => {
        this.coords = {
          lat: d.lat,
          lng: d.lng,
          accuracy: d.accuracy,
          ts: d.timestamp ?? Date.now(),
        }
        this.lastCoordsAt = Date.now()
        this.ui.send("nav:coords", this.coords)
        this.logOffRouteThresholds()
        this.maybeFireEarlyArrival()
        this.refreshHUD()
      }),
    )

    // Heading — throttled to ~10Hz so we don't saturate the bus.
    const HEADING_MIN_INTERVAL_MS = 100
    let lastHeadingAt = 0
    let pendingHeading: number | null = null
    let pendingTimer: ReturnType<typeof setTimeout> | null = null
    const flushHeading = () => {
      pendingTimer = null
      if (pendingHeading == null) return
      this.heading = pendingHeading
      pendingHeading = null
      lastHeadingAt = Date.now()
      this.ui.send("nav:heading", {degrees: this.heading})
    }
    this.unsubs.push(
      this.compass.onUpdate((d) => {
        const now = Date.now()
        const elapsed = now - lastHeadingAt
        if (elapsed >= HEADING_MIN_INTERVAL_MS) {
          this.heading = d.degrees
          lastHeadingAt = now
          this.ui.send("nav:heading", {degrees: this.heading})
        } else {
          pendingHeading = d.degrees
          if (!pendingTimer) pendingTimer = setTimeout(flushHeading, HEADING_MIN_INTERVAL_MS - elapsed)
        }
      }),
    )
    this.unsubs.push(() => {
      if (pendingTimer) clearTimeout(pendingTimer)
      pendingTimer = null
      pendingHeading = null
    })

    // Pivot events
    this.unsubs.push(
      this.navigation.onPivot(() => {
        this.activePivot = this.navigation.getActivePivot()
        this.upcomingPivot = this.navigation.getUpcomingPivot()
        this.ui.send("nav:pivots", {
          active: this.activePivot,
          upcoming: this.upcomingPivot,
        })
        this.refreshHUD()
      }),
    )

    // Navigation updates (maneuver / off_route / rerouting / arrived / error)
    this.unsubs.push(
      this.navigation.onUpdate((u: NavUpdate) => {
        this.appendLog(this.formatUpdate(u))
        switch (u.kind) {
          case "maneuver":
            // The Nav SDK keeps emitting maneuver events for a beat
            // after `arrived` fires (final-leg distance ticking to 0,
            // etc). Ignoring them here keeps the "You have arrived"
            // card on screen instead of letting it flicker back to
            // the live maneuver display. A fresh start() resets
            // status away from "arrived" via the synthetic onRoute
            // emit path, so this gate doesn't trap a real new trip.
            if (this.trip.status === "arrived") break
            this.trip = {
              ...this.trip,
              status: "navigating",
              running: true,
              maneuver: u,
              offRouteAt: null,
            }
            this.heartbeatLocationIfStale()
            break
          case "off_route":
            this.trip = {...this.trip, offRouteAt: Date.now()}
            break
          case "rerouting":
            this.trip = {...this.trip, status: "rerouting"}
            break
          case "arrived": {
            // Compute side from the current route *before* nulling it,
            // so the HUD's "on your left|right" line has data to render
            // when the SDK is the trigger (rather than our early ≤7m
            // path, which captures side the same way).
            const side = sideOfFinalSegment(this.trip.routePoints, this.trip.activeDestination)
            this.trip = {
              ...this.trip,
              status: "arrived",
              running: false,
              maneuver: null,
              activeDestination: null,
              routePoints: null,
              routeSteps: null,
              offRouteAt: null,
              arrivalSide: side,
            }
            this.hasCompletedTrip = true
            this.activePivot = null
            this.upcomingPivot = null
            this.cancelPendingRebuild()
            this.tripStartCoords = null
            this.lastStartOpts = null
            this.lastAutoRebuildAt = 0
            this.lastOffRouteBucket = 0
            this.offRouteAdvisory = false
            this.offRouteAdvisoryDistanceM = null
            this.cachedInstructions = null
            break
          }
          case "error":
            this.trip = {...this.trip, status: "idle", running: false}
            this.cancelPendingRebuild()
            this.tripStartCoords = null
            this.lastStartOpts = null
            this.lastAutoRebuildAt = 0
            this.lastOffRouteBucket = 0
            this.offRouteAdvisory = false
            this.offRouteAdvisoryDistanceM = null
            this.cachedInstructions = null
            break
        }
        this.ui.send("nav:trip-state", this.trip)
        this.refreshHUD()
      }),
    )

    // Route updates (full polyline rebuild)
    this.unsubs.push(
      this.navigation.onRoute((route: NavRoute) => {
        // Mirror NavStep → NavRouteStep, dropping `routeIndex` (UI
        // doesn't need it) and widening `maneuver` from the SDK union
        // to a plain string for the channel wire (see NavRouteStep).
        const steps =
          route.steps && route.steps.length > 0
            ? route.steps.map((s, i) => ({
                lat: s.lat,
                lng: s.lng,
                road: s.road ?? null,
                maneuver: s.maneuver,
                distanceMeters: s.distanceMeters,
                // Zip the cached preview-time Google instructions in by
                // index. The SDK strips `instruction` from NavStep, so
                // this is the only way the `useRawInstructions` toggle
                // can find Google's verbatim text for the current step.
                // Mismatched length (cache stale after reroute) is
                // handled by the silent refetch below.
                instruction:
                  this.cachedInstructions && i < this.cachedInstructions.length
                    ? this.cachedInstructions[i] || null
                    : null,
              }))
            : null
        // A fresh route landing means any in-flight reroute is resolved.
        // Clear the "rerouting" status here so the maneuver card / HUD
        // drop "Rebuilding route…" the moment the new polyline applies,
        // rather than lingering until the next maneuver event. Only
        // "rerouting" is rewritten — "navigating" (initial start) and
        // "arrived" are left untouched.
        const status = this.trip.status === "rerouting" ? "navigating" : this.trip.status
        this.trip = {...this.trip, status, routePoints: route.points, routeSteps: steps}
        // Fresh route → reset the off-route bucket and re-anchor the
        // trip-start point. Otherwise the first coord after the new
        // polyline lands could compare against a stale bucket (the
        // user might already have been "in" bucket 2 against the old
        // route) and skip the threshold transition log.
        this.lastOffRouteBucket = 0
        this.offRouteAdvisory = false
        this.offRouteAdvisoryDistanceM = null
        if (this.coords) {
          this.tripStartCoords = {lat: this.coords.lat, lng: this.coords.lng}
        }
        this.ui.send("nav:route", {points: route.points, steps})
        this.ui.send("nav:trip-state", this.trip)
        logLiveRoute(route)
        // After a reroute the cached preview instructions no longer line
        // up with the new step list (different count or different roads).
        // Refetch silently against the current origin so the
        // `useRawInstructions` toggle keeps showing fresh Google text
        // through reroutes. Gated behind the toggle so we don't burn a
        // Routes API call when nobody's watching.
        if (
          this.devSettings.useRawInstructions &&
          steps &&
          steps.length > 0 &&
          (this.cachedInstructions == null || this.cachedInstructions.length !== steps.length)
        ) {
          this.refetchInstructionsForLiveRoute(steps.length)
        }
        // Push the initial pivot snapshot. The SDK's onPivot only fires
        // on approaching/entered/exited transitions — at trip start the
        // user can be far from every pivot, so no transition has fired
        // yet and the UI would sit on stale (null, null) pivots until
        // the user got close. Pull the current pair off the engine and
        // ship it explicitly so the maneuver card has something to
        // render from the moment the trip begins.
        //
        // Race window: the SDK's NavigationModule subscribes the pivot
        // engine to the SAME onRoute event we're handling here. If the
        // engine subscribed AFTER us, getUpcomingPivot() runs before
        // the engine has built pivots from this route. Defer one
        // microtask + macrotask hop so every subscriber finishes
        // processing the event before we snapshot.
        setTimeout(() => {
          this.activePivot = this.navigation.getActivePivot()
          this.upcomingPivot = this.navigation.getUpcomingPivot()
          this.ui.send("nav:pivots", {active: this.activePivot, upcoming: this.upcomingPivot})
        }, 0)
      }),
    )
  }

  // ── RPC handlers ─────────────────────────────────────────────────────

  private wireRpcHandlers(): void {
    this.unsubs.push(
      this.ui.handle("nav:compute-route", async (opts) => {
        const result = await this.navigation.computeRoute(opts)
        // Cache the raw Google instruction strings off the primary route
        // so the `useRawInstructions` debug toggle can substitute them
        // into the live maneuver card / glasses HUD by step index.
        const steps = result.routes?.[0]?.steps
        if (steps && steps.length > 0) {
          this.cachedInstructions = steps.map((s) => cleanInstruction(s.instruction))
        }
        return result
      }),
    )
    this.unsubs.push(this.ui.handle("nav:request-permission", () => this.navigation.requestPermission()))
    this.unsubs.push(this.ui.handle("nav:get-snapshot", () => this.buildSnapshot()))
    this.unsubs.push(this.ui.handle("nav:get-pivots", () => this.navigation.getPivots()))

    this.unsubs.push(
      this.ui.handle("places:autocomplete", ({query, near}, ctx) => this.places.autocomplete(query, near, ctx?.signal)),
    )
    this.unsubs.push(this.ui.handle("places:details", ({placeId}, ctx) => this.places.details(placeId, ctx?.signal)))

    this.unsubs.push(this.ui.handle("storage:list-saved", () => this.storage.getAllSavedPlaces()))
    this.unsubs.push(this.ui.handle("storage:add-saved", (p) => this.storage.addSavedPlace(p)))
    this.unsubs.push(this.ui.handle("storage:remove-saved", ({placeId}) => this.storage.removeSavedPlace(placeId)))
    this.unsubs.push(this.ui.handle("storage:list-recent", () => this.storage.getRecentSearches()))
    this.unsubs.push(this.ui.handle("storage:add-recent", (p) => this.storage.addRecentSearch(p)))
  }

  // ── UI broadcast listeners ───────────────────────────────────────────

  private wireUIBroadcasts(): void {
    this.unsubs.push(
      this.ui.on("nav:start", async (opts) => {
        const {destinationName, ...startOpts} = opts
        // Clear the previous trip's route polyline immediately so the
        // off-route threshold check doesn't run against a stale route
        // between nav:start and the new onRoute event landing. Without
        // this, the user can be e.g. 500m from the prior route's
        // polyline at start, instantly trigger the >30m bucket, flip
        // status to "rerouting", and fire a redundant auto-rebuild.
        this.trip = {
          ...this.trip,
          status: "navigating",
          running: true,
          activeDestination: startOpts.stops?.[startOpts.stops.length - 1] ?? null,
          activeDestinationName: destinationName ?? null,
          maneuver: null,
          routePoints: null,
          routeSteps: null,
          offRouteAt: null,
          arrivalSide: null,
        }
        // Snapshot the trip-start context so an auto-rebuild can re-
        // fire start() with the same shape, and so we can gate
        // rebuilds on "user has actually moved away from start".
        this.lastStartOpts = opts
        this.tripStartCoords = this.coords ? {lat: this.coords.lat, lng: this.coords.lng} : null
        this.lastAutoRebuildAt = 0
        this.lastOffRouteBucket = 0
        this.offRouteAdvisory = false
        this.offRouteAdvisoryDistanceM = null
        // Cancel any in-flight delayed rebuild — a fresh start
        // supersedes the old "are we still off-route?" timer.
        this.cancelPendingRebuild()
        this.appendLog(`START ${destinationName ?? "(unnamed)"}`)
        this.ui.send("nav:trip-state", this.trip)
        try {
          // start() resolves `{ok:false}` (it never throws) for
          // permission, GPS, REST, or native failures — on those the
          // native trip never began and no synthetic onRoute will land,
          // so we must roll the optimistic "navigating" state set above
          // back to idle. Inspecting only `catch` left the UI stuck on a
          // routeless trip with no recovery but a manual stop.
          const res = await this.navigation.start(withPivotDefaults(startOpts))
          if (!res.ok) {
            this.appendLog(`START failed: ${res.error ?? "unknown"}`)
            this.trip = {...this.trip, status: "idle", running: false}
            this.ui.send("nav:trip-state", this.trip)
            this.refreshHUD()
          }
        } catch (err) {
          this.appendLog(`START error: ${err instanceof Error ? err.message : String(err)}`)
          this.trip = {...this.trip, status: "idle", running: false}
          this.ui.send("nav:trip-state", this.trip)
          this.refreshHUD()
        }
      }),
    )
    this.unsubs.push(
      this.ui.on("nav:stop", () => {
        this.appendLog("STOP")
        try {
          this.navigation.stop()
        } catch {
          /* ignore */
        }
        this.cancelPendingRebuild()
        this.tripStartCoords = null
        this.lastStartOpts = null
        this.lastAutoRebuildAt = 0
        this.lastOffRouteBucket = 0
        this.offRouteAdvisory = false
        this.offRouteAdvisoryDistanceM = null
        this.activePivot = null
        this.upcomingPivot = null
        this.cachedInstructions = null
        this.trip = {
          ...this.trip,
          status: "idle",
          running: false,
          maneuver: null,
          activeDestination: null,
          routePoints: null,
          routeSteps: null,
          offRouteAt: null,
          arrivalSide: null,
        }
        this.hasCompletedTrip = true
        this.ui.send("nav:trip-state", this.trip)
        this.refreshHUD()
      }),
    )
    this.unsubs.push(
      this.ui.on("nav:deviate", () => {
        try {
          this.navigation.dev.deviate()
        } catch (err) {
          this.appendLog(`deviate failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }),
    )
    this.unsubs.push(
      this.ui.on("nav:set-destination", (place) => {
        if (place) this.appendLog(`set-destination ${place.name}`)
      }),
    )
    this.unsubs.push(
      this.ui.on("nav:set-dev-settings", (partial) => {
        const next = {...this.devSettings, ...partial}
        // Forward changed dev toggles into the navigation SDK's `dev`
        // surface so the wrongSidewalk / skipCrossings flags actually
        // affect the trip. `simulate` and `speedMultiplier` are passed
        // to navigation.start() via the nav:start payload — applying
        // them mid-trip would require a stop+restart, which we don't
        // do here.
        try {
          if (partial.wrongSidewalk !== undefined && partial.wrongSidewalk !== this.devSettings.wrongSidewalk) {
            this.navigation.dev.setWrongSidewalkOffset(partial.wrongSidewalk)
          }
          if (partial.skipCrossings !== undefined && partial.skipCrossings !== this.devSettings.skipCrossings) {
            this.navigation.dev.setSkipCrossings(partial.skipCrossings)
          }
        } catch (err) {
          this.appendLog(`dev-settings forward failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        const rawJustEnabled =
          partial.useRawInstructions === true && !this.devSettings.useRawInstructions
        this.devSettings = next
        this.ui.send("nav:dev-settings-update", this.devSettings)
        // Flipping the toggle changes what the maneuver card / HUD
        // render, but neither re-runs until the next pivot / coord
        // tick. Force a refresh so the swap is visible immediately.
        this.refreshHUD()
        // If the toggle was just turned on mid-trip and we have no
        // cached instructions (or the cache is stale relative to the
        // live route), kick off a silent refetch so the live trip gets
        // the strings on the next render. No-op when idle.
        if (rawJustEnabled && this.trip.running) {
          const liveLen = this.trip.routeSteps?.length ?? 0
          if (liveLen > 0 && (this.cachedInstructions == null || this.cachedInstructions.length !== liveLen)) {
            this.refetchInstructionsForLiveRoute(liveLen)
          }
        }
      }),
    )

    this.unsubs.push(
      this.ui.on("nav:set-units", ({unitSystem}) => {
        if (unitSystem === this.unitSystem) return
        this.unitSystem = unitSystem
        // Persist (fire-and-forget — the in-memory value is already
        // authoritative for this session; storage just survives reloads).
        this.storage.setUnitSystem(unitSystem).catch((err) => {
          this.appendLog(`unit-system persist failed: ${err instanceof Error ? err.message : String(err)}`)
        })
        this.ui.send("nav:units-update", {unitSystem})
        // Re-render the glasses HUD so the distance suffix flips units
        // immediately rather than waiting for the next pivot/coord tick.
        this.refreshHUD()
      }),
    )

    this.unsubs.push(
      this.ui.on("nav:set-show-minimap", (show) => {
        if (show === this.showMinimap) return
        this.showMinimap = show
        if (!show) {
          // Wipe whatever bitmap is on the glasses and reset the dedup
          // cache so toggling back on re-pushes the next frame.
          this.display.clear()
          this.lastMinimapPng = null
          this.lastHudKey = ""
        } else {
          // Force the next HUD pump to repush.
          this.lastMinimapPng = null
          this.refreshHUD()
        }
      }),
    )

    this.unsubs.push(
      this.ui.handle("test:show-text-test", ({text, durationMs}) => {
        this.display.showText(text, durationMs)
      }),
    )

    this.unsubs.push(
      this.ui.handle("test:show-bitmap-test", () => {
        this.display.showBitmapTest(TEST_BITMAP_288_B64)
      }),
    )

    this.unsubs.push(
      this.ui.handle("test:show-bitmap-size", ({size, height}) => {
        this.display.showBitmapSize(size, height)
      }),
    )

    this.unsubs.push(
      this.ui.handle("test:show-osm-map", async () => {
        return this.renderOsmMap("draw")
      }),
    )

    this.unsubs.push(
      this.ui.handle("test:pan-osm-map", async ({dir}) => {
        // Small nudge: shift the center by ~1/4 of the visible span. The visible
        // span is 2×radius meters, so a quarter is radius/2 meters.
        const stepM = this.OSM_MAP_RADIUS_M / 2
        const mPerDegLat = 111_320
        const mPerDegLng = 111_320 * Math.cos((this.osmMapCenter.lat * Math.PI) / 180)
        const dLat = stepM / mPerDegLat
        const dLng = stepM / mPerDegLng
        if (dir === "up") this.osmMapCenter.lat += dLat
        else if (dir === "down") this.osmMapCenter.lat -= dLat
        else if (dir === "left") this.osmMapCenter.lng -= dLng
        else if (dir === "right") this.osmMapCenter.lng += dLng
        return this.renderOsmMap(`pan ${dir}`)
      }),
    )

    this.unsubs.push(
      this.ui.handle("test:count-1-to-10", () => {
        for (let i = 1; i <= 10; i++) {
          setTimeout(() => this.display.showText(String(i)), (i - 1) * 3000)
        }
      }),
    )

    // Mid-trip hydration: every fresh WebView open gets a snapshot.
    this.unsubs.push(this.ui.onOpen(() => this.ui.send("nav:snapshot", this.buildSnapshot())))
  }

  // ── OSM line-map PoC ─────────────────────────────────────────────────
  /** Fetch + render the OSM road map at the current osmMapCenter and push it. */
  private async renderOsmMap(reason: string): Promise<{ok: boolean; error?: string}> {
    const {lat, lng} = this.osmMapCenter
    const SIZE = this.OSM_MAP_SIZE
    console.log(
      `[OSM-MAP] 🗺️  ${reason} — fetching roads around ${lat.toFixed(6)},${lng.toFixed(6)} (${SIZE}×${SIZE})`,
    )
    const t0 = Date.now()
    try {
      const base64 = await buildOsmLineMap({
        center: {lat, lng},
        width: SIZE,
        height: SIZE,
        viewRadiusMeters: this.OSM_MAP_RADIUS_M,
        lineWidthPx: 2,
      })
      console.log(
        `[OSM-MAP] ✅ rendered ${SIZE}×${SIZE} BMP (${(base64.length / 1024).toFixed(1)} KB) in ${Date.now() - t0}ms — sending to glasses`,
      )
      this.display.showRawBitmap(base64, SIZE, SIZE)
      return {ok: true}
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      console.log(`[OSM-MAP] ❌ failed after ${Date.now() - t0}ms:`, error)
      return {ok: false, error}
    }
  }

  // ── Glasses HUD pump ─────────────────────────────────────────────────
  // refreshHUD() is called explicitly at the end of each state mutator
  // in wireSensorSubscriptions / wireUIBroadcasts. No monkey-patching of
  // ui.send — clearer than reactive auto-refresh.

  private wireHUDPump(): void {
    // Prime an initial HUD render once subscriptions warm up so the
    // welcome message shows even before the first GPS fix. Stored on
    // an unsub so dispose() can cancel before it fires — otherwise a
    // session that disconnects within 250ms of start would re-display
    // "Welcome" on the glasses after dispose() has already cleared.
    const handle = setTimeout(() => {
      try {
        this.refreshHUD()
      } catch {
        /* ignore */
      }
    }, 250)
    this.unsubs.push(() => clearTimeout(handle))
  }

  private refreshHUD(): void {
    const {status, running, activeDestinationName, maneuver, arrivalSide} = this.trip

    // Minimap runs first so heading-only updates still refresh the map
    // even when the text line below is unchanged (and short-circuits).
    this.refreshMinimap()

    let next: string | null = null
    let durationMs: number | undefined

    // Mirrors the phone-side OrientationCard's pickDisplay() — same
    // two-line layout, same pivot fields, same precedence. If you tweak
    // one, tweak the other or they'll diverge.
    if (status === "arrived") {
      const at = activeDestinationName ? ` at ${activeDestinationName}` : ""
      const side = arrivalSide ? `, on your ${arrivalSide}` : ""
      next = `You have arrived${at}${side}`
      durationMs = 10_000
    } else if (!running && !this.hasCompletedTrip) {
      next = "Welcome to Mentra Maps!\nPick a destination to get started."
      durationMs = 5_000
    } else if (status === "rerouting") {
      next = "Rebuilding route…"
    } else if (this.offRouteAdvisory && running) {
      // 15–30m advisory band. Replace the (now stale) maneuver text
      // with a return-to-route prompt + live distance back to the
      // path until the user either gets back on (cleared in
      // logOffRouteThresholds) or crosses 30m and the auto-rebuild
      // flow takes over.
      const d = this.offRouteAdvisoryDistanceM
      next = d != null ? `Go back\n${formatDistance(d, this.unitSystem)}` : "Go back\nto route"
    } else if (this.activePivot?.direction) {
      // At the turn. Layout:
      //   ←|→
      //   Onto <toRoad>
      //   Turn left|right
      const verb = this.activePivot.direction === "right" ? "Turn right" : "Turn left"
      const onto = isRealRoadName(this.activePivot.toRoad)
      const topLine = onto ? `Onto ${onto}` : null
      const rawTop = this.devSettings.useRawInstructions
        ? this.lookupRawInstructionForPivot(this.activePivot)
        : null
      // Directional arrow on the top line. Mirrors the approaching-
      // pivot branch, but since we're AT the corner there's no distance
      // gate to apply — it's always the turn arrow, never ↑.
      const arrow = arrowFor(this.activePivot.maneuver, this.activePivot.direction)
      // At the pivot. With raw instructions on, Google's text already
      // contains the verb ("Turn right onto X St"), so prepending our
      // own "Turn right" line duplicates the verb. Use "Now" as the
      // top line instead — same hierarchy as "In 198 m" above the
      // line just before the turn fires.
      next = rawTop ? `${arrow}\nNow\n${rawTop}` : [arrow, topLine, verb].filter(Boolean).join("\n")
    } else if (this.upcomingPivot?.direction && this.coords) {
      // Approaching the next turn. Layout:
      //   Onto <toRoad>
      //   Turn left|right in <distance>
      const dist = haversineMeters(
        {lat: this.coords.lat, lng: this.coords.lng},
        {lat: this.upcomingPivot.lat, lng: this.upcomingPivot.lng},
      )
      const verb = this.upcomingPivot.direction === "right" ? "Turn right" : "Turn left"
      const onto = isRealRoadName(this.upcomingPivot.toRoad)
      const topLine = onto ? `Onto ${onto}` : null
      // Direction arrow as its own top line so the user can read the
      // turn at a glance before parsing the rest of the HUD. Pulled
      // from the pivot's `maneuver` (richer than `direction`, includes
      // SLIGHT_/SHARP_ variants) with `direction` as fallback.
      //
      // Gated on distance: while still walking down the current street
      // (>100m from the upcoming pivot) the arrow stays ↑ so it doesn't
      // claim to be turning when there's nothing to turn at yet. Inside
      // the approach threshold, the arrow flips to the actual turn
      // direction.
      //
      //   ←|→|↑
      //   In 198 m
      //   Turn right onto Octavia St   (or Google's raw text)
      const arrow =
        dist < ARROW_APPROACH_M_WALKING
          ? arrowFor(this.upcomingPivot.maneuver, this.upcomingPivot.direction)
          : "↑"
      const rawTop = this.devSettings.useRawInstructions
        ? this.lookupRawInstructionForPivot(this.upcomingPivot)
        : null
      next = rawTop
        ? `${arrow}\nIn ${formatDistance(dist, this.unitSystem)}\n${rawTop}`
        : [arrow, topLine, `${verb} in ${formatDistance(dist, this.unitSystem)}`].filter(Boolean).join("\n")
    } else if (maneuver?.distanceToDestinationMeters != null && maneuver.distanceToDestinationMeters >= 0) {
      // Final-leg "Arriving in Xm" — no more pivots between here and
      // the destination, so the directional arrow stays ↑ (straight
      // ahead) until the ≤7m-remaining trigger flips status to
      // "arrived". Matches the approach-pivot HUD's arrow-on-top
      // layout for visual continuity.
      next = `↑\nArriving in ${formatDistance(maneuver.distanceToDestinationMeters, this.unitSystem)}`
    } else if (running) {
      next = `↑\nArriving`
    }

    if (next == null) {
      // Nothing to display — wipe whatever frame was last on the
      // glasses (the SDK's text HUD persists until cleared/replaced).
      // Without this, after `nav:stop` the user keeps seeing the last
      // "Arriving in Xm" frame indefinitely because the maneuver got
      // cleared but no replacement HUD was ever pushed.
      if (this.lastHudKey !== "") {
        this.lastHudKey = ""
        try {
          this.display.clear()
        } catch {
          /* ignore */
        }
      }
      return
    }
    // Coalesce — don't spam the glasses with the same frame.
    const key = `${next} ${durationMs ?? 0}`
    if (key === this.lastHudKey) return
    this.lastHudKey = key
    this.display.showText(next, durationMs)
  }

  /**
   * Render and push the 100×100 heading-up minimap. Drawn alongside the
   * text HUD (non-overlapping regions of the main view). De-duped on the
   * encoded PNG so we don't re-send identical frames while idle.
   */
  // OSM-roads minimap: street network around the user's live position, with the
  // active route drawn on top. Roads are cached and only re-fetched from Overpass
  // when the user moves past a threshold (PoC: fetch-on-move, ~1s lag accepted).
  private readonly OSM_MINIMAP_SIZE = 87 // matches the bottom-right container
  private readonly OSM_MINIMAP_RADIUS_M = 133
  private readonly OSM_REFETCH_THRESHOLD_M = 120

  private refreshMinimap(): void {
    if (!this.showMinimap) return
    if (!this.trip.running || !this.coords) return

    const me: LatLng = {lat: this.coords.lat, lng: this.coords.lng}

    // Re-fetch roads if we have none yet, or the user has wandered far from the
    // cached center. Fetch is async + best-effort; we render with whatever roads
    // we currently have (possibly empty on the very first tick).
    const movedFar =
      !this.osmRoadsCenter ||
      haversineMeters(me, this.osmRoadsCenter) > this.OSM_REFETCH_THRESHOLD_M
    if (movedFar && !this.osmFetchInFlight) {
      this.osmFetchInFlight = true
      const fetchCenter = me
      fetchOsmRoads(fetchCenter, this.OSM_MINIMAP_RADIUS_M * 2)
        .then((roads) => {
          this.osmRoadsCache = roads
          this.osmRoadsCenter = fetchCenter
          console.log(`[OSM-MINIMAP] fetched ${roads.length} roads around ${fetchCenter.lat.toFixed(5)},${fetchCenter.lng.toFixed(5)}`)
          this.refreshMinimap() // redraw now that roads are in
        })
        .catch((err) => console.log("[OSM-MINIMAP] fetch failed:", err))
        .finally(() => {
          this.osmFetchInFlight = false
        })
    }

    const png = renderOsmLineMap(this.osmRoadsCache ?? [], {
      center: me,
      width: this.OSM_MINIMAP_SIZE,
      height: this.OSM_MINIMAP_SIZE,
      viewRadiusMeters: this.OSM_MINIMAP_RADIUS_M,
      lineWidthPx: 2,
      route: this.trip.routePoints,
    })
    if (!png || png === this.lastMinimapPng) return
    this.lastMinimapPng = png
    this.display.showBitmap(png)
  }

  // ── Permission + initial fix priming ─────────────────────────────────

  private primeNavigationPermission(): void {
    this.session
      .waitForReady()
      .then(() => this.navigation.requestPermission())
      .then((r) => this.appendLog(`requestPermission: ${JSON.stringify(r)}`))
      .catch((err) => {
        console.warn("[NavigationController] requestPermission failed", err)
      })
  }

  private seedInitialFix(): void {
    this.location
      .getOnce()
      .then((d) => {
        if (this.coords) return
        this.coords = {lat: d.lat, lng: d.lng, accuracy: d.accuracy, ts: d.timestamp ?? Date.now()}
        this.lastCoordsAt = Date.now()
        this.ui.send("nav:coords", this.coords)
      })
      .catch(() => {
        /* streaming updates will arrive when location stabilises */
      })
  }

  // Recovery for the "dot frozen while distance keeps ticking" bug. The Nav
  // SDK's onNavManeuver and onNavLocation streams emit independently — when
  // the road-snapped location stream goes quiet but maneuvers keep firing,
  // the dot freezes on the map even though we're moving. Use the maneuver
  // tick as a heartbeat: if our coords haven't refreshed in STALE_MS, force
  // a one-shot CoreLocation fix. The existing onUpdate listener handles the
  // result; this just primes the pump.
  private heartbeatLocationIfStale(): void {
    const STALE_MS = 5_000
    if (this.gettingFix) return
    if (Date.now() - this.lastCoordsAt < STALE_MS) return
    this.gettingFix = true
    this.location
      .getOnce()
      .then((d) => {
        this.coords = {lat: d.lat, lng: d.lng, accuracy: d.accuracy, ts: d.timestamp ?? Date.now()}
        this.lastCoordsAt = Date.now()
        this.ui.send("nav:coords", this.coords)
      })
      .catch(() => {
        /* next maneuver tick will retry */
      })
      .finally(() => {
        this.gettingFix = false
      })
  }

  // ── Off-route threshold + auto-rebuild ───────────────────────────────

  // Compute perpendicular distance from the current fix to the active
  // route polyline. Thresholds:
  //   15m → log only (advisory: "consider returning to route")
  //   30m → trigger an auto-rebuild to the same destination
  //
  // Bucket-based so a user wandering at 18m doesn't spam logs every
  // tick — only bucket transitions emit. Rebuild gated by two filters
  // (see triggerAutoRebuild):
  //   - REBUILD_MIN_MOVE_M: user must have moved away from where the
  //     trip started. Suppresses the "user is inside a 50m building"
  //     case where the initial fix is already >30m off but the user
  //     hasn't actually deviated yet.
  //   - REBUILD_COOLDOWN_MS: no rebuild within N seconds of the last
  //     one, so a fresh route can land before we'd consider firing
  //     another.
  private logOffRouteThresholds(): void {
    if (!this.coords) return
    const route = this.trip.routePoints
    if (!route || route.length < 2) {
      this.lastOffRouteBucket = 0
      this.offRouteAdvisory = false
      this.offRouteAdvisoryDistanceM = null
      return
    }
    const here = {lat: this.coords.lat, lng: this.coords.lng}
    const dist = distanceToPolylineMeters(here, route)
    if (dist == null) return
    const bucket = dist >= OFF_ROUTE_TRIGGER_M ? 2 : dist >= OFF_ROUTE_ADVISORY_M ? 1 : 0
    // Keep the advisory distance live so the HUD's "Go back 10m" line
    // ticks down as the user moves. Done every coord update — only
    // the bucket-transition log + rebuild trigger below run on edges.
    const prevDistance = this.offRouteAdvisoryDistanceM
    this.offRouteAdvisoryDistanceM = bucket === 1 ? dist : null
    if (
      bucket === this.lastOffRouteBucket &&
      bucket === 1 &&
      prevDistance != null &&
      Math.round(prevDistance) !== Math.round(dist)
    ) {
      // Same bucket, distance label would change — refresh so the HUD
      // text follows the user. Coalescing in refreshHUD swallows
      // identical frames so this is cheap.
      this.refreshHUD()
    }
    if (bucket === this.lastOffRouteBucket) return
    this.lastOffRouteBucket = bucket
    // Track the advisory band so refreshHUD() can show "Go back to
    // route" while we wait for either a return-to-path (bucket 0) or
    // a rebuild trigger (bucket 2).
    this.offRouteAdvisory = bucket === 1
    if (bucket === 0) {
      // Returned within the route — back to maneuver text on the HUD.
      this.refreshHUD()
    } else if (bucket === 1) {
      const msg = `> ${OFF_ROUTE_ADVISORY_M}m off route (${dist.toFixed(1)}m) — return to route`
      console.log(`[NavOffRoute] ${msg}`)
      this.appendLog(`[NavOffRoute] ${msg}`)
      this.refreshHUD()
    } else if (bucket === 2) {
      const msg = `> ${OFF_ROUTE_TRIGGER_M}m off route (${dist.toFixed(1)}m) — rebuilding`
      console.log(`[NavOffRoute] ${msg}`)
      this.appendLog(`[NavOffRoute] ${msg}`)
      this.triggerAutoRebuild(here, dist)
    }
  }

  // Schedule a delayed auto-rebuild. Crossing >30m flips the HUD to
  // "Rebuilding route…" immediately (via status="rerouting"), then we
  // wait REBUILD_DELAY_MS and re-check distance. If the user is still
  // >30m off, fire nav:start; if they've returned closer, cancel and
  // revert HUD. The delay also doubles as the "min 3s HUD show" rule —
  // since REBUILD_DELAY_MS > 3s, the rerouting card is always on screen
  // for at least 3s before any outcome.
  //
  // No-ops if the user hasn't actually moved from where the trip
  // started (building edge case) or if a previous rebuild is still
  // within its cooldown window.
  private triggerAutoRebuild(here: {lat: number; lng: number}, dist: number): void {
    const REBUILD_MIN_MOVE_M = 10
    const REBUILD_COOLDOWN_MS = 5_000
    const REBUILD_DELAY_MS = 4_000
    const REBUILD_DISTANCE_M = OFF_ROUTE_TRIGGER_M

    const opts = this.lastStartOpts
    if (!opts) return

    // Already a delayed rebuild in flight — don't stack another.
    if (this.pendingRebuildTimer) return

    const now = Date.now()
    if (now - this.lastAutoRebuildAt < REBUILD_COOLDOWN_MS) {
      this.appendLog(`[NavOffRoute] rebuild skipped (cooldown)`)
      return
    }

    const start = this.tripStartCoords
    if (start) {
      const moved = haversineMeters(start, here)
      if (moved < REBUILD_MIN_MOVE_M) {
        this.appendLog(
          `[NavOffRoute] rebuild skipped (user hasn't moved: ${moved.toFixed(1)}m from start, ${dist.toFixed(1)}m off route)`,
        )
        return
      }
    }

    // Flip HUD immediately so "Rebuilding route…" is visible during
    // the delay window. If the trip ends or a new route lands during
    // the delay, cancelPendingRebuild() / the existing route handlers
    // will revert this.
    this.appendLog(`[NavOffRoute] rebuild armed — re-checking in ${REBUILD_DELAY_MS / 1000}s`)
    this.trip = {...this.trip, status: "rerouting"}
    this.ui.send("nav:trip-state", this.trip)
    this.refreshHUD()

    this.pendingRebuildTimer = setTimeout(() => {
      this.pendingRebuildTimer = null

      // Trip may have ended or status changed during the delay.
      if (!this.trip.running && this.trip.status !== "rerouting") return
      const route = this.trip.routePoints
      if (!route || route.length < 2 || !this.coords) {
        // Route or fix went away — revert.
        this.trip = {...this.trip, status: "navigating"}
        this.ui.send("nav:trip-state", this.trip)
        this.refreshHUD()
        return
      }
      const stillOff = distanceToPolylineMeters({lat: this.coords.lat, lng: this.coords.lng}, route)
      if (stillOff == null || stillOff < REBUILD_DISTANCE_M) {
        this.appendLog(`[NavOffRoute] rebuild cancelled — back within range (${stillOff?.toFixed(1) ?? "?"}m)`)
        this.trip = {...this.trip, status: "navigating"}
        this.ui.send("nav:trip-state", this.trip)
        this.refreshHUD()
        return
      }

      this.lastAutoRebuildAt = Date.now()
      this.appendLog(
        `[NavOffRoute] auto-rebuild firing (${stillOff.toFixed(1)}m off) → ${opts.destinationName ?? "(unnamed)"}`,
      )
      // Re-anchor trip-start to the current position so the moved-guard
      // re-arms against this new starting point.
      this.tripStartCoords = {lat: this.coords!.lat, lng: this.coords!.lng}
      void this.navigation.start(withPivotDefaults(opts)).then((res) => {
        if (!res.ok) {
          this.appendLog(`[NavOffRoute] auto-rebuild failed: ${res.error ?? "unknown"}`)
          this.trip = {...this.trip, status: "navigating"}
          this.ui.send("nav:trip-state", this.trip)
          this.refreshHUD()
        }
      })
    }, REBUILD_DELAY_MS)
  }

  // ── Early arrival (≤7m of route remaining) ───────────────────────────

  // The Nav SDK fires `arrived` based on its own threshold (straight-
  // line to the destination pin). We fire earlier when the user has
  // walked nearly the entire route polyline — the grey trail has
  // reached the pin. Uses along-route distance, not perpendicular, so a
  // pin sitting a few meters off the walkable polyline still triggers.
  //
  // Mirrors the SDK arrived handler's state mutation so downstream
  // consumers (HUD, UI) see the same shape regardless of which trigger
  // fired. Captures the side (left/right) of the pin relative to the
  // final route segment *before* clearing routePoints so the HUD can
  // render "on your left|right".
  private maybeFireEarlyArrival(): void {
    const ARRIVAL_REMAINING_M = 7
    if (!this.coords) return
    if (this.trip.status === "arrived" || !this.trip.running) return
    const route = this.trip.routePoints
    const remaining = remainingRouteMeters({lat: this.coords.lat, lng: this.coords.lng}, route)
    if (remaining == null || remaining > ARRIVAL_REMAINING_M) return
    const side = sideOfFinalSegment(route, this.trip.activeDestination)
    this.appendLog(`ARRIVED (early, ${remaining.toFixed(1)}m of route remaining)`)
    this.trip = {
      ...this.trip,
      status: "arrived",
      running: false,
      maneuver: null,
      activeDestination: null,
      routePoints: null,
      routeSteps: null,
      offRouteAt: null,
      arrivalSide: side,
    }
    this.hasCompletedTrip = true
    this.activePivot = null
    this.upcomingPivot = null
    this.cancelPendingRebuild()
    this.tripStartCoords = null
    this.lastStartOpts = null
    this.lastAutoRebuildAt = 0
    this.lastOffRouteBucket = 0
    this.offRouteAdvisory = false
    this.offRouteAdvisoryDistanceM = null
    try {
      this.navigation.stop()
    } catch {
      /* ignore */
    }
    this.ui.send("nav:trip-state", this.trip)
  }

  private cancelPendingRebuild(): void {
    if (this.pendingRebuildTimer) {
      clearTimeout(this.pendingRebuildTimer)
      this.pendingRebuildTimer = null
    }
  }

  // ── Log + maneuver helpers ───────────────────────────────────────────

  private appendLog(line: string): void {
    const entry: LogEntry = {id: ++this.logSeq, ts: Date.now(), line}
    this.log = [entry, ...this.log].slice(0, 100)
    this.ui.send("nav:log-append", entry)
  }

  /**
   * Find the Google `navigationInstruction` string for the live step
   * whose start coords match the given pivot, by index match on
   * `(lat, lng)`. Returns null when the toggle is off, when no cached
   * instructions are available, or when the pivot can't be matched to
   * a step (rare — usually means a reroute landed and the silent
   * refetch hasn't completed yet).
   */
  private lookupRawInstructionForPivot(pivot: Pivot): string | null {
    const steps = this.trip.routeSteps
    if (!steps || steps.length === 0) return null
    // Pivots and steps share lat/lng to ≥5 decimal places (the SDK
    // forwards them through unmodified). Match on a small epsilon
    // rather than equality to absorb float reformatting.
    const EPS = 1e-5
    for (const s of steps) {
      if (Math.abs(s.lat - pivot.lat) < EPS && Math.abs(s.lng - pivot.lng) < EPS) {
        return s.instruction || null
      }
    }
    return null
  }

  /**
   * Silent Routes API refetch triggered after a reroute when the
   * `useRawInstructions` debug toggle is on. Pulls fresh Google
   * `navigationInstruction` strings against the current origin (live
   * coords) and the active destination so the maneuver card / glasses
   * HUD can keep showing Google's verbatim text through reroutes.
   * Re-emits `nav:route` and `nav:trip-state` with the zipped steps so
   * the UI picks up the refreshed strings.
   */
  private async refetchInstructionsForLiveRoute(expectedStepCount: number): Promise<void> {
    if (this.refetchingInstructions) return
    const origin = this.coords ? {lat: this.coords.lat, lng: this.coords.lng} : null
    const dest = this.trip.activeDestination
    if (!origin || !dest) return
    this.refetchingInstructions = true
    try {
      const res = await this.navigation.computeRoute({
        origin,
        stops: [dest],
        mode: this.lastStartOpts?.mode ?? "walking",
      })
      const steps = res.routes?.[0]?.steps
      if (!steps || steps.length === 0) return
      this.cachedInstructions = steps.map((s) => s.instruction ?? "")
      // Re-zip into the current live routeSteps so the UI updates.
      const live = this.trip.routeSteps
      if (live && live.length > 0) {
        const merged = live.map((s, i) => ({
          ...s,
          instruction:
            this.cachedInstructions && i < this.cachedInstructions.length
              ? this.cachedInstructions[i] || null
              : null,
        }))
        this.trip = {...this.trip, routeSteps: merged}
        this.ui.send("nav:route", {points: this.trip.routePoints ?? [], steps: merged})
        this.ui.send("nav:trip-state", this.trip)
        this.refreshHUD()
      }
      if (steps.length !== expectedStepCount) {
        this.appendLog(`raw-instructions: refetch step count ${steps.length} ≠ live ${expectedStepCount}`)
      }
    } catch (err) {
      this.appendLog(`raw-instructions refetch failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.refetchingInstructions = false
    }
  }

  private formatUpdate(u: NavUpdate): string {
    switch (u.kind) {
      case "maneuver":
        return `MANEUVER ${u.maneuverType} dist=${u.distanceMeters.toFixed(0)}m`
      case "off_route":
        return `OFF_ROUTE ${Math.round(u.offRouteDistanceMeters)}m off`
      case "rerouting":
        return "REROUTING"
      case "arrived":
        return "ARRIVED"
      case "error":
        return `ERROR ${u.message}`
      default:
        return `UPDATE ${(u as {kind?: string}).kind ?? "?"}`
    }
  }

  // ── Snapshot + dispose ───────────────────────────────────────────────

  private buildSnapshot(): NavSnapshot {
    return {
      coords: this.coords,
      heading: this.heading,
      trip: this.trip,
      activePivot: this.activePivot,
      upcomingPivot: this.upcomingPivot,
      log: [...this.log],
      devSettings: this.devSettings,
      unitSystem: this.unitSystem,
    }
  }

  /**
   * Load the persisted distance-unit preference on startup and, if it
   * differs from the metric default, broadcast it so the UI (and the
   * glasses HUD on the next refresh) pick it up. Fire-and-forget: the
   * snapshot already carries the current value, so a slow storage read
   * just means the UI briefly shows metric before the stored choice lands.
   */
  private loadUnitSystem(): void {
    this.storage
      .getUnitSystem()
      .then((unit) => {
        if (unit === this.unitSystem) return
        this.unitSystem = unit
        this.ui.send("nav:units-update", {unitSystem: unit})
        this.refreshHUD()
      })
      .catch((err) => {
        this.appendLog(`unit-system load failed: ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  private dispose(): void {
    this.cancelPendingRebuild()
    try {
      this.navigation.stop()
    } catch {
      /* ignore */
    }
    try {
      this.display.clear()
    } catch {
      /* ignore */
    }
    for (const u of this.unsubs) {
      try {
        u()
      } catch {
        /* ignore */
      }
    }
    this.unsubs = []
  }
}

// ── Module helpers ─────────────────────────────────────────────────────

function isRealRoadName(s: string | undefined | null): string | null {
  if (!s) return null
  if (/^Pivot \d+$/i.test(s)) return null
  return s
}

/**
 * Glasses HUD direction arrow for a maneuver. Picks a Unicode glyph
 * that visually matches the upcoming turn — sharper bends get the
 * curved arrows, gentle turns get the diagonals, U-turns get the
 * loopback. Falls back to the pivot's `direction` field (left/right)
 * when the maneuver string isn't one we recognize, and ultimately to
 * a straight-ahead `↑`.
 */
function arrowFor(maneuver: string | null | undefined, direction: "left" | "right" | null | undefined): string {
  // Plain arrow glyphs only — the corner-curve variants (↰ ↱) don't
  // render on the glasses font. Anything left-ish → ←, right-ish → →,
  // straight / continue / depart / unknown → ↑.
  const m = (maneuver ?? "").toUpperCase()
  if (m.includes("LEFT")) return "←"
  if (m.includes("RIGHT")) return "→"
  if (direction === "left") return "←"
  if (direction === "right") return "→"
  return "↑"
}

/**
 * Walking pivot radius (meters). Default SDK walking radius is 7m,
 * which is tight enough that crossing to the opposite sidewalk at a
 * 4-way puts you outside the at-turn zone and `onPivot.entered`
 * never fires. 14m covers all four corners of a typical urban
 * intersection without being so wide it misfires on adjacent blocks
 * (block length ≈ 80m). Set as a single static value because the SDK
 * has no runtime radius setter — same value used for enter and exit.
 */
const PIVOT_RADIUS_M_WALKING = 14

// Distance at which the HUD's directional arrow flips from ↑
// (straight ahead) to ←/→ (the actual turn). Locked to the pivot
// radius itself so the arrow never claims "turn now" further out
// than the SDK considers you to be at the turn. Note: in practice
// crossing this threshold also lands the user in the at-pivot
// "Now / Turn right onto X" HUD frame, which doesn't render the
// arrow line — so the ←/→ glyph effectively never shows on screen
// at this setting. ↑ is what the user sees the entire approach.
const ARROW_APPROACH_M_WALKING = PIVOT_RADIUS_M_WALKING

/**
 * Merge the trip-wide pivot radius default into a StartNavigationOptions
 * payload. Preserves any caller-supplied `pivots` block so an explicit
 * override from the UI still wins.
 */
function withPivotDefaults<T extends {pivots?: {radiusMeters?: number; approachThresholdMeters?: number}}>(opts: T): T {
  return {
    ...opts,
    pivots: {
      radiusMeters: PIVOT_RADIUS_M_WALKING,
      ...(opts.pivots ?? {}),
    },
  }
}

// Off-route distance thresholds (meters). Widened from 15/30 to 20/35
// so opposite-sidewalk crossings at typical urban 4-way intersections
// don't read as deviations. Walking the far curb across a 4-lane road
// (~15m wide including parking) lands you ~12-18m from Google's
// route polyline — narrow enough to fall under the advisory band
// instead of triggering a spurious rebuild.
const OFF_ROUTE_ADVISORY_M = 20
const OFF_ROUTE_TRIGGER_M = 35

/**
 * Strip the trailing arrival-side hint Google's Routes API appends to
 * the final step's instruction string (e.g.
 *   "Turn right onto Octavia St | Destination will be on the left"
 * becomes
 *   "Turn right onto Octavia St"
 * ). The pipe is the canonical delimiter, but we also handle the
 * occasional period-separated variant. Returns empty string for null
 * / undefined so the cache zip stays length-aligned with the SDK's
 * live step list.
 */
function cleanInstruction(raw: string | null | undefined): string {
  if (!raw) return ""
  // Remove "Destination will be on the left/right" (with or without
  // a preceding " | " or ". " delimiter). Trim trailing whitespace
  // and stray punctuation left behind by the removal.
  return raw
    .replace(/\s*[|.]?\s*destination will be on the (left|right)\s*\.?\s*$/i, "")
    .trim()
}

/**
 * Diagnostic log fired whenever the live trip's onRoute event lands.
 * Mirrors the `[NavPreview]` block the miniapp prints during preview,
 * so we can eyeball-compare preview vs live for the same destination.
 *
 * Post-Phase-2 the route this sees should be REST-derived (synthetic
 * onRoute from navigation.start). Reroutes still fall through the
 * native path until Phase 3 — when those land here, the polyline and
 * step shape are the Nav SDK's, which is exactly what we want to
 * spot.
 */
function logLiveRoute(route: NavRoute): void {
  const steps = route.steps ?? []
  const polyline = route.points ?? []
  const annotated = steps.map((s, i) => ({stepIdx: i, name: s.road ?? null}))
  const roads: string[] = []
  for (const a of annotated) {
    if (!a.name) continue
    if (roads.length > 0 && roads[roads.length - 1].toLowerCase() === a.name.toLowerCase()) continue
    roads.push(a.name)
  }
  console.log(`[NavLive] roads: ${roads.join(" → ")}`)
  console.log(
    `[NavLive] resolution:\n` + annotated.map((a) => `  step ${a.stepIdx} → ${a.name ?? "(none)"}`).join("\n"),
  )
  console.log(
    `[NavLive] steps:\n` +
      steps
        .map((s, i) => `  step ${i}: ${s.road ?? "(unnamed)"} | ${s.maneuver ?? "—"} | ${s.distanceMeters}m`)
        .join("\n"),
  )
  const stride = Math.max(1, Math.ceil(polyline.length / 30))
  const sampled = polyline.filter((_, i) => i % stride === 0 || i === polyline.length - 1)
  console.log(
    `[NavLive] polyline (${polyline.length} pts, showing ${sampled.length}):\n` +
      sampled.map((p, i) => `  ${i}: ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`).join("\n"),
  )
  // Turn list derived from road→road transitions, same logic the
  // preview block uses minus the polyline-bend filter (we trust the
  // SDK's resolved step list at this point).
  const turns: string[] = []
  for (let i = 0; i < annotated.length - 1; i++) {
    const here = annotated[i]
    const next = annotated[i + 1]
    if (!here.name || !next.name) continue
    if (here.name.toLowerCase() === next.name.toLowerCase()) continue
    const junction = steps[here.stepIdx]
    turns.push(
      `  ${turns.length}: ${here.name} → ${next.name} @ (${junction.lat.toFixed(5)}, ${junction.lng.toFixed(5)})`,
    )
  }
  console.log(`[NavLive] turns (${turns.length}):\n${turns.join("\n")}`)
}
