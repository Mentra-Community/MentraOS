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
  TravelMode,
  UIModule,
} from "@mentra/miniapp/background"

import type {Channels} from "../shared/channels"
import type {
  Coords,
  DevSettings,
  GlassesCapabilitySnapshot,
  LogEntry,
  NavSnapshot,
  TripState,
  UnitSystem,
  VoiceGuidanceMode,
} from "../shared/types"
import {deriveManeuverDisplay, liveDistanceToNextTurn} from "../shared/maneuverDisplay"

import {getSavedAddresses, setSavedAddress} from "./actions/savedAddressActions"
import type {PlaceDetails} from "./lib/places"
import {AudioGuidanceManager, selectAudioGuidanceDistance} from "./managers/AudioGuidanceManager"
import {CompassManager} from "./managers/CompassManager"
import {DisplayManager} from "./managers/DisplayManager"
import {LocationManager} from "./managers/LocationManager"
import {NavigationManager} from "./managers/NavigationManager"
import {PlacesManager} from "./managers/PlacesManager"
import {SimpleStorageManager} from "./managers/SimpleStorageManager"
import {renderManeuverArrowBmp} from "./lib/ArrowRenderer"
import {formatDistance, formatDuration} from "./lib/formatDistance"
import {
  bearingDeg,
  distanceToPolylineMeters,
  haversineMeters,
  nextSegmentBearing,
  remainingRoutePoints,
  remainingRouteMeters,
  sideOfFinalSegment,
  type LatLng,
} from "./lib/geometry"
import {TEST_BITMAP_288_B64} from "./lib/testBitmap"
import {borderTestImageBase64} from "./lib/bmp"
import {buildOsmLineMap, fetchOsmRoads, renderOsmLineMap} from "./lib/OsmLineMapRenderer"

export class NavigationController {
  private readonly ui: UIModule<Channels>
  private readonly location: LocationManager
  private readonly compass: CompassManager
  private readonly display: DisplayManager
  private readonly navigation: NavigationManager
  private readonly storage: SimpleStorageManager
  private readonly places: PlacesManager
  private readonly audioGuidance: AudioGuidanceManager

  // PoC OSM map: current view center, mutated by the pan buttons. Starts at
  // Hayes Valley, SF.
  private osmMapCenter = {lat: 37.7766853, lng: -122.4229361}
  private readonly OSM_MAP_SIZE = 88
  private readonly OSM_MAP_RADIUS_M = 133

  private unsubs: Array<() => void> = []
  private started = false
  private logSeq = 0
  private lastHudKey = ""
  // Direction key of the last arrow bitmap pushed — re-ENCODE the arrow only
  // when the turn direction changes (rasterizing the BMP is the cost; resending
  // is free — the host diffs frames and unchanged elements never re-cross BLE).
  private lastArrowKey = ""
  // Timestamp of the last HUD push, so we can periodically re-push the maneuver
  // text even when unchanged (recovers from G2 EvenHub page teardowns).
  private lastHudAt = 0
  private lastMinimapPng: string | null = null
  // Throttle for the minimap raster: the bitmap is the most expensive HUD
  // element to render AND push, and GPS can fire many fixes per second (esp.
  // simulated/fast movement). Rendering + sending on every fix wastes CPU and
  // can flood the glasses' BLE link (the G2 can't usefully update faster than
  // ~200-300ms). So we leading-edge throttle: render immediately, coalesce
  // bursts within MINIMAP_MIN_INTERVAL_MS, and schedule ONE trailing render so
  // the final position still lands after the burst settles.
  private lastMinimapAt = 0
  private minimapTrailingTimer: ReturnType<typeof setTimeout> | null = null
  // Minimap refresh watchdog. In the field (and esp. in demos) the stream of
  // GPS fixes that drives refreshMinimap() can go quiet — the phone stops
  // emitting fixes, the route settles, or the G2 swallows a send. When that
  // happens the last bitmap is the most recent thing on the glasses, but if the
  // page was torn down it may be blank. So: a recurring timer checks whether a
  // minimap has been pushed within MINIMAP_WATCHDOG_IDLE_MS; if not, it forces a
  // fresh re-render (bypassing the unchanged-png dedup) so the map keeps
  // refreshing indefinitely while a trip is running. Runs every
  // MINIMAP_WATCHDOG_INTERVAL_MS; started on trip start, stopped on dispose.
  private minimapWatchdogTimer: ReturnType<typeof setInterval> | null = null
  // Timestamp of the last time a bitmap was ACTUALLY pushed to the glasses
  // (showBitmap), as opposed to lastMinimapAt which is set on every render
  // ATTEMPT (even ones the png-dedup then drops). The watchdog keys off this so
  // it correctly detects "the glasses haven't received a new bitmap in a while"
  // even while the HUD pump keeps calling refreshMinimap() with unchanged maps.
  private lastMinimapPushAt = 0
  // How long the minimap can go without a push before the watchdog forces one.
  private readonly MINIMAP_WATCHDOG_IDLE_MS = 2000
  // How often the watchdog checks for staleness (and the steady re-push cadence
  // once updates have gone quiet).
  private readonly MINIMAP_WATCHDOG_INTERVAL_MS = 2000
  // Set true for the duration of a watchdog-forced refresh so refreshMinimap()
  // bypasses its png-unchanged dedup (line ~1544) — otherwise a quiet,
  // unchanged map would never actually re-reach the glasses.
  private forceMinimapPush = false
  // Watchdog for a stuck "Starting…" HUD. The HUD leaves "Starting…" when a
  // maneuver event (or a live pivot) arrives — but in the field the maneuver
  // event sometimes never fires (the G2 tears down the EvenHub page mid-start,
  // routes recompute back-to-back and reset the cursor, etc.), leaving the user
  // stuck on "Starting…" with a perfectly good route on hand. This records when
  // "Starting…" first showed; once it's been up past STARTING_WATCHDOG_MS while
  // running with route steps available, refreshHUD falls back to the route's
  // FIRST step so the HUD recovers instead of hanging. Reset whenever we leave
  // the "Starting…" state.
  private startingShownAt = 0
  // Glasses minimap bitmap — ON by default.
  private showMinimap = true
  // Last trip-stats string pushed to the bottom-left label, so we only re-send
  // when distance/ETA actually changes (avoids churning the G2 text container).
  private lastTripStats = ""
  // Timestamp of the last bottom-left trip-stats push, so we can periodically
  // re-send even when the content is unchanged (recovers from G2 page teardowns).
  private lastTripStatsAt = 0
  // True while the swipe-up large-map view is showing. Suppresses the normal HUD
  // pump so it doesn't repaint the minimap/text over the large map.
  private largeMapShown = false
  // Lock held while a large-map transition (show or dismiss) is mid-flight —
  // i.e. between the clear() and the deferred render that follows the settle
  // delay. Swipes that arrive during this window are IGNORED. Without it,
  // rapid/accidental repeat swipes start overlapping show↔dismiss cycles whose
  // clears, deferred renders, and largeMapShown toggles interleave and corrupt
  // the display ("swiped a couple times and everything broke").
  private largeMapTransitioning = false
  // Re-entrancy guard for nav:start. The Start button (and some upstream
  // flows) can dispatch nav:start twice in quick succession; the second
  // start()'s internal stop() tears down the sim/trip session the first one
  // just spun up, freezing the puck (maneuver + trip distance stuck at one
  // value). Held across the async start() so a duplicate start is ignored.
  private starting = false
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

  // Movement-vector heading for the minimap "you" arrow. Instead of assuming
  // the arrow points along the route, we derive the TRUE direction of travel
  // from the user's own displacement: when they move ≥ MOVE_BEARING_MIN_M from
  // the last anchor, the bearing anchor→current IS the heading. We hold the
  // last computed bearing between moves so the arrow doesn't spin while the
  // user stands still (GPS jitter) or snap back to the route direction.
  private moveBearingAnchor: LatLng | null = null
  private moveBearingDeg: number | null = null
  private readonly MOVE_BEARING_MIN_M = 3
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
    largeMapEnabled: false,
  }

  // User's distance-unit preference. Loaded from storage in start() and
  // mirrored into every snapshot. Drives formatDistance() across the
  // glasses HUD and (via the snapshot) the UI. Defaults to metric until
  // the stored value loads.
  private unitSystem: UnitSystem = "metric"
  private capabilities: GlassesCapabilitySnapshot = {
    modelName: null,
    hasDisplay: false,
    canPosition: false,
    hasSpeaker: false,
    hasButton: false,
  }
  private voiceGuidanceMode: VoiceGuidanceMode = "off"
  private voiceGuidancePreferenceLoaded = false
  private voiceGuidancePreferenceExplicit = false
  private routeRevision = 0

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
    // Place search routes through the SDK → host → v2 cloud maps (Mapbox Search
    // Box). No Worker, no provider key in this bundle.
    this.places = new PlacesManager(session)
    this.audioGuidance = new AudioGuidanceManager(session.speaker, (message) => this.appendLog(message))
  }

  start(): void {
    if (this.started) return
    this.started = true

    this.applyCapabilities(this.session.capabilities)
    this.loadVoiceGuidanceMode()

    this.wireSensorSubscriptions()
    this.wireCapabilityChanges()
    this.wireRpcHandlers()
    this.wireUIBroadcasts()
    this.registerActions()
    this.wireHUDPump()
    this.wireTouchGestures()
    this.wireRepeatButton()
    this.primeNavigationPermission()
    this.seedInitialFix()
    this.loadUnitSystem()

    this.session.onBeforeDisconnect(() => this.dispose())
  }

  private readCapabilities(capabilities: MiniappSession["capabilities"]): GlassesCapabilitySnapshot {
    const record = (capabilities ?? {}) as Record<string, unknown>
    const display =
      record.display && typeof record.display === "object" ? (record.display as Record<string, unknown>) : null
    return {
      modelName: typeof record.modelName === "string" ? record.modelName : null,
      hasDisplay: record.hasDisplay === true || !!record.display,
      // G1/Z100 advertise canPosition:false and need a compact text wall.
      // Treat an absent field as false so older hosts get the safe fallback.
      canPosition: display?.canPosition === true,
      hasSpeaker: record.hasSpeaker === true,
      hasButton: record.hasButton === true,
    }
  }

  private defaultVoiceGuidanceMode(capabilities = this.capabilities): VoiceGuidanceMode {
    if (!capabilities.hasSpeaker) return "off"
    return capabilities.hasDisplay ? "essential" : "full"
  }

  private applyCapabilities(raw: MiniappSession["capabilities"]): void {
    const previous = this.capabilities
    this.capabilities = this.readCapabilities(raw)
    this.audioGuidance.setAvailable(this.capabilities.hasSpeaker)
    if (!this.voiceGuidancePreferenceExplicit) {
      this.voiceGuidanceMode = this.defaultVoiceGuidanceMode()
      this.audioGuidance.setMode(this.voiceGuidanceMode)
    }
    if (!this.capabilities.hasDisplay) {
      this.stopMinimapWatchdog()
      this.lastMinimapPng = null
    } else if (!previous.hasDisplay && this.trip.running) {
      this.startMinimapWatchdog()
      this.lastHudKey = ""
      this.refreshHUD()
    } else if (previous.canPosition !== this.capabilities.canPosition && this.trip.running) {
      // A glasses swap can change the HUD from a compact text wall to a
      // positioned scene (or vice versa) without changing hasDisplay.
      if (this.capabilities.canPosition) {
        this.startMinimapWatchdog()
      } else {
        this.stopMinimapWatchdog()
        this.lastMinimapPng = null
      }
      this.lastHudKey = ""
      this.refreshHUD()
    }
    this.broadcastVoiceGuidanceState()
  }

  private wireCapabilityChanges(): void {
    // registerMiniapp invokes start() before connect(), so the initial read
    // above sees null. CONNECT_ACK populates session.capabilities and emits
    // "ready" (not a capabilities-change event); refresh from the session once
    // that handshake lands so speaker-only glasses work on first launch.
    this.unsubs.push(this.session.on("ready", () => this.applyCapabilities(this.session.capabilities)))
    this.unsubs.push(this.session.onCapabilitiesChange((capabilities) => this.applyCapabilities(capabilities)))
  }

  private broadcastVoiceGuidanceState(): void {
    this.ui.send("nav:voice-guidance-update", {
      voiceGuidanceMode: this.voiceGuidanceMode,
      capabilities: this.capabilities,
    })
  }

  private loadVoiceGuidanceMode(): void {
    this.storage
      .getVoiceGuidanceMode()
      .then((stored) => {
        // A user choice made while the read was in flight wins over the stale
        // stored value that was captured before that choice was persisted.
        if (this.voiceGuidancePreferenceLoaded) return
        this.voiceGuidancePreferenceLoaded = true
        this.voiceGuidancePreferenceExplicit = stored != null
        this.voiceGuidanceMode = stored ?? this.defaultVoiceGuidanceMode()
        this.audioGuidance.setMode(this.voiceGuidanceMode)
        this.broadcastVoiceGuidanceState()
      })
      .catch((err) => {
        if (this.voiceGuidancePreferenceLoaded) return
        this.voiceGuidancePreferenceLoaded = true
        this.appendLog(`voice-guidance load failed: ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  private wireRepeatButton(): void {
    this.unsubs.push(
      this.session.input.onButtonPress((data) => {
        if (data.pressType !== "short" || !this.trip.running || !this.capabilities.hasButton) return
        if (this.audioGuidance.repeatCurrent()) this.appendLog(`VOICE repeat (${data.buttonId})`)
      }),
    )
  }

  // ── Sensor → state pump ──────────────────────────────────────────────

  private wireSensorSubscriptions(): void {
    // Location
    this.unsubs.push(
      this.location.onUpdate((d) => {
        const here: LatLng = {lat: d.lat, lng: d.lng}
        // Movement-vector heading: derive the TRUE direction of travel from the
        // user's displacement. Seed the anchor on the first fix; thereafter,
        // once they've moved ≥ MOVE_BEARING_MIN_M from the anchor, the bearing
        // anchor→here is the heading, and we re-anchor. Below that threshold we
        // keep the last bearing (so the arrow holds steady through GPS jitter /
        // standing still instead of spinning).
        if (this.moveBearingAnchor == null) {
          this.moveBearingAnchor = here
        } else if (haversineMeters(this.moveBearingAnchor, here) >= this.MOVE_BEARING_MIN_M) {
          this.moveBearingDeg = bearingDeg(this.moveBearingAnchor, here)
          this.moveBearingAnchor = here
        }
        this.coords = {
          lat: d.lat,
          lng: d.lng,
          accuracy: d.accuracy,
          ts: d.timestamp ?? Date.now(),
        }
        this.lastCoordsAt = Date.now()
        this.ui.send("nav:coords", this.coords)
        // The maneuver card's "In X m" distance is recomputed LIVE from these
        // coords on BOTH surfaces directly — the glasses HUD in refreshHUD() and
        // the phone OrientationCard in-component — via the shared
        // liveDistanceToNextTurn helper. So there's nothing to freshen here:
        // refreshHUD() (called below) picks up the new coords, and the phone
        // re-renders off nav:coords. No background→UI re-broadcast needed.
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
            // The previous maneuver belongs to the abandoned route. Clear it
            // so neither display nor audio can replay stale guidance while the
            // replacement route is landing.
            this.trip = {...this.trip, status: "rerouting", maneuver: null}
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
            // If the large map is up at arrival, drop out of it so the
            // "You have arrived" HUD can actually paint (refreshHUD early-
            // returns while largeMapShown).
            this.exitLargeMap()
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
            this.exitLargeMap()
            break
        }
        this.ui.send("nav:trip-state", this.trip)
        this.refreshHUD()
      }),
    )

    // Route updates (full polyline rebuild)
    this.unsubs.push(
      this.navigation.onRoute((route: NavRoute) => {
        this.routeRevision += 1
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
          this.refreshHUD()
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

    this.unsubs.push(this.ui.handle("places:autocomplete", ({query, near}) => this.places.autocomplete(query, near)))
    this.unsubs.push(this.ui.handle("places:details", ({placeId}) => this.places.details(placeId)))
    this.unsubs.push(
      this.ui.handle("places:reverse-geocode", ({lat, lng}) => this.navigation.reverseGeocode({lat, lng})),
    )

    this.unsubs.push(this.ui.handle("storage:list-saved", () => this.storage.getAllSavedPlaces()))
    this.unsubs.push(this.ui.handle("storage:add-saved", (p) => this.storage.addSavedPlace(p)))
    this.unsubs.push(this.ui.handle("storage:remove-saved", ({placeId}) => this.storage.removeSavedPlace(placeId)))
    this.unsubs.push(this.ui.handle("storage:list-recent", () => this.storage.getRecentSearches()))
    this.unsubs.push(this.ui.handle("storage:add-recent", (p) => this.storage.addRecentSearch(p)))
  }

  // ── Trip start (shared by the UI's nav:start and the start_navigation action) ──

  /**
   * Begin a turn-by-turn trip. Drives both the UI's `nav:start` broadcast and
   * the `start_navigation` action so they share one path: optimistic trip
   * state, glasses HUD repaint, then `navigation.start()`, rolling back to idle
   * if the native start fails. Resolves `{ok, error?}` for the action; the UI
   * listener ignores the return.
   */
  private async beginTrip(
    opts: StartNavigationOptions & {destinationName?: string},
  ): Promise<{ok: boolean; error?: string}> {
    // Re-entrancy guard: ignore a second start while one is already in flight
    // (the duplicate's start() would stop() the session the first just created
    // and freeze the puck).
    if (this.starting) {
      this.appendLog("START ignored — already starting")
      return {ok: false, error: "A navigation start is already in progress"}
    }
    this.starting = true
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
    this.audioGuidance.beginTrip()
    this.startMinimapWatchdog()
    this.tripStartCoords = this.coords ? {lat: this.coords.lat, lng: this.coords.lng} : null
    // Reset the movement-vector heading so this trip's "you" arrow measures
    // direction of travel fresh (anchor re-seeds on the next fix).
    this.moveBearingAnchor = this.coords ? {lat: this.coords.lat, lng: this.coords.lng} : null
    this.moveBearingDeg = null
    this.lastAutoRebuildAt = 0
    this.lastOffRouteBucket = 0
    this.offRouteAdvisory = false
    this.offRouteAdvisoryDistanceM = null
    // Clear any pivots left over from a previous trip. Without this, a new
    // start with stale activePivot/upcomingPivot would make refreshHUD take
    // a pivot branch and show the OLD trip's instruction instead of
    // "Starting…" — the HUD must read "Starting…" until THIS trip's first
    // real maneuver/pivot lands.
    this.activePivot = null
    this.upcomingPivot = null
    // Cancel any in-flight delayed rebuild — a fresh start
    // supersedes the old "are we still off-route?" timer.
    this.cancelPendingRebuild()
    this.appendLog(`START ${destinationName ?? "(unnamed)"}`)
    this.ui.send("nav:trip-state", this.trip)
    // Repaint the glasses HUD immediately so the left text flips from the
    // idle "Welcome to Mentra Maps!" frame to "Starting…" the instant the
    // user starts — instead of the welcome frame lingering until the next
    // GPS tick / HUD pump (~1s). running is already true above, so refreshHUD
    // takes the "Starting…" branch and showManeuver overwrites the welcome
    // text in place.
    this.refreshHUD()
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
        this.rollbackTripToIdle()
      } else {
        this.audioGuidance.confirmTripStarted(destinationName ?? null)
      }
      return res
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.appendLog(`START error: ${error}`)
      this.rollbackTripToIdle()
      return {ok: false, error}
    } finally {
      this.starting = false
    }
  }

  /**
   * Roll the optimistic "navigating" trip state back to idle after a failed
   * start. Clears the destination and route fields too — otherwise the phone
   * map keeps a pin on a destination we never actually started routing to.
   */
  private rollbackTripToIdle(): void {
    this.audioGuidance.endTrip()
    this.trip = {
      ...this.trip,
      status: "idle",
      running: false,
      activeDestination: null,
      activeDestinationName: null,
      maneuver: null,
      routePoints: null,
      routeSteps: null,
    }
    this.ui.send("nav:trip-state", this.trip)
    this.refreshHUD()
  }

  // ── Actions (cross-miniapp / AI) ─────────────────────────────────────

  /**
   * Declared in miniapp.json. A system miniapp (e.g. Mentra AI) invokes
   * start_navigation to "navigate to X" — the host headless-wakes us if we're
   * stopped, then delivers the call once start() registers the handler. The
   * destination may be a place query (looked up via Places, biased to the
   * current location) or explicit coordinates.
   */
  private registerActions(): void {
    try {
      this.unsubs.push(this.session.actions.handle("start_navigation", (params) => this.startNavigationAction(params)))
      this.unsubs.push(this.session.actions.handle("get_saved_addresses", () => getSavedAddresses(this.storage)))
      this.unsubs.push(
        this.session.actions.handle("set_saved_address", (params) =>
          setSavedAddress(params, this.storage, (query) => this.resolveDestination(query)),
        ),
      )
    } catch (err) {
      // actions module unavailable on this host, or already registered — the
      // miniapp still runs, but its actions won't be available.
      this.appendLog(`actions register failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async startNavigationAction(
    params: Record<string, unknown>,
  ): Promise<{ok: boolean; error?: string; destination?: {lat: number; lng: number; name?: string}}> {
    if (!this.navigation.hasPermission) {
      return {ok: false, error: "Location permission is required for navigation."}
    }

    const mode = MODES.has(params.travel_mode as TravelMode) ? (params.travel_mode as TravelMode) : "walking"
    const explicitName = typeof params.destination_name === "string" ? params.destination_name.trim() : ""

    // Resolve the destination. A full coordinate pair wins; otherwise fall back
    // to the place query (so a query still works even when a stray/partial
    // coordinate is also present); a lone coordinate with no query is an error.
    const hasLat = typeof params.latitude === "number"
    const hasLng = typeof params.longitude === "number"
    const query = typeof params.query === "string" && params.query.trim() ? params.query.trim() : null

    let dest: {lat: number; lng: number; name?: string} | null = null
    if (hasLat && hasLng) {
      // Validate as finite, in-range coordinates — `typeof NaN === "number"`, so
      // a bare typeof check would let NaN/Infinity flow into the native start.
      const latitude = params.latitude as number
      const longitude = params.longitude as number
      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180
      ) {
        return {ok: false, error: "latitude and longitude must be finite coordinates (|lat| ≤ 90, |lng| ≤ 180)."}
      }
      dest = {lat: latitude, lng: longitude, name: explicitName || undefined}
    } else if (query) {
      dest = await this.resolveDestination(query)
      if (!dest) return {ok: false, error: `Couldn't find a place matching "${query}".`}
    } else if (hasLat || hasLng) {
      return {ok: false, error: "Provide both latitude and longitude, or a destination query."}
    } else {
      return {ok: false, error: "Provide a destination query, or latitude and longitude."}
    }

    const res = await this.beginTrip({
      stops: [{lat: dest.lat, lng: dest.lng}],
      mode,
      destinationName: explicitName || dest.name,
    })
    if (!res.ok) return {ok: false, error: res.error ?? "Failed to start navigation."}
    return {ok: true, destination: dest}
  }

  /**
   * Geocode a place name/address to coordinates via the Places facade, biased
   * to the user's current location. Mirrors the UI's autocomplete → details
   * pick. Returns null when there's no match or the lookup fails.
   */
  private async resolveDestination(query: string): Promise<PlaceDetails | null> {
    try {
      let near = this.coords ? {lat: this.coords.lat, lng: this.coords.lng} : undefined
      // A headless start_navigation invoke can be dispatched before the initial
      // GPS fix lands (seedInitialFix runs later in start()). Grab a one-shot fix
      // so place search is biased to the wearer, per the action contract — and
      // seed this.coords so beginTrip has a start position too.
      if (!near) {
        try {
          const d = await this.location.getOnce()
          near = {lat: d.lat, lng: d.lng}
          if (!this.coords) {
            this.coords = {lat: d.lat, lng: d.lng, accuracy: d.accuracy, ts: d.timestamp ?? Date.now()}
            this.lastCoordsAt = Date.now()
            this.ui.send("nav:coords", this.coords)
          }
        } catch {
          /* no fix yet — fall back to an unbiased search */
        }
      }
      const suggestions = await this.places.autocomplete(query, near)
      if (!suggestions.length) return null
      const details = await this.places.details(suggestions[0].placeId)
      return details
    } catch (err) {
      this.appendLog(`resolveDestination failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  // ── UI broadcast listeners ───────────────────────────────────────────

  private wireUIBroadcasts(): void {
    this.unsubs.push(
      this.ui.on("nav:start", async (opts) => {
        await this.beginTrip(opts)
      }),
    )
    this.unsubs.push(
      this.ui.on("nav:stop", () => {
        this.appendLog("STOP")
        this.audioGuidance.endTrip()
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
        this.stopMinimapWatchdog()
        // If the swipe-up large map is showing, drop out of it so the trip's
        // end actually clears the glasses — otherwise refreshHUD() early-
        // returns (it won't paint over the large map) and the big map lingers
        // on screen after the trip is over.
        this.exitLargeMap()
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
      this.ui.on("nav:reset-location", () => {
        // Dev: snap the map back to the device's REAL current location.
        // After a simulated trip the puck is parked at the sim destination
        // (the native sim drove it there); this stops any active trip and
        // forces a fresh one-shot fix, then broadcasts it as nav:coords so
        // the map re-centers on where the device actually is.
        this.appendLog("RESET LOCATION → real fix")
        this.audioGuidance.endTrip()
        try {
          this.navigation.stop()
        } catch {
          /* ignore */
        }
        // Return the page to idle so the map isn't holding a stale trip.
        this.cancelPendingRebuild()
        this.tripStartCoords = null
        this.lastStartOpts = null
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
        this.ui.send("nav:trip-state", this.trip)
        this.refreshHUD()
        // Force-fetch a fresh fix and broadcast it. Unlike seedInitialFix,
        // this overwrites existing coords on purpose — the whole point is to
        // discard the sim-endpoint position and jump to reality.
        this.location
          .getOnce()
          .then((d) => {
            this.coords = {lat: d.lat, lng: d.lng, accuracy: d.accuracy, ts: d.timestamp ?? Date.now()}
            this.lastCoordsAt = Date.now()
            this.ui.send("nav:coords", this.coords)
            this.appendLog(`reset → ${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`)
          })
          .catch((err) => {
            this.appendLog(`reset-location fix failed: ${err instanceof Error ? err.message : String(err)}`)
          })
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
        const rawJustEnabled = partial.useRawInstructions === true && !this.devSettings.useRawInstructions
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
      this.ui.on("nav:set-voice-guidance", ({mode}) => {
        if (mode === this.voiceGuidanceMode) return
        this.voiceGuidancePreferenceLoaded = true
        this.voiceGuidancePreferenceExplicit = true
        this.voiceGuidanceMode = mode
        this.audioGuidance.setMode(mode)
        this.storage.setVoiceGuidanceMode(mode).catch((err) => {
          this.appendLog(`voice-guidance persist failed: ${err instanceof Error ? err.message : String(err)}`)
        })
        this.broadcastVoiceGuidanceState()
        this.refreshHUD()
      }),
    )

    this.unsubs.push(
      this.ui.on("nav:repeat-direction", () => {
        if (!this.audioGuidance.repeatCurrent()) this.appendLog("VOICE repeat ignored — no active direction")
      }),
    )

    this.unsubs.push(
      this.ui.on("nav:set-show-minimap", (show) => {
        if (show === this.showMinimap) return
        this.showMinimap = show
        if (!show) {
          // Drop just the minimap slot — the HUD frame re-renders without it
          // (clear() would blank the whole HUD until the next nav tick).
          // Reset the dedup cache so toggling back on re-pushes the frame.
          if (this.capabilities.hasDisplay) this.display.clearMinimap()
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
      this.ui.handle("test:show-large-map", async () => {
        if (!this.coords) return {ok: false, error: "no GPS fix yet"}
        const me: LatLng = {lat: this.coords.lat, lng: this.coords.lng}
        // Fetch roads if we don't have any cached yet, then render the large map.
        if (!this.osmRoadsCache) {
          try {
            this.osmRoadsCache = await fetchOsmRoads(me, this.OSM_MINIMAP_RADIUS_M * 2)
            this.osmRoadsCenter = me
          } catch (err) {
            return {ok: false, error: err instanceof Error ? err.message : String(err)}
          }
        }
        this.renderLargeMap(me)
        return {ok: true}
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

    this.unsubs.push(
      this.ui.handle("test:count-both-boxes", () => {
        this.runCountBothBoxesTest()
      }),
    )

    // Mid-trip hydration: every fresh WebView open gets a snapshot.
    this.unsubs.push(this.ui.onOpen(() => this.ui.send("nav:snapshot", this.buildSnapshot())))
  }

  /**
   * Delay probe (dev panel). Shows the minimap bitmap top-right, then counts
   * BOTH text containers — top-left maneuver + bottom-left stats — down from
   * 100 to 0 on the SAME tick, once per second, through the real
   * showManeuver/showTripStats path (so it exercises the production 200ms
   * text queue). If the two boxes stay locked together the queue is fine; if
   * one trails the other, that's the delay you're seeing. Auto-stops at 0.
   * Tapping again while running is ignored (guard) so timers don't stack.
   */
  private countBothBoxesTimer: ReturnType<typeof setInterval> | null = null
  private runCountBothBoxesTest(): void {
    if (this.countBothBoxesTimer != null) return // already running — ignore re-tap
    // Top-right minimap bitmap stays up for the whole count.
    this.display.showBitmap(borderTestImageBase64(100, 100))
    let n = 100
    const tick = () => {
      // Same value, same tick, into both containers via the real queue.
      this.display.showManeuver(`Top\n${n}`)
      this.display.showTripStats(`Bottom\n${n}`)
      if (n <= 0) {
        if (this.countBothBoxesTimer != null) {
          clearInterval(this.countBothBoxesTimer)
          this.countBothBoxesTimer = null
        }
        return
      }
      n--
    }
    tick() // show 100 immediately
    this.countBothBoxesTimer = setInterval(tick, 1000)
  }

  // ── OSM line-map PoC ─────────────────────────────────────────────────
  /** Fetch + render the OSM road map at the current osmMapCenter and push it. */
  private async renderOsmMap(reason: string): Promise<{ok: boolean; error?: string}> {
    const {lat, lng} = this.osmMapCenter
    const SIZE = this.OSM_MAP_SIZE
    console.log(`[OSM-MAP] 🗺️  ${reason} — fetching roads around ${lat.toFixed(6)},${lng.toFixed(6)} (${SIZE}×${SIZE})`)
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

    // Steady HUD tick while navigating. The distance-to-next-turn and
    // total-distance-remaining are recomputed inside refreshHUD() from
    // `this.coords`, but refreshHUD() is otherwise only called when a
    // GPS fix arrives. On Android the location stream batches/stutters
    // (power-save, urban canyon, indoor), so fixes can lag several
    // seconds — and the displayed meters freeze in the gap, going stale
    // while the user is clearly still moving. Recompute on a fixed ~1s
    // cadence so the numbers decrement smoothly regardless of GPS
    // jitter. Gated on `trip.running` so we don't repaint when idle, and
    // refreshHUD()'s own coalescing (identical-frame + 3s window)
    // prevents redundant pushes when nothing actually changed.
    const HUD_TICK_MS = 1000
    const tick = setInterval(() => {
      if (!this.trip.running) return
      try {
        this.refreshHUD()
      } catch {
        /* ignore */
      }
    }, HUD_TICK_MS)
    this.unsubs.push(() => clearInterval(tick))
  }

  // ── G2 touch gestures ────────────────────────────────────────────────
  // Swipe-up DURING live navigation → clear the HUD (minimap + stats + text)
  // and show the large full map. (Swipe-down / tap returns to the HUD.)
  private wireTouchGestures(): void {
    this.unsubs.push(
      this.session.input.onTouch((data) => {
        if (!this.capabilities.hasDisplay) return
        // `data.kind` carries the gesture (single_tap / double_tap / swipe_up /
        // swipe_down / ...); gestureName is a fallback for older host builds.
        const d = data as unknown as Record<string, unknown>
        const gesture = String(d.kind ?? d.gestureName ?? "")

        // system_exit = the glasses tore down our EvenHub page (dashboard etc).
        // Do NOT touch largeMapShown here — it fires constantly and would
        // repaint the HUD over the user's swipe box immediately. The HUD
        // recovers on its own via the periodic re-push in refreshHUD.
        if (gesture === "system_exit") return

        // Only react while actually navigating.
        if (!this.trip.running) {
          console.log(`[TOUCH] ignored — not in live navigation`)
          return
        }

        const isSwipe = gesture === "swipe_up" || gesture === "swipe_down"
        if (!isSwipe) return

        // Large map is a dev-gated WIP feature, OFF by default. When disabled,
        // swipes do nothing (no large-map switch).
        if (!this.devSettings.largeMapEnabled) {
          console.log(`[TOUCH] swipe ignored — large map disabled (dev toggle off)`)
          return
        }

        // LOCK: ignore swipes while a show/dismiss transition is mid-flight
        // (clear() → settle delay → render). Rapid/accidental repeat swipes
        // would otherwise overlap and corrupt the display.
        if (this.largeMapTransitioning) {
          console.log(`[TOUCH] swipe ignored — large-map transition in flight`)
          return
        }

        // Toggle: any swipe shows the box; any swipe while it's showing dismisses
        // it and brings back the original HUD.
        if (!this.largeMapShown) {
          console.log(`[TOUCH] swipe → showing large route map`)
          this.showLargeMap() // sets largeMapShown + transition lock, replaces, draws
        } else {
          console.log(`[TOUCH] swipe → dismissing large map → HUD`)
          this.largeMapShown = false
          // Switch large map → HUD by REPLACING containers in place (no
          // full-view clear()/teardown / settle delay). The HUD's maneuver text
          // spans the FULL canvas, so repainting it overwrites the centered
          // large-map bitmap; refreshHUD also re-pushes the top-right minimap.
          // Reset the dedup so the repaint isn't swallowed, then repaint now.
          this.lastHudKey = ""
          this.lastMinimapPng = null
          this.refreshHUD()
        }
      }),
    )
  }

  /**
   * Drop out of the swipe-up large-map view: clear the big map off the
   * glasses and reset large-map state so the normal HUD pump resumes. Safe to
   * call when the large map isn't showing (no-op). Used when a trip ends while
   * the large map is up — without this, refreshHUD() early-returns on
   * `largeMapShown` and the big map lingers after the trip is over.
   */
  private exitLargeMap(): void {
    // Release the swipe lock (transitions are synchronous now — no deferred
    // render to cancel).
    this.largeMapTransitioning = false
    if (!this.largeMapShown) return
    this.largeMapShown = false
    // Erase the large map by overwriting its containers in place (no full-view
    // clear()): blank the top-right minimap rect, and overwrite the full-canvas
    // maneuver region with empty text (which covers the centered large map).
    // The caller (trip arrived/stopped) then paints the end-state HUD via
    // refreshHUD, which overwrites the same maneuver region.
    this.lastHudKey = ""
    this.lastMinimapPng = null
    this.display.clearMinimap()
    this.display.clearLoadingMessage() // blanks the full-canvas maneuver text region
  }

  /**
   * Clear the current HUD (minimap bitmap + stats text + maneuver text), then
   * render the large map. Sets `largeMapShown` so the HUD pump stops repainting
   * over it until the user swipes back down.
   */
  private showLargeMap(): void {
    this.largeMapShown = true
    this.largeMapTransitioning = true // lock out swipes until the render lands
    // Switch HUD → large map by REPLACING the specific containers in place, not
    // a full-view clear(). The HUD pump is gated off by `largeMapShown`, so
    // nothing repaints over us. We:
    //   • erase the top-right minimap rect (clearMinimap overwrites it blank —
    //     the large map is a different rect so it wouldn't cover the minimap),
    //   • overwrite the full-canvas maneuver-text region with the loading line,
    //   • then draw the large map into its own (centered) rect.
    // No async full teardown, so no settle delay / race — the draws just
    // overwrite their containers. Reset the dedup so swiping back down repaints.
    this.lastHudKey = ""
    this.lastMinimapPng = null
    this.display.clearMinimap()
    // Overwrites the maneuver text region; doubles as "loading" feedback.
    this.display.showLoadingMessage("Loading large map")
    if (!this.coords) {
      // No fix to render — release the lock so the view isn't stuck locked.
      this.largeMapTransitioning = false
      return
    }
    const me: LatLng = {lat: this.coords.lat, lng: this.coords.lng}

    // Render the large map now (its own centered rect). Blank the loading text
    // first so it doesn't linger over the map. No settle delay needed: there's
    // no full-view teardown to wait on — each push overwrites its container.
    this.display.clearLoadingMessage()
    this.renderLargeMap(me)
    this.largeMapTransitioning = false // render landed; release the lock

    // 3. The minimap road cache only covers a tight radius around the user, so
    //    the far end of the route would have no background streets. Fetch roads
    //    covering the ENTIRE route bounding box, then re-render.
    const route = this.trip.routePoints
    if (route && route.length >= 2 && !this.osmFetchInFlight) {
      const lats = [...route, me].map((p) => p.lat)
      const lngs = [...route, me].map((p) => p.lng)
      const center: LatLng = {
        lat: (Math.min(...lats) + Math.max(...lats)) / 2,
        lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
      }
      const halfH =
        haversineMeters({lat: Math.min(...lats), lng: center.lng}, {lat: Math.max(...lats), lng: center.lng}) / 2
      const halfW =
        haversineMeters({lat: center.lat, lng: Math.min(...lngs)}, {lat: center.lat, lng: Math.max(...lngs)}) / 2
      const fetchRadius = Math.max(halfH, halfW) * 1.3 + 50
      this.osmFetchInFlight = true
      fetchOsmRoads(center, fetchRadius)
        .then((roads) => {
          this.osmRoadsCache = roads
          this.osmRoadsCenter = center
          if (this.largeMapShown && this.coords) {
            this.renderLargeMap({lat: this.coords.lat, lng: this.coords.lng})
          }
        })
        .catch((err) => console.log("[LARGE-MAP] road fetch failed:", err))
        .finally(() => {
          this.osmFetchInFlight = false
        })
    }
  }

  /** Render + push the large centered map for the current position. */
  private renderLargeMap(me: LatLng): void {
    const w = this.OSM_LARGE_MAP_W
    const h = this.OSM_LARGE_MAP_H
    const route = this.trip.routePoints

    // Zoom to fit the WHOLE route: center on the route's bounding-box midpoint
    // and pick a radius that contains every route point (plus the user), with
    // some padding. Falls back to the minimap radius around the user if there's
    // no usable route yet.
    let center = me
    let viewRadiusMeters = this.OSM_MINIMAP_RADIUS_M
    if (route && route.length >= 2) {
      const pts = [...route, me]
      const lats = pts.map((p) => p.lat)
      const lngs = pts.map((p) => p.lng)
      const minLat = Math.min(...lats)
      const maxLat = Math.max(...lats)
      const minLng = Math.min(...lngs)
      const maxLng = Math.max(...lngs)
      center = {lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2}
      // Half-extent in meters of the larger axis (renderOsmLineMap fits 2×radius
      // into the smaller pixel axis), padded 15% so the path isn't edge-to-edge.
      const halfH = haversineMeters({lat: minLat, lng: center.lng}, {lat: maxLat, lng: center.lng}) / 2
      const halfW = haversineMeters({lat: center.lat, lng: minLng}, {lat: center.lat, lng: maxLng}) / 2
      viewRadiusMeters = Math.max(80, Math.max(halfH, halfW) * 1.15)
    }

    // "You" arrow heading: the TRUE direction of travel from the user's own
    // movement vector (anchor→current, updated every ≥3 m). Fall back to the
    // route's forward bearing, then the compass, only until we've actually
    // moved enough to measure a real heading.
    const routeBearing = nextSegmentBearing(me, route)
    const markerHeading = this.moveBearingDeg ?? routeBearing ?? this.heading
    const png = renderOsmLineMap(this.osmRoadsCache ?? [], {
      center,
      width: w,
      height: h,
      viewRadiusMeters,
      lineWidthPx: 2,
      route,
      marker: markerHeading != null ? {at: me, headingDeg: markerHeading} : null,
    })
    console.log(
      `[LARGE-MAP] render: roads=${this.osmRoadsCache?.length ?? 0} routePts=${route?.length ?? 0} radius=${Math.round(viewRadiusMeters)}m size=${w}x${h} png=${png ? png.length + "b" : "NULL"}`,
    )
    if (png) this.display.showLargeBitmap(png, w, h)
  }

  private refreshHUD(): void {
    const {status, running, activeDestinationName, maneuver, arrivalSide} = this.trip

    // Audio and display consume the same maneuver derivation. Keep this before
    // every display guard so displayless glasses still receive guidance and a
    // large-map overlay never pauses spoken directions.
    const me = this.coords ? {lat: this.coords.lat, lng: this.coords.lng} : null
    const liveDist =
      maneuver?.maneuverType === "ARRIVE"
        ? remainingRouteMeters(me, this.trip.routePoints)
        : liveDistanceToNextTurn(me, this.trip.routePoints, this.trip.routeSteps, remainingRouteMeters, haversineMeters)
    const md = deriveManeuverDisplay(maneuver, status, liveDist)
    this.audioGuidance.observe({
      status,
      running,
      routeRevision: this.routeRevision,
      pivotIndex: this.upcomingPivot?.index ?? null,
      maneuverType: md?.kind ?? null,
      instruction: md?.instruction ?? null,
      // Turn thresholds stay paired with the native event that supplied the
      // type/instruction. ARRIVE is different: md carries the live remaining
      // route distance, so its spoken destination countdown stays current.
      distanceMeters: selectAudioGuidanceDistance(
        maneuver?.maneuverType,
        maneuver?.distanceMeters,
        md?.distanceMeters,
      ),
      offRoute: this.offRouteAdvisory,
      destinationName: activeDestinationName,
      arrivalSide,
      travelMode: this.lastStartOpts?.mode ?? "walking",
      unitSystem: this.unitSystem,
    })

    if (!this.capabilities.hasDisplay || this.largeMapShown) return

    // Minimap runs first so heading-only updates still refresh the map even
    // when the text line below is unchanged (and short-circuits). G1/Z100
    // cannot position or display scene images, so skip the work entirely.
    if (this.capabilities.canPosition) this.refreshMinimap()

    let next: string | null = null
    let durationMs: number | undefined
    // Structured maneuver split for the new 4-slot HUD (arrow bitmap + maneuver
    // text box). Populated only on the normal next-turn frame; when set (and
    // running), refreshHUD sends the split layout instead of the single-container
    // text frame used by the welcome/rerouting/arrived/off-route states.
    let maneuverArrow: string | null = null
    let maneuverBody: string | null = null

    // The next-turn display, derived from the live `maneuver` event via the
    // SHARED helper the phone OrientationCard also uses. Computed once here
    // so the glasses HUD and the phone card read the identical instruction /
    // distance / arrow — single source of truth, no PivotEngine re-derivation.
    //
    // We pass a LIVE distance recomputed from this.coords (same shared helper
    // + same geometry the phone card uses), so the "In X m" line ticks down on
    // every location tick instead of only when a new native maneuver event
    // fires. For the ARRIVE leg the relevant distance is to the destination.
    // Mirrors the phone-side OrientationCard's pickDisplay() — same
    // layout, same source, same precedence. If you tweak one, tweak the
    // other or they'll diverge.
    if (status === "arrived") {
      const at = activeDestinationName ? ` at ${activeDestinationName}` : ""
      // Side of the destination: "on your left/right" when we know it, else
      // "up ahead" (it's straight in front, not to a side).
      const side = arrivalSide ? `, on your ${arrivalSide}` : ", up ahead"
      next = `You have arrived${at}${side}`
      durationMs = 10_000
    } else if (!running && status !== "rerouting" && !this.hasCompletedTrip) {
      // FRESH START ONLY: app just opened, no trip has run yet. Show the
      // welcome prompt and leave it up INDEFINITELY (no durationMs → sticky)
      // until the user picks a destination and a trip starts, at which point
      // `running` flips true and the next-turn HUD takes over. The ~3s
      // re-push in the coalescer keeps it on screen even if the G2 tears
      // down the page.
      //
      // Gated on !hasCompletedTrip so that ENDING a navigation (nav:stop sets
      // hasCompletedTrip=true) clears the glasses and leaves them blank —
      // we do NOT bounce back to the welcome prompt after a trip. `next`
      // stays null below, which clears the HUD.
      next = "Welcome to Mentra Maps!\nPick a destination to get started."
    } else if (status === "rerouting") {
      // Mapbox detected the user off-route and is fetching a new route.
      next = "Rerouting…"
    } else if (this.offRouteAdvisory && running) {
      // OFF ROUTE (≥ ADVISORY_M, before Mapbox reroutes). Replace the normal
      // instruction + stats entirely (GLASSES ONLY) with "Go back in X m", where
      // X is the live perpendicular distance to the route and GROWS the further
      // the user strays. This persists until either:
      //   • Mapbox reroutes (status → "rerouting" above takes over the HUD, then
      //     the new route's instruction/stats), or
      //   • the user returns within ADVISORY_M (bucket 0 → md branch restores the
      //     original instruction + stats).
      // We set `next` to ONLY the go-back line; `stats` is suppressed below so
      // the bottom box doesn't show the (now irrelevant) trip distance/ETA.
      const d = this.offRouteAdvisoryDistanceM
      next = d != null ? `Go back\nin ${formatDistance(d, this.unitSystem)}` : "Go back\nto route"
    } else if (md) {
      // Next-turn HUD. The DISTANCE is driven the SAME way the bottom trip-stats
      // box is — recomputed live from this.coords against the route polyline
      // every location tick (the bottom box proved accurate + low-latency +
      // 1:1 with the phone, while the maneuver event's own distance lagged). So
      // we compute the top-line distance HERE from the live position, with the
      // same fallback chain the bottom box uses, instead of trusting md's
      // (possibly frozen) value. The DIRECTIONS box shows the turn instruction;
      // distance/ETA now live in the TOP stats box, so we no longer put
      // "In X m" / "Arriving in X m" here.
      //
      //   Now                            ← only at the turn (urgency cue, not distance)
      //   Turn left onto Market St       ← Mapbox's verbatim instruction
      if (md.arriving) {
        // Final leg: show the arrival directions (distance is in the top stats box).
        maneuverArrow = "↑"
        maneuverBody = md.instruction || "Arriving"
        next = maneuverBody
      } else {
        // Directions box: NEXT-TURN distance + instruction (mockup: "56 m" /
        // "Turn left onto the walkway"). This next-turn distance is distinct from
        // the top box's distance-to-destination, so it belongs here. "Now"
        // replaces the distance right at the turn. The ARROW and atTurn come from
        // `md` (gated on the EVENT distance), so the glyph/cue always match md.kind.
        const dTurn = liveDist ?? md.distanceMeters
        const distLine = md.atTurn ? "Now" : dTurn != null ? formatDistance(dTurn, this.unitSystem) : null
        maneuverArrow = md.arrow || "↑"
        maneuverBody = [distLine, md.instruction].filter(Boolean).join("\n")
        next = [md.arrow || "↑", distLine, md.instruction].filter(Boolean).join("\n")
      }
    } else if (running) {
      // Running but no maneuver yet — the brief gap right after Start, before
      // Mapbox emits the first step. Normally a neutral "Starting…" with NO
      // arrow (there's no turn/direction to point at yet).
      //
      // WATCHDOG: the maneuver event that clears "Starting…" sometimes never
      // arrives (G2 page teardown mid-start, back-to-back route recomputes
      // resetting the cursor). If we've been stuck on "Starting…" past the
      // threshold AND a computed route is on hand, recover by deriving the line
      // from the route's first navigable step instead of hanging forever.
      const startedAt = this.startingShownAt || Date.now()
      if (this.startingShownAt === 0) this.startingShownAt = startedAt
      const stuck = Date.now() - startedAt >= STARTING_WATCHDOG_MS
      const firstStep = this.firstNavigableStep()
      if (stuck && firstStep) {
        const arrow = arrowFor(firstStep.maneuver, null)
        const onto = isRealRoadName(firstStep.road)
        const dist =
          firstStep.distanceMeters > 0 ? `In ${formatDistance(firstStep.distanceMeters, this.unitSystem)}` : null
        next = [arrow, onto ? `Onto ${onto}` : null, dist].filter(Boolean).join("\n") || `Starting…`
      } else {
        next = `Starting…`
      }
    } else {
      // Not running — make sure the watchdog clock resets for the next trip.
      this.startingShownAt = 0
    }
    // Leaving "Starting…" for any real maneuver/pivot frame clears the watchdog
    // so the next stuck-start is timed fresh.
    if (next !== "Starting…") this.startingShownAt = 0

    if (next == null) {
      // Nothing to display — wipe whatever frame was last on the
      // glasses (the SDK's text HUD persists until cleared/replaced).
      // Without this, after `nav:stop` the user keeps seeing the last
      // "Arriving in Xm" frame indefinitely because the maneuver got
      // cleared but no replacement HUD was ever pushed.
      if (this.lastHudKey !== "") {
        this.lastHudKey = ""
        // clear() wipes the glasses AND the DisplayManager's cached frame
        // slots; reset the arrow-encode memo so the next frame re-encodes.
        this.lastArrowKey = ""
        try {
          this.display.clear()
        } catch {
          /* ignore */
        }
      }
      return
    }
    // SINGLE-CONTAINER HUD: cram everything (maneuver block + trip stats) into
    // the ONE bottom container — the proven-smooth, low-latency, phone-1:1 path.
    // The separate top maneuver box lagged/glitched, so we drop it and blank it.
    // Suppress the trip stats while the off-route "Go back in X m" advisory is
    // showing — the user isn't on the route, so destination distance/ETA are
    // irrelevant; the go-back line owns the whole frame until they return or
    // Mapbox reroutes.
    const showStats = running && !(this.offRouteAdvisory && status !== "rerouting" && status !== "arrived")
    const stats = showStats ? this.buildTripStats() : null

    // Wall-clock time-of-day for the top-LEFT slot (the phone's current time).
    // Recomputed every refresh; the ~1s HUD tick keeps it fresh, and it's folded
    // into the coalescing keys below so a minute rollover forces a re-push.
    const clock = this.buildClock()

    // ── New 4-slot HUD ──────────────────────────────────────────────────
    // On the normal next-turn frame, send the arrow bitmap (left) + maneuver
    // text box (bottom) + trip-stats box (top) as separate canvas components.
    // The minimap (right) was pushed by refreshMinimap() above. Special states
    // (welcome/rerouting/arrived/off-route) have no arrow/stats split and fall
    // through to the single-container text frame below.
    if (maneuverBody != null && running && this.capabilities.canPosition) {
      const key = `hud|${maneuverArrow}|${maneuverBody}|${stats ?? ""}|${clock}`
      const nowHud = Date.now()
      const unchanged = key === this.lastHudKey
      if (unchanged && nowHud - this.lastHudAt <= 3000) return
      const forced = unchanged // unchanged but >3s: periodic re-push (page teardown recovery)
      this.lastHudAt = nowHud
      this.lastHudKey = key

      // Compose the whole HUD frame in one render() call. The arrow bitmap is
      // re-ENCODED only when the direction changes (or on a forced re-push);
      // DisplayManager caches it, so it's present in every frame regardless.
      const arrowChanged = forced || maneuverArrow !== this.lastArrowKey
      if (arrowChanged) this.lastArrowKey = maneuverArrow ?? ""
      this.display.showNavHud({
        arrowBmp: arrowChanged ? renderManeuverArrowBmp(maneuverArrow) : undefined,
        maneuver: maneuverBody,
        stats: stats ?? "",
        clock,
      })
      return
    }

    // Single-container state (welcome / rerouting / arrived / off-route / "Starting…").
    // No HUD bookkeeping needed: render() replaces the frame, and the cached
    // arrow/map slots survive in DisplayManager for when turn-by-turn resumes.

    // Stack the maneuver block over the stats line, blank line between, or just
    // one if the other is absent.
    const combined = [next, stats].filter(Boolean).join("\n\n")

    // Coalesce on the combined frame so we don't re-push identical content.
    // Prefixed "msg|" so a message frame never collides with a "hud|" key.
    // Non-positioning displays have a five-line text wall. Omitting the clock
    // leaves room for the direction (arrow + distance + instruction) before
    // optional trip stats; the old degraded positioned scene put clock/stats
    // first and clipped the instruction off the bottom on G1.
    const displayClock = this.capabilities.canPosition ? clock : null
    const key = `msg|${combined}${durationMs ?? 0}|${displayClock ?? ""}`
    // Re-push every ~3s even when unchanged: the G2 frequently tears down our
    // EvenHub page (system_exit / dashboard), swallowing a one-time send.
    const nowHud = Date.now()
    if (key === this.lastHudKey && nowHud - this.lastHudAt <= 3000) return
    this.lastHudAt = nowHud
    this.lastHudKey = key

    // Render as the "message" frame (positioned at the arrow's left x). The
    // frame replaces turn-by-turn entirely; returning to turn-by-turn replaces
    // it back. Nothing lingers — render() is the whole screen.
    if (this.capabilities.canPosition) {
      this.display.showNavMessage(combined, displayClock)
    } else {
      this.display.showCompactNavHud(next, stats)
    }
  }

  /**
   * The first navigable step of the current route — the first turn the user
   * should take. Skips the leading DEPART/CONTINUE/STRAIGHT "walk along this
   * road" step and returns the first actual turn. Backs the "Starting…"
   * watchdog so a stuck start can show a real instruction. Returns null when
   * there's no route step list yet.
   */
  private firstNavigableStep(): {road: string | null; maneuver: string; distanceMeters: number} | null {
    const steps = this.trip.routeSteps
    if (!steps || steps.length === 0) return null
    const skip = new Set(["DEPART", "CONTINUE", "STRAIGHT", "NAME_CHANGE"])
    const turn = steps.find((s) => !skip.has((s.maneuver ?? "").toUpperCase()))
    return turn ?? steps[0]
  }

  /**
   * Build the trip-stats line: distance remaining + ETA, e.g.
   * "273 m · ⊙ 4 min". Returns null when there's no usable distance.
   */
  /**
   * The phone's current wall-clock time for the top-left HUD slot, e.g.
   * "09:41" — 24-hour, zero-padded, no seconds. Formatted manually rather
   * than via toLocaleTimeString, whose Intl options are ignored by Hermes
   * (it returns a full "hh:mm:ss AM/PM" string regardless).
   */
  private buildClock(): string {
    const now = new Date()
    const hh = String(now.getHours()).padStart(2, "0")
    const mm = String(now.getMinutes()).padStart(2, "0")
    return `${hh}:${mm}`
  }


  private buildTripStats(): string | null {
    const me = this.coords ? {lat: this.coords.lat, lng: this.coords.lng} : null
    const distM =
      this.trip.maneuver?.distanceToDestinationMeters ?? remainingRouteMeters(me, this.trip.routePoints) ?? undefined
    if (distM == null || distM < 0) return null
    // Top stats slot: total remaining distance + ETA, e.g. "863 m  11 min"
    // (matches the HUD mockup). distM also feeds the ETA fallback when the SDK
    // hasn't sent a remaining-time value.
    const etaS = this.trip.maneuver?.timeToDestinationSeconds ?? distM / this.FALLBACK_WALKING_M_PER_S
    const dist = formatDistance(distM, this.unitSystem)
    return etaS >= 0 ? `${dist}  ${formatDuration(etaS)}` : dist
  }

  /**
   * Render and push the 100×100 NORTH-UP minimap (north fixed at top; the
   * map never rotates to follow heading — only the position arrow rotates
   * to show facing direction). Drawn alongside the text HUD (non-overlapping
   * regions of the main view). De-duped on the encoded PNG so we don't
   * re-send identical frames while idle.
   */
  // OSM-roads minimap: street network around the user's live position, with the
  // active route drawn on top. Roads are cached and only re-fetched from Overpass
  // when the user moves past a threshold (PoC: fetch-on-move, ~1s lag accepted).
  private readonly OSM_MINIMAP_SIZE = 100 // matches the top-right container
  // Geographic radius shown in the minimap. CALIBRATED to the pixel size so the
  // map scale (meters-per-pixel) stays constant — that's what keeps traveled
  // distance reading correctly. The renderer fits 2×radius into the pixel size:
  //   pxPerMeter = SIZE / (2 × RADIUS) = 100 / 266 ≈ 0.376 px/m
  // If you change SIZE, scale RADIUS proportionally or the map zooms and the
  // traveled distance looks wrong.
  private readonly OSM_MINIMAP_RADIUS_M = 133
  // Large map shown on swipe-up. Capped at 200px: a single G2 image container
  // maxes out ~200px wide before it needs (unimplemented) quad-mode tiling.
  // Large map render dimensions (swipe-up view): 288×140.
  private readonly OSM_LARGE_MAP_W = 288
  private readonly OSM_LARGE_MAP_H = 140
  private readonly OSM_REFETCH_THRESHOLD_M = 120
  // Walking speed for the ETA fallback when the SDK hasn't sent a remaining-time
  // value yet. Mirrors the WebView running drawer's FALLBACK_WALKING_M_PER_S.
  private readonly FALLBACK_WALKING_M_PER_S = 1.4

  // Minimum gap between minimap renders/pushes. Roughly the glasses' usable
  // display-update rate; faster than this just burns CPU + BLE for frames the
  // user can't perceive.
  private readonly MINIMAP_MIN_INTERVAL_MS = 300

  private refreshMinimap(): void {
    if (!this.capabilities.hasDisplay || !this.capabilities.canPosition) return
    if (this.largeMapShown) return // large map owns the screen; don't overdraw
    if (!this.showMinimap) return
    if (!this.trip.running || !this.coords) return

    // Leading-edge throttle: if we rendered recently, don't render now — instead
    // schedule ONE trailing render for when the window elapses, so the final
    // position after a burst of rapid GPS fixes still reaches the glasses. (A
    // trailing render already pending is left as-is; it re-reads the latest
    // coords/heading when it fires.)
    // A watchdog-forced refresh must render+push synchronously here and now —
    // it must NOT go down the throttle's trailing-timer path. That path defers
    // the render to a setTimeout that fires AFTER the watchdog's `finally` has
    // already reset forceMinimapPush=false, so the deferred render gets dedup'd
    // and the bitmap never reaches the glasses (the "since last push" counter
    // then climbs forever). Skipping the throttle keeps the force flag live
    // through the actual push below. The watchdog only fires after ≥2s idle, so
    // there's no real throttle to honor anyway.
    const now = Date.now()
    const sinceLast = now - this.lastMinimapAt
    if (!this.forceMinimapPush && sinceLast < this.MINIMAP_MIN_INTERVAL_MS) {
      if (this.minimapTrailingTimer == null) {
        this.minimapTrailingTimer = setTimeout(() => {
          this.minimapTrailingTimer = null
          this.refreshMinimap()
        }, this.MINIMAP_MIN_INTERVAL_MS - sinceLast)
      }
      return
    }
    this.lastMinimapAt = now

    const me: LatLng = {lat: this.coords.lat, lng: this.coords.lng}

    // Re-fetch roads if we have none yet, or the user has wandered far from the
    // cached center. Fetch is async + best-effort; we render with whatever roads
    // we currently have (possibly empty on the very first tick).
    const movedFar = !this.osmRoadsCenter || haversineMeters(me, this.osmRoadsCenter) > this.OSM_REFETCH_THRESHOLD_M
    if (movedFar && !this.osmFetchInFlight) {
      this.osmFetchInFlight = true
      const fetchCenter = me
      fetchOsmRoads(fetchCenter, this.OSM_MINIMAP_RADIUS_M * 2)
        .then((roads) => {
          this.osmRoadsCache = roads
          this.osmRoadsCenter = fetchCenter
          console.log(
            `[OSM-MINIMAP] fetched ${roads.length} roads around ${fetchCenter.lat.toFixed(5)},${fetchCenter.lng.toFixed(5)}`,
          )
          this.refreshMinimap() // redraw now that roads are in
        })
        .catch((err) => console.log("[OSM-MINIMAP] fetch failed:", err))
        .finally(() => {
          this.osmFetchInFlight = false
        })
    }

    // "You" arrow heading: the TRUE direction of travel from the user's own
    // movement vector (anchor→current, recomputed every ≥3 m of travel) — no
    // longer assuming the arrow points along the route. Fall back to the route's
    // forward bearing, then the compass, only until we've moved enough to
    // measure a real heading.
    const routeBearing = nextSegmentBearing(me, this.trip.routePoints)
    const markerHeading = this.moveBearingDeg ?? routeBearing ?? this.heading
    // Only draw the route AHEAD of the user: trim the part already walked so
    // the line behind the position marker disappears as they progress.
    const remainingRoute = remainingRoutePoints(me, this.trip.routePoints)
    // Destination = the last point of the FULL route (the route's end), drawn
    // as a small circle so the user can see where they're headed.
    const fullRoute = this.trip.routePoints
    const destination = fullRoute && fullRoute.length > 0 ? fullRoute[fullRoute.length - 1] : null
    // NORTH-UP: the minimap is kept fixed with north at the top — it does NOT
    // rotate to follow heading. Only the position marker rotates to show which
    // way the user is facing (marker.headingDeg). `rotationDeg: 0` locks the
    // map orientation north-up regardless of travel direction.
    const png = renderOsmLineMap(this.osmRoadsCache ?? [], {
      center: me,
      width: this.OSM_MINIMAP_SIZE,
      height: this.OSM_MINIMAP_SIZE,
      viewRadiusMeters: this.OSM_MINIMAP_RADIUS_M,
      lineWidthPx: 2,
      route: remainingRoute,
      destination,
      rotationDeg: 0,
      marker: markerHeading != null ? {at: me, headingDeg: markerHeading} : null,
    })
    // Live trip stats in the bottom-left: distance remaining + ETA, both of which
    // decrement as we approach the destination. Pushed BEFORE the minimap
    // dedup-return below so a heading/position-only tick (where the map bitmap is
    // unchanged) still refreshes the numbers — that's what makes it "stream".
    // Positioned text uses its own G2 container, so it doesn't fight the bitmaps.
    // Falls back to perpendicular route distance when the SDK hasn't populated
    // distanceToDestinationMeters yet. Deduped on content.
    const distM =
      this.trip.maneuver?.distanceToDestinationMeters ?? remainingRouteMeters(me, this.trip.routePoints) ?? undefined
    // ETA: prefer the SDK's mode-aware remaining time; fall back to a
    // walking-speed estimate from the distance so the time still shows when the
    // SDK value isn't in yet.
    const etaS =
      this.trip.maneuver?.timeToDestinationSeconds ??
      (distM != null ? distM / this.FALLBACK_WALKING_M_PER_S : undefined)
    console.log(`[TRIP-STATS] distM=${distM} etaS=${etaS} (will push: ${distM != null && distM >= 0})`)
    if (distM != null && distM >= 0) {
      const distStr = formatDistance(distM, this.unitSystem)
      // U+2299 ⊙ — confirmed to render in the G2 font (the color clock emoji
      // don't). Used as the "time" marker next to the ETA.
      const etaStr = etaS != null && etaS >= 0 ? `⊙ ${formatDuration(etaS)}` : null
      // Distance and time side by side, e.g. "354 m · ⊙ 5 min".
      const stats = etaStr ? `${distStr} · ${etaStr}` : distStr
      // Re-push when the content changes OR every ~3s even if unchanged. The G2
      // EvenHub page is frequently torn down/rebuilt ("Glasses shutdown our
      // EvenHub page"), which can swallow a one-time send — so a change-only
      // dedup leaves the stats container blank until the value next changes
      // (which, while stationary, can be a long time). Periodic re-push recovers.
      const now = Date.now()
      const changed = stats !== this.lastTripStats
      const stale = now - this.lastTripStatsAt > 3000
      if (changed || stale) {
        this.lastTripStats = stats
        this.lastTripStatsAt = now
        // Bottom-left trip stats disabled — no longer pushed to the glasses.
        // this.display.showTripStats(stats)
      }
    }

    // Normally we dedup on the rendered bytes — but a watchdog-forced refresh
    // (no live updates for a while) must re-push even when the map is unchanged,
    // to recover from a torn-down G2 page that may have dropped the last send.
    if (!png || (png === this.lastMinimapPng && !this.forceMinimapPush)) {
      console.log(`[MINIMAP] skip push (png ${png ? "unchanged" : "null"}, force=${this.forceMinimapPush})`)
      return
    }
    this.lastMinimapPng = png
    this.lastMinimapPushAt = Date.now()
    console.log(`[MINIMAP] push bitmap (${png.length} b64 chars, force=${this.forceMinimapPush})`)
    this.display.showBitmap(png)
  }

  /**
   * Watchdog tick: if no minimap has been pushed within MINIMAP_WATCHDOG_IDLE_MS
   * while a trip is running (and the large map isn't owning the screen), force a
   * fresh re-render so the glasses keep getting an updated bitmap even when the
   * live GPS/update stream has gone quiet. Idempotent + cheap when updates are
   * flowing (the idle check short-circuits).
   */
  private minimapWatchdogTick(): void {
    if (this.largeMapShown || !this.showMinimap) {
      console.log(`[MINIMAP-WATCHDOG] tick skipped (largeMap=${this.largeMapShown} showMinimap=${this.showMinimap})`)
      return
    }
    if (!this.trip.running || !this.coords) {
      console.log(`[MINIMAP-WATCHDOG] tick skipped (running=${this.trip.running} coords=${!!this.coords})`)
      return
    }
    const idle = Date.now() - this.lastMinimapPushAt
    console.log(`[MINIMAP-WATCHDOG] tick: ${idle}ms since last push (threshold ${this.MINIMAP_WATCHDOG_IDLE_MS}ms)`)
    if (idle < this.MINIMAP_WATCHDOG_IDLE_MS) return
    console.log(`[MINIMAP-WATCHDOG] no push for ${idle}ms — forcing refresh`)
    this.forceMinimapPush = true
    try {
      this.refreshMinimap()
    } finally {
      this.forceMinimapPush = false
    }
  }

  /** Start the recurring minimap watchdog (no-op if already running). */
  private startMinimapWatchdog(): void {
    if (!this.capabilities.hasDisplay || !this.capabilities.canPosition) return
    if (this.minimapWatchdogTimer != null) return
    console.log(
      `[MINIMAP-WATCHDOG] started (every ${this.MINIMAP_WATCHDOG_INTERVAL_MS}ms, idle threshold ${this.MINIMAP_WATCHDOG_IDLE_MS}ms)`,
    )
    this.minimapWatchdogTimer = setInterval(() => this.minimapWatchdogTick(), this.MINIMAP_WATCHDOG_INTERVAL_MS)
  }

  /** Stop the minimap watchdog (no-op if not running). */
  private stopMinimapWatchdog(): void {
    if (this.minimapWatchdogTimer == null) return
    clearInterval(this.minimapWatchdogTimer)
    this.minimapWatchdogTimer = null
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
    // Two states now: 0 = on route (< ADVISORY_M), 1 = OFF route (≥ ADVISORY_M).
    // The "Go back in X m" advisory shows for ANY distance ≥ ADVISORY_M and the
    // X GROWS the further the user strays — it persists past the old TRIGGER_M
    // band until either Mapbox reroutes (status → "rerouting", which takes over
    // the HUD) or the user returns to within ADVISORY_M (back to the original
    // instruction). TRIGGER_M is kept only for the diagnostic log threshold.
    // Use separate enter/exit thresholds so ordinary GPS jitter near 20m
    // cannot flip the HUD between its message and turn-by-turn topologies on
    // every fix. Each topology change is structural on G2 and requires a page
    // rebuild, so threshold chatter presents as a whole-display refresh.
    const bucket = classifyOffRouteAdvisory(dist, this.offRouteAdvisory) ? 1 : 0
    // Keep the advisory distance live so the glasses "Go back in X m" line
    // tracks the user every fix — growing as they move away, shrinking as they
    // return. Null when on route.
    const prevDistance = this.offRouteAdvisoryDistanceM
    this.offRouteAdvisoryDistanceM = bucket === 1 ? dist : null
    if (
      bucket === this.lastOffRouteBucket &&
      bucket === 1 &&
      prevDistance != null &&
      Math.round(prevDistance) !== Math.round(dist)
    ) {
      // Same state, distance label changed — refresh so the "Go back in X m"
      // number follows the user. Coalescing in refreshHUD swallows identical
      // frames so this is cheap.
      this.refreshHUD()
    }
    if (bucket === this.lastOffRouteBucket) return
    this.lastOffRouteBucket = bucket
    // Advisory is active whenever we're off route. refreshHUD() shows the
    // "Go back in X m" frame (glasses only) and the off-route toast on the phone
    // while we wait for either a return-to-path or Mapbox's reroute.
    this.offRouteAdvisory = bucket === 1
    if (bucket === 0) {
      // Returned within the route — back to the original maneuver text.
      const msg = `back on route (${dist.toFixed(1)}m) — restoring directions`
      console.log(`[NavOffRoute] ${msg}`)
      this.appendLog(`[NavOffRoute] ${msg}`)
      this.refreshHUD()
    } else {
      // Off route. Mapbox owns the actual reroute (native); this is just the
      // advisory HUD. It persists + the distance grows until reroute or return.
      const msg = `> ${OFF_ROUTE_ADVISORY_M}m off route (${dist.toFixed(1)}m) — go back / awaiting native reroute`
      console.log(`[NavOffRoute] ${msg}`)
      this.appendLog(`[NavOffRoute] ${msg}`)
      this.refreshHUD()
    }
  }

  // NOTE: the former `triggerAutoRebuild()` (JS-side off-route → re-fire
  // nav:start) was removed in the Mapbox migration. The host Mapbox
  // Navigation SDK owns off-route detection + rerouting natively and pushes
  // the rerouted route through `onRoute`, with the `rerouting` status
  // arriving via the native update stream. A JS-side rebuild would double
  // the reroute and fight the native engine. The off-route distance check
  // above is now log + advisory-HUD only. `cancelPendingRebuild()` and the
  // rebuild-state fields are retained as harmless no-ops (the timer is
  // never armed now) to avoid churn across the many lifecycle call sites.

  // ── Early arrival ────────────────────────────────────────────────────

  // The Nav SDK fires `arrived` based on its own threshold (straight-line to
  // the destination pin). We fire earlier on either of two signals:
  //
  //   1. ALONG-ROUTE: the user has walked nearly the whole route polyline (the
  //      grey trail reached the pin) — ≤ ARRIVAL_REMAINING_M of route left.
  //
  //   2. NEAR THE PIN: the straight-line distance to the destination pin is
  //      small AND we are near the end of the route. This catches the common
  //      case where the pin is a building entrance set BACK from the walkable
  //      path: the user is right beside the destination (perpendicular to it)
  //      with only a few meters of straight-line distance, but the route
  //      polyline still continues, so the along-route check alone would not
  //      fire. The "near the route end" gate is what keeps a route that merely
  //      passes close to the pin mid-trip (e.g. loops back to the real
  //      entrance) from arriving early.
  //
  // Mirrors the SDK arrived handler's state mutation so downstream consumers
  // (HUD, UI) see the same shape regardless of which trigger fired. Captures
  // the side (left/right) of the pin relative to the final route segment
  // *before* clearing routePoints so the HUD can render "on your left|right".
  private maybeFireEarlyArrival(): void {
    // ≤ this much route polyline remaining → arrived (trail reached the pin).
    const ARRIVAL_REMAINING_M = 7
    // Straight-line distance to the pin that counts as "we're there".
    const ARRIVAL_NEAR_PIN_M = 15
    // Only consider the near-pin trigger once we're this close to the route's
    // end, so a mid-trip pass beside the destination can't false-arrive.
    const ARRIVAL_NEAR_END_M = 40
    if (!this.coords) return
    if (this.trip.status === "arrived" || !this.trip.running) return
    const route = this.trip.routePoints
    const me = {lat: this.coords.lat, lng: this.coords.lng}
    const remaining = remainingRouteMeters(me, route)
    if (remaining == null) return

    const dest = this.trip.activeDestination
    const straightLineToPin = dest ? haversineMeters(me, dest) : null

    const alongRouteArrived = remaining <= ARRIVAL_REMAINING_M
    const nearPinArrived =
      straightLineToPin != null && straightLineToPin <= ARRIVAL_NEAR_PIN_M && remaining <= ARRIVAL_NEAR_END_M
    if (!alongRouteArrived && !nearPinArrived) return

    const side = sideOfFinalSegment(route, this.trip.activeDestination)
    const why = alongRouteArrived
      ? `${remaining.toFixed(1)}m of route remaining`
      : `${straightLineToPin?.toFixed(1)}m from pin, ${remaining.toFixed(1)}m route left`
    this.appendLog(`ARRIVED (early, ${why})`)
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
    try {
      this.navigation.stop()
    } catch {
      /* ignore */
    }
    // If the large map is up at arrival, drop out of it so the "You have
    // arrived" HUD can actually paint — refreshHUD() early-returns while
    // largeMapShown, and the caller refreshes the HUD right after this returns.
    // Mirrors the SDK arrived handler, which also exits the large map here.
    this.exitLargeMap()
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
      // Strip the trailing "Destination will be on the left/right" hint,
      // same as the onRoute cache path — this refetch path was leaking
      // it straight into the HUD instructions.
      this.cachedInstructions = steps.map((s) => cleanInstruction(s.instruction))
      // Re-zip into the current live routeSteps so the UI updates.
      const live = this.trip.routeSteps
      if (live && live.length > 0) {
        const merged = live.map((s, i) => ({
          ...s,
          instruction:
            this.cachedInstructions && i < this.cachedInstructions.length ? this.cachedInstructions[i] || null : null,
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
      voiceGuidanceMode: this.voiceGuidanceMode,
      capabilities: this.capabilities,
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
    this.audioGuidance.dispose()
    this.cancelPendingRebuild()
    this.stopMinimapWatchdog()
    if (this.minimapTrailingTimer != null) {
      clearTimeout(this.minimapTrailingTimer)
      this.minimapTrailingTimer = null
    }
    try {
      this.navigation.stop()
    } catch {
      /* ignore */
    }
    if (this.capabilities.hasDisplay) {
      try {
        this.display.clear()
      } catch {
        /* ignore */
      }
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
/** Valid travel modes for the start_navigation action (mirrors TravelMode). */
const MODES = new Set<TravelMode>(["walking", "driving", "cycling", "two_wheeler"])

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

// Off-route advisory thresholds (meters): how far off the route polyline the
// user must be before the glasses show "Go back in X m". Enter at 20m so
// opposite-sidewalk crossings at typical urban 4-way intersections don't read
// as deviations — walking the far curb across a 4-lane road (~15m wide incl.
// parking) lands ~12-18m from the route polyline, just under this band. Once
// active, require a fix below 15m before clearing it. This hysteresis prevents
// GPS noise around 20m from repeatedly changing the G2 page structure.
const OFF_ROUTE_ADVISORY_M = 20
const OFF_ROUTE_RECOVERY_M = 15

export function classifyOffRouteAdvisory(distanceMeters: number, advisoryActive: boolean): boolean {
  return advisoryActive ? distanceMeters >= OFF_ROUTE_RECOVERY_M : distanceMeters >= OFF_ROUTE_ADVISORY_M
}

// How long the HUD may sit on "Starting…" (running, no maneuver event yet)
// before the watchdog derives the first instruction from the route's steps.
// Long enough that a normal start (maneuver event lands within a second or two)
// never trips it; short enough that a genuinely stuck start recovers quickly.
const STARTING_WATCHDOG_MS = 6000

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
  return raw.replace(/\s*[|.]?\s*(?:your\s+)?destination will be on the (left|right)\s*\.?\s*$/i, "").trim()
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
