package com.mentra.crust.navigation

import android.app.Activity
import android.content.Context
import android.util.Log
import com.mapbox.api.directions.v5.DirectionsCriteria
import com.mapbox.api.directions.v5.models.DirectionsRoute
import com.mapbox.api.directions.v5.models.ManeuverModifier
import com.mapbox.api.directions.v5.models.RouteOptions
import com.mapbox.api.directions.v5.models.StepManeuver
import com.mapbox.common.MapboxOptions
import com.mapbox.common.location.Location
import com.mapbox.geojson.Point
import com.mapbox.navigation.base.ExperimentalPreviewMapboxNavigationAPI
import com.mapbox.navigation.base.extensions.applyDefaultNavigationOptions
import com.mapbox.navigation.base.extensions.applyLanguageAndVoiceUnitOptions
import com.mapbox.navigation.base.options.NavigationOptions
import com.mapbox.navigation.base.route.NavigationRoute
import com.mapbox.navigation.base.route.NavigationRouterCallback
import com.mapbox.navigation.base.route.RouterFailure
import com.mapbox.navigation.base.trip.model.RouteProgress
import com.mapbox.navigation.base.trip.model.RouteProgressState
import com.mapbox.navigation.core.MapboxNavigation
import com.mapbox.navigation.core.MapboxNavigationProvider
import com.mapbox.navigation.core.directions.session.RoutesExtra
import com.mapbox.navigation.core.directions.session.RoutesObserver
import com.mapbox.navigation.core.directions.session.RoutesUpdatedResult
import com.mapbox.navigation.core.reroute.RerouteController
import com.mapbox.navigation.core.reroute.RerouteState
import com.mapbox.navigation.core.replay.MapboxReplayer
import com.mapbox.navigation.core.replay.history.ReplayEventBase
import com.mapbox.navigation.core.replay.history.ReplayEventLocation
import com.mapbox.navigation.core.replay.history.ReplayEventUpdateLocation
import com.mapbox.navigation.core.replay.route.ReplayRouteMapper
import com.mapbox.navigation.core.replay.route.ReplayRouteOptions
import com.mapbox.navigation.core.replay.route.ReplayRouteSession
import com.mapbox.navigation.core.replay.route.ReplayRouteSessionOptions
import com.mapbox.navigation.core.trip.session.LocationMatcherResult
import com.mapbox.navigation.core.trip.session.LocationObserver
import com.mapbox.navigation.core.trip.session.OffRouteObserver
import com.mapbox.navigation.core.trip.session.RouteProgressObserver

/**
 * NavigationManager
 *
 * Singleton wrapper around the **Mapbox Navigation SDK v3** for Android
 * (migrated from the Google Navigation SDK). Owns the MapboxNavigation
 * lifecycle, attaches observers, and exposes coarse callbacks consumed by
 * CrustModule (which forwards them as events to JS).
 *
 * Headless: never mounts a MapView. The mobile app does not render a
 * map natively (the miniapp WebView owns the visible map).
 *
 * ## Contract (UNCHANGED from the Google implementation)
 *
 * The public surface — `start` / `stop` / `ensureTermsAccepted` /
 * `resetTermsAccepted` / `simulateDeviation` / `setWrongSidewalkOffset` /
 * `setSkipCrossings`, plus the `StartOptions` / `Callbacks` /
 * `ManeuverPayload` / `LocationPayload` / `RoutePoint` / `RouteStep` types —
 * is byte-identical to the Google version. CrustModule and everything above
 * the bridge (the `@mentra/miniapp` SDK, the PivotEngine) are unaffected by
 * this migration. See issues/mapbox-navigation-migration.md.
 *
 * ## How Mapbox differs from Google (mapped onto the same contract)
 *
 * - **Off-route + reroute is automatic.** Mapbox detects off-route and
 *   re-requests a route by default. We surface `OffRouteObserver` →
 *   `onOffRoute`, `RerouteState` transitions → `onRerouting`, and
 *   `RoutesObserver` (new route) → `onRoute`. No hand-rolled 30m
 *   perpendicular detector for the live trip.
 * - **Steps arrive inline** on each `RouteProgress` / off the
 *   `NavigationRoute` directlegs — no Messenger-IPC NavInfo service
 *   (NavInfoReceiverService is deleted). Road names + maneuver come from
 *   the Directions `LegStep` / `BannerInstructions`.
 * - **No T&C dialog.** Mapbox has no runtime terms screen, so
 *   `ensureTermsAccepted` resolves immediately `true` and
 *   `resetTermsAccepted` is a no-op — keeping the callback shape the
 *   miniapp's `requestPermission()` expects.
 * - **Enhanced (map-matched) location** replaces RoadSnappedLocationProvider
 *   via `LocationObserver.onNewLocationMatcherResult`.
 * - **Simulation** uses `MapboxReplayer` + `ReplayRouteMapper`; the three
 *   dev walkers (deviate / wrong-sidewalk / skip-crossings) are
 *   re-implemented by pushing synthetic `ReplayEventUpdateLocation`s.
 */
@OptIn(ExperimentalPreviewMapboxNavigationAPI::class)
object NavigationManager {
  private const val TAG = "NavigationManager"

  private var mapboxNavigation: MapboxNavigation? = null
  private var appContext: Context? = null

  private var activeCallbacks: Callbacks? = null
  private var lastEmittedKey: String? = null

  /** True iff the active trip is using simulated locations. Drives reroute-restart logic. */
  private var simulating: Boolean = false
  /** Saved speed multiplier so deviation/reroute can resume at the same pace. */
  private var simulationSpeed: Float = 1f
  /**
   * Set once when an arrival is handled so the repeated COMPLETE
   * RouteProgress ticks the SDK keeps emitting after arrival don't
   * re-trigger the sim→real-GPS handoff. Cleared on start()/stop().
   */
  private var arrivedHandled: Boolean = false

  /** Most recent (map-matched) fix. Used to compute distance-to-maneuver and dev walkers. */
  private var lastFixLat: Double = Double.NaN
  private var lastFixLng: Double = Double.NaN
  /**
   * The sample BEFORE lastFix. Used by the Deviate dev button to derive
   * the user's actual direction of travel (prev → last) so the
   * straight-walk uses *their* bearing, not the route's local bearing.
   */
  private var prevFixLat: Double = Double.NaN
  private var prevFixLng: Double = Double.NaN
  /** Most recent speed in m/s, off the enhanced location. Null until first sample. */
  private var lastSpeedMps: Float? = null

  /** Edge-debounce for Mapbox's OffRouteObserver: true between an off-route
   *  signal and the next fresh route, so we emit onOffRoute once per
   *  divergence. Cleared when a (rerouted) route lands. */
  private var offRouteFired: Boolean = false

  /** Latest flattened active-route polyline + step list (for dev walkers + maneuver math). */
  private var activePolyline: List<Pair<Double, Double>>? = null
  private var activeSteps: List<RouteStep>? = null
  /** Trip totals freshened on every RouteProgress tick. -1 = unknown. */
  private var distanceToDestinationMeters: Int = -1
  private var timeToDestinationSeconds: Int = -1
  /** Current step maneuver + distance-to-next-maneuver from RouteProgress. Null until first tick. */
  private var currentManeuverType: String? = null
  private var distanceToManeuverMeters: Int? = null
  private var currentRoad: String? = null
  private var nextStepRoad: String? = null

  // ---- Dev toggles (parity with the Google implementation) ----

  /**
   * Dev toggle: when true, every emitted location is shifted ~8m to the
   * right of the local route bearing before being reported. Simulates a
   * pedestrian walking on the wrong sidewalk so we can verify the
   * along-path pivot trigger fires even when they're never within the
   * 7m point radius of a pivot. Only meaningful in simulate mode.
   */
  private var wrongSidewalkOffsetEnabled: Boolean = false
  private val WRONG_SIDEWALK_OFFSET_M = 8.0

  /**
   * Dev toggle: when true, takes over from the Mapbox replayer and walks
   * the user along a *modified* polyline that omits crossing micro-steps,
   * reproducing the wrong-sidewalk-then-missed-the-turn scenario. Only
   * takes effect with simulate=true.
   */
  private var skipCrossingsEnabled: Boolean = false
  private var skipCrossingsTimer: java.util.Timer? = null
  private val SKIP_CROSSINGS_BASE_M_PER_TICK = 0.56
  private val SKIP_CROSSINGS_TICK_MS = 400L
  private val CROSSING_MAX_LEG_METERS = 25.0
  private val CROSSING_MIN_BEND_DEG = 60.0

  /**
   * Baseline walking speed (m/s) stamped onto synthetic replay locations
   * pushed by the dev helpers (deviate jump, skip-crossings walker).
   */
  private val DEVIATE_BASE_MPS = 1.4
  /**
   * How far (meters) the Deviate dev button jumps the simulated puck off
   * the active route. Far enough that Mapbox's off-route detector fires
   * reliably and triggers an automatic reroute.
   */
  private val DEVIATE_OFFSET_M = 60.0
  /** Cached options so a re-request to the same final stop is possible. */
  private var activeOptions: StartOptions? = null

  /**
   * One-shot gate set in `start()` and fired by `handleLocation` on the
   * FIRST location fix after the trip session starts. Carries (originLat,
   * originLng) — the real device position — into the deferred route
   * request. Cleared after firing (and on stop()) so it runs exactly once
   * per trip. This is how we get a valid origin without a synchronous
   * Mapbox location getter (there is none).
   */
  private var pendingRouteRequest: ((originLat: Double, originLng: Double) -> Unit)? = null

  // ---- Mapbox replay/sim plumbing ----
  // ReplayRouteSession is Mapbox's purpose-built, all-in-one simulation
  // driver (a MapboxNavigationObserver). It internally observes routes +
  // route progress, pushes the real first device location, generates replay
  // events from the active route, and resets on reroute — the entire sim
  // lifecycle, in the correct order. We attach/detach it instead of hand-
  // rolling MapboxReplayer + ReplayProgressObserver + manual pushEvents
  // (which fought each other and left the puck frozen).
  private var replaySession: ReplayRouteSession? = null
  // The built-in MapboxReplayer is still used by the dev walkers
  // (deviate / skip-crossings), which push synthetic locations directly.
  private var replayer: MapboxReplayer? = null
  private val replayRouteMapper = ReplayRouteMapper()

  // ---- Mapbox observers (held so we can detach on stop) ----
  private var routesObserver: RoutesObserver? = null
  private var routeProgressObserver: RouteProgressObserver? = null
  private var locationObserver: LocationObserver? = null
  private var offRouteObserver: OffRouteObserver? = null
  private var rerouteStateObserver: RerouteController.RerouteStateObserver? = null

  // =====================================================================
  // Wire payloads — IDENTICAL to the Google implementation. Do not change
  // field names/types: CrustModule + the bridge depend on this shape.
  // =====================================================================

  data class ManeuverPayload(
    /**
     * Categorical type of the upcoming maneuver. One of: STRAIGHT,
     * CONTINUE, SLIGHT_LEFT, SLIGHT_RIGHT, TURN_LEFT, TURN_RIGHT,
     * SHARP_LEFT, SHARP_RIGHT, U_TURN, NAME_CHANGE, DEPART, ARRIVE.
     */
    val maneuverType: String,
    /** Meters from the user's current position to that maneuver. -1 if unknown. */
    val distanceMeters: Int,
    /** Road the user is currently on. Null if unavailable. */
    val fromRoad: String?,
    /** Legacy "next road" field (== fromRoad historically). Kept for back-compat. */
    val toRoad: String?,
    /** Road the user will be on AFTER the upcoming maneuver. Null until known. */
    val nextStepRoad: String?,
    /** Total remaining distance to final destination, meters. -1 if unknown. */
    val distanceToDestinationMeters: Int = -1,
    /** Total remaining travel time, seconds. -1 if unknown. */
    val timeToDestinationSeconds: Int = -1,
    /** Current speed in m/s. Null if unavailable. */
    val currentSpeedMps: Float? = null,
    /** Speed limit on the current road segment in m/s. Null if unknown. */
    val speedLimitMps: Float? = null,
    /** Bearing along the route at the user's current position, 0–360. Null if unknown. */
    val routeHeadingDeg: Float? = null,
    /**
     * Mapbox's verbatim turn-by-turn instruction for the step the user is
     * approaching (e.g. "Keep right at the fork.", "Turn left onto Waller
     * Street.", "Your destination is on the right."). Taken from the
     * upcoming step's StepManeuver.instruction(); the maneuver card shows
     * it as-is rather than reconstructing "Turn left onto X". Null when the
     * SDK hasn't supplied one yet.
     */
    val instruction: String? = null,
  )

  data class LocationPayload(
    val lat: Double,
    val lng: Double,
    val accuracy: Float?,
    val timestamp: Long,
  )

  data class RoutePoint(val lat: Double, val lng: Double)

  /**
   * One step along the active route — used by the SDK's pivot module to
   * enrich pivots with `fromRoad` / `toRoad` metadata. Lat/lng is the
   * step's START coordinate.
   */
  data class RouteStep(
    val lat: Double,
    val lng: Double,
    val routeIndex: Int,
    val road: String?,
    val maneuver: String,
    val distanceMeters: Int,
  )

  interface Callbacks {
    fun onManeuver(payload: ManeuverPayload)
    fun onRerouting()
    fun onArrived()
    fun onError(message: String)
    fun onLocation(payload: LocationPayload)
    fun onRoute(points: List<RoutePoint>, steps: List<RouteStep>?)
    /**
     * Fires once when the user crosses the off-route threshold. Always
     * arrives before `onRerouting` for the same deviation.
     */
    fun onOffRoute(perpendicularDistanceMeters: Double)
  }

  /** Trip configuration. `stops` is the canonical destination list (last is final). */
  data class StartOptions(
    val stops: List<Pair<Double, Double>>,
    val mode: String = "driving",
    val avoidHighways: Boolean = false,
    val avoidTolls: Boolean = false,
    val avoidFerries: Boolean = false,
    val simulate: Boolean = false,
    // Real-time (1×) by default. Mapbox's ReplayRouteMapper already bakes
    // realistic per-segment speeds into the replay events; `playbackSpeed`
    // is a raw time-scale ON TOP of that, so the old 5× default ran a
    // walking sim at ~7 m/s (a sprint). 1× walks/drives the route at true
    // speed; callers can still pass a higher multiplier to fast-forward.
    val speedMultiplier: Float = 1f,
  )

  // =====================================================================
  // T&C — Mapbox has no runtime terms dialog. Preserve the callback shape
  // so the miniapp's requestPermission() keeps resolving {accepted:true}.
  // =====================================================================

  /**
   * Mapbox has no Terms & Conditions dialog (acceptance is by
   * account/usage, not a runtime screen). Resolves immediately `true`.
   * Kept so callers that pre-trigger T&C don't break.
   */
  fun ensureTermsAccepted(activity: Activity, onResult: (accepted: Boolean) -> Unit) {
    onResult(true)
  }

  /** No-op under Mapbox — there is no terms cache to clear. */
  fun resetTermsAccepted(activity: Activity) {
    Log.d(TAG, "resetTermsAccepted — no-op (Mapbox has no T&C dialog)")
  }

  // =====================================================================
  // Lifecycle
  // =====================================================================

  /**
   * Lazily create (or reuse) the process-wide MapboxNavigation. The token
   * is read from the AndroidManifest meta-data `com.mapbox.token` (injected
   * by mobile/plugins/android.ts), mirroring how the Google geo key was
   * provisioned. MapboxNavigationProvider keeps a singleton; we attach our
   * own observers per trip and detach in stop().
   */
  private fun ensureNavigation(activity: Activity): MapboxNavigation {
    appContext = activity.applicationContext
    val existing = if (MapboxNavigationProvider.isCreated()) MapboxNavigationProvider.retrieve() else null
    if (existing != null) {
      mapboxNavigation = existing
      return existing
    }
    // v3 sets the token globally via MapboxOptions, not on NavigationOptions.
    val token = readMapboxToken(activity)
    if (token.isNotBlank()) {
      MapboxOptions.accessToken = token
    } else {
      Log.e(TAG, "com.mapbox.token meta-data is empty — navigation will fail to authenticate")
    }
    val nav = MapboxNavigationProvider.create(
      NavigationOptions.Builder(activity.applicationContext).build(),
    )
    mapboxNavigation = nav
    return nav
  }

  /** Read the Mapbox runtime token from AndroidManifest meta-data com.mapbox.token. */
  private fun readMapboxToken(activity: Activity): String {
    return try {
      val ai = activity.packageManager.getApplicationInfo(
        activity.packageName,
        android.content.pm.PackageManager.GET_META_DATA,
      )
      ai.metaData?.getString("com.mapbox.token") ?: ""
    } catch (e: Throwable) {
      Log.e(TAG, "failed to read com.mapbox.token meta-data", e)
      ""
    }
  }

  /**
   * Start a navigation session. Initializes MapboxNavigation on first
   * call. Because Mapbox has no T&C gate, this goes straight into route
   * request + trip start (the `ensureTermsAccepted` wrapper resolves
   * immediately for callers that still invoke it up front).
   */
  fun start(activity: Activity, options: StartOptions, callbacks: Callbacks) {
    Log.d(TAG, "start stops=${options.stops.size} mode=${options.mode} simulate=${options.simulate} speed=${options.speedMultiplier}")
    if (options.stops.isEmpty()) {
      callbacks.onError("at least one stop is required")
      return
    }
    val nav = try {
      ensureNavigation(activity)
    } catch (e: Throwable) {
      Log.e(TAG, "MapboxNavigation init failed", e)
      callbacks.onError("navigation init failed: ${e.message}")
      return
    }

    activeCallbacks = callbacks
    activeOptions = options
    simulating = options.simulate
    simulationSpeed = options.speedMultiplier.coerceIn(0.5f, 50f)
    offRouteFired = false
    arrivedHandled = false

    attachObservers(nav, callbacks)

    // Origin handling — the crux of a correct trip start.
    //
    // Mapbox has NO synchronous "current location" getter: the device
    // position is only delivered asynchronously through LocationObserver,
    // and only AFTER the trip session has started. So we cannot build the
    // route's origin up front. Requesting with `stops.first()` as origin
    // would be a bug — for a single-destination trip that first stop IS the
    // destination, producing a degenerate origin==destination route (the
    // exact trap the SDK's navigation.ts documents avoiding).
    //
    // Correct flow: start the trip session FIRST so location starts
    // flowing, capture the first fix via a one-shot gate, then request the
    // route from that real origin. `pendingRouteRequest` holds the trip
    // params until the gate fires; `handleLocation` invokes it on the first
    // location and clears it.
    pendingRouteRequest = { originLat, originLng ->
      requestAndStartRoute(nav, activity, options, originLat, originLng, callbacks)
    }
    startTripSession(nav, options)
  }

  /**
   * Build the RouteOptions from a resolved origin + the trip stops, request
   * the route, set it on the navigator, and emit it. Called once the first
   * location fix has arrived (via `pendingRouteRequest`).
   */
  private fun requestAndStartRoute(
    nav: MapboxNavigation,
    activity: Activity,
    options: StartOptions,
    originLat: Double,
    originLng: Double,
    callbacks: Callbacks,
  ) {
    val coordinates = ArrayList<Point>()
    coordinates.add(Point.fromLngLat(originLng, originLat))
    for ((lat, lng) in options.stops) coordinates.add(Point.fromLngLat(lng, lat))

    val routeOptions = RouteOptions.builder()
      .applyDefaultNavigationOptions(profileFor(options.mode))
      .applyLanguageAndVoiceUnitOptions(activity)
      .coordinatesList(coordinates)
      .alternatives(false)
      .steps(true)
      .bannerInstructions(true)
      // The onboard router rejects voice units when voice instructions are disabled.
      .voiceUnits(null)
      .voiceInstructions(false)
      .exclude(buildExclude(options))
      .build()

    nav.requestRoutes(
      routeOptions,
      object : NavigationRouterCallback {
        override fun onRoutesReady(routes: List<NavigationRoute>, routerOrigin: String) {
          if (routes.isEmpty()) {
            callbacks.onError("no route found")
            return
          }
          nav.setNavigationRoutes(routes)
          // In sim mode the ReplayRouteSession observes setNavigationRoutes
          // and starts driving the puck automatically — no manual replay
          // kick needed here.
          emitRoute(routes.first(), callbacks)
        }

        override fun onFailure(reasons: List<RouterFailure>, routeOptions: RouteOptions) {
          val msg = reasons.firstOrNull()?.message ?: "route request failed"
          Log.e(TAG, "requestRoutes failed: $msg")
          callbacks.onError(msg)
        }

        override fun onCanceled(routeOptions: RouteOptions, routerOrigin: String) {
          Log.w(TAG, "route request canceled")
        }
      },
    )
  }

  /** Comma-joined Directions `exclude` list from the avoid flags. Null when none. */
  private fun buildExclude(options: StartOptions): String? {
    val ex = mutableListOf<String>()
    if (options.avoidTolls) ex.add(DirectionsCriteria.EXCLUDE_TOLL)
    if (options.avoidFerries) ex.add(DirectionsCriteria.EXCLUDE_FERRY)
    if (options.avoidHighways) ex.add(DirectionsCriteria.EXCLUDE_MOTORWAY)
    return if (ex.isEmpty()) null else ex.joinToString(",")
  }

  /**
   * Map the SDK-agnostic mode string to a Mapbox Directions profile.
   * Google's `two_wheeler` has no Mapbox equivalent → driving (see the
   * migration doc's open decision #3).
   */
  private fun profileFor(mode: String): String = when (mode.lowercase()) {
    "walking" -> DirectionsCriteria.PROFILE_WALKING
    "cycling" -> DirectionsCriteria.PROFILE_CYCLING
    "two_wheeler" -> DirectionsCriteria.PROFILE_DRIVING
    "driving" -> DirectionsCriteria.PROFILE_DRIVING_TRAFFIC
    else -> DirectionsCriteria.PROFILE_DRIVING_TRAFFIC
  }

  /** Begin the trip session — either live GPS or the replay session for simulate mode. */
  @OptIn(ExperimentalPreviewMapboxNavigationAPI::class)
  private fun startTripSession(nav: MapboxNavigation, options: StartOptions) {
    if (options.simulate) {
      // Start the replay trip session, then attach Mapbox's ReplayRouteSession
      // which owns the whole sim: it pushes the real first device location
      // (firing LocationObserver → satisfies our first-fix gate so the route
      // can be requested), then once the route lands it auto-generates replay
      // events and drives the puck — and resets cleanly on every reroute. No
      // manual pushRealLocation / pushEvents / restart needed.
      val session = ReplayRouteSession().setOptions(
        ReplayRouteSessionOptions.Builder()
          .replayRouteOptions(replayRouteOptionsFor(options.mode, simulationSpeed))
          // Snap the replay puck to the freshly-set route after a reroute
          // so re-attaching the session (e.g. after the Deviate dev button
          // forces a divergence) resumes cleanly on the NEW route.
          .locationResetEnabled(true)
          .build(),
      )
      replaySession = session
      replayer = nav.mapboxReplayer
      nav.startReplayTripSession()
      session.onAttached(nav)
    } else {
      nav.startTripSession()
    }
  }

  /**
   * After a SIMULATED trip arrives, the replay puck is parked at the sim
   * destination — so the location stream is reporting the fake endpoint,
   * not the device's real position. Hand the location source back to real
   * GPS: detach the replay session (its onDetached pushes the real device
   * location) and switch from the replay trip session to a live one, so
   * `onLocation` resumes emitting the user's actual position and the idle
   * map snaps back to reality.
   *
   * No-op on real (non-sim) trips. Best-effort — failures are logged and
   * leave the trip stopped rather than crashing.
   */
  @OptIn(ExperimentalPreviewMapboxNavigationAPI::class)
  private fun returnToRealLocationAfterSimArrival() {
    val nav = mapboxNavigation ?: return
    try {
      replaySession?.onDetached(nav)
      replaySession = null
      // Drop the finished route and flip the session from replay → live
      // GPS. startTripSession() begins consuming the real device location
      // provider again, so the next onLocation fix is the user's true spot.
      nav.setNavigationRoutes(emptyList())
      nav.stopTripSession()
      nav.startTripSession()
      Log.d(TAG, "sim arrival — handed location source back to real GPS")
    } catch (e: Throwable) {
      Log.w(TAG, "returnToRealLocationAfterSimArrival failed: ${e.message}")
    }
  }

  /**
   * Build ReplayRouteOptions tuned to the travel MODE and a speed
   * multiplier.
   *
   * CRITICAL: Mapbox's default `ReplayRouteOptions` is tuned for DRIVING —
   * `maxSpeedMps = 30` (108 km/h). Using it for a walking trip makes the
   * sim sprint at highway speed (~10 m per tick), which is the "goes much
   * faster than 1×" bug. So we set a realistic cruise speed per mode:
   *   walking ≈ 1.4 m/s, cycling ≈ 5 m/s, driving = Mapbox default.
   * `multiplier` scales that cruise (and turn) speed for fast-forward;
   * 1× = real time.
   */
  private fun replayRouteOptionsFor(mode: String, multiplier: Float): ReplayRouteOptions {
    val m = multiplier.toDouble().coerceIn(0.25, 50.0)
    val base = ReplayRouteOptions.Builder().build()
    // Realistic cruise speed (m/s) for the mode. driving keeps Mapbox's
    // default (already realistic for roads).
    val cruiseMps = when (mode.lowercase()) {
      "walking" -> 1.4
      "cycling" -> 5.0
      "two_wheeler" -> base.maxSpeedMps
      "driving" -> base.maxSpeedMps
      else -> base.maxSpeedMps
    }
    // Turn/u-turn speeds: keep below cruise so corners slow down, but never
    // above the mode cruise (else a walking sim still rounds corners at the
    // driving default of 3 m/s — faster than its 1.4 m/s straightaways).
    val turnMps = minOf(base.turnSpeedMps, cruiseMps)
    val uTurnMps = minOf(base.uTurnSpeedMps, cruiseMps)
    return base.toBuilder()
      .maxSpeedMps(cruiseMps * m)
      .turnSpeedMps(turnMps * m)
      .uTurnSpeedMps(uTurnMps * m)
      .build()
  }

  fun stop() {
    Log.d(TAG, "stop")
    val nav = mapboxNavigation
    activeCallbacks = null
    lastEmittedKey = null
    simulating = false
    simulationSpeed = 1f

    // Tear down dev walkers first.
    skipCrossingsEnabled = false
    skipCrossingsTimer?.cancel(); skipCrossingsTimer = null
    wrongSidewalkOffsetEnabled = false

    if (nav != null) {
      try {
        detachObservers(nav)
        // Detach the replay session (stops the sim, unregisters its
        // internal observers, resets the replayer).
        replaySession?.onDetached(nav)
        replayer?.finish()
        nav.stopTripSession()
        nav.setNavigationRoutes(emptyList())
      } catch (e: Exception) {
        Log.e(TAG, "stop failed", e)
      }
    }
    replaySession = null
    replayer = null

    activePolyline = null
    activeSteps = null
    distanceToDestinationMeters = -1
    timeToDestinationSeconds = -1
    currentManeuverType = null
    distanceToManeuverMeters = null
    currentRoad = null
    nextStepRoad = null
    lastSpeedMps = null
    offRouteFired = false
    activeOptions = null
    pendingRouteRequest = null
    prevFixLat = Double.NaN
    prevFixLng = Double.NaN
    lastFixLat = Double.NaN
    lastFixLng = Double.NaN
  }

  // =====================================================================
  // Observers — translate Mapbox events into the existing Callbacks shape.
  // =====================================================================

  private fun attachObservers(nav: MapboxNavigation, callbacks: Callbacks) {
    // REROUTING IS FULLY OWNED BY MAPBOX. Auto-reroute is ON by default in
    // v3 — when the user diverges, the SDK detects off-route AND fetches a
    // new route on its own. We do NOT hand-roll perpendicular-distance
    // detection, and we do NOT re-request the route ourselves; we just
    // observe and forward the SDK's signals:
    //   - OffRouteObserver        → onOffRoute (purely observational)
    //   - RerouteStateObserver    → onRerouting (FetchingRoute state)
    //   - RoutesObserver(REROUTE) → onRoute (the new route, already active)

    // RoutesObserver — fires on initial route, every reroute, refresh, and
    // alternatives. The new route is ALREADY set active by the SDK; we just
    // flatten + emit it. We branch on `reason` so a reroute emit can also
    // clear our off-route flag and (for the host) reads as a fresh route.
    val routesObs = RoutesObserver { result: RoutesUpdatedResult ->
      val route = result.navigationRoutes.firstOrNull() ?: return@RoutesObserver
      val reason = result.reason
      // Ignore refresh (same geometry, just live traffic) — it would
      // needlessly re-emit the whole polyline + rebuild pivots.
      if (reason == RoutesExtra.ROUTES_UPDATE_REASON_REFRESH) return@RoutesObserver
      if (reason == RoutesExtra.ROUTES_UPDATE_REASON_REROUTE) {
        Log.d(TAG, "routes updated: REROUTE — emitting new route")
        offRouteFired = false // back on (a fresh) route
      }
      emitRoute(route, callbacks)
    }
    routesObserver = routesObs
    nav.registerRoutesObserver(routesObs)

    // RouteProgressObserver — every location tick. Carries current step,
    // upcoming maneuver, distance-to-maneuver, and trip totals.
    val progressObs = RouteProgressObserver { progress: RouteProgress ->
      handleRouteProgress(progress, callbacks)
    }
    routeProgressObserver = progressObs
    nav.registerRouteProgressObserver(progressObs)

    // LocationObserver — enhanced (map-matched) location replaces Google's
    // RoadSnappedLocationProvider.
    val locObs = object : LocationObserver {
      override fun onNewRawLocation(rawLocation: Location) { /* prefer matched */ }
      override fun onNewLocationMatcherResult(result: LocationMatcherResult) {
        handleLocation(result, callbacks)
      }
    }
    locationObserver = locObs
    nav.registerLocationObserver(locObs)

    // OffRouteObserver — Mapbox's automatic off-route edge signal. PURELY
    // OBSERVATIONAL: registering it does NOT disable auto-reroute. We
    // surface onOffRoute for the UI's "off route" banner; the SDK handles
    // the actual reroute and the new route arrives via RoutesObserver.
    val offRouteObs = OffRouteObserver { offRoute: Boolean ->
      if (offRoute && !offRouteFired) {
        offRouteFired = true
        // Distance from the route is best-effort context for the banner;
        // not used to decide anything (the SDK already decided).
        val perp = currentPerpDistanceMeters() ?: 0.0
        Log.d(TAG, "off-route (Mapbox) — perp≈${perp}m; SDK will auto-reroute")
        callbacks.onOffRoute(perp)
      }
    }
    offRouteObserver = offRouteObs
    nav.registerOffRouteObserver(offRouteObs)

    // RerouteStateObserver — the authoritative "we are rerouting" signal.
    // FetchingRoute → onRerouting (UI shows the rerouting state); the new
    // route then lands via RoutesObserver(REROUTE). Available only while
    // auto-reroute is enabled (getRerouteController() is null otherwise).
    val rerouteObs = RerouteController.RerouteStateObserver { state: RerouteState ->
      when (state) {
        is RerouteState.FetchingRoute -> {
          Log.d(TAG, "reroute state: FetchingRoute → onRerouting")
          callbacks.onRerouting()
        }
        is RerouteState.Failed -> {
          Log.w(TAG, "reroute failed: ${state.message}")
          // Don't surface as a hard error — the user is still on the old
          // route and the SDK may retry; just log.
        }
        else -> { /* Idle / RouteFetched / Interrupted — no UI change */ }
      }
    }
    rerouteStateObserver = rerouteObs
    nav.getRerouteController()?.registerRerouteStateObserver(rerouteObs)
  }

  private fun detachObservers(nav: MapboxNavigation) {
    routesObserver?.let { nav.unregisterRoutesObserver(it) }
    routeProgressObserver?.let { nav.unregisterRouteProgressObserver(it) }
    locationObserver?.let { nav.unregisterLocationObserver(it) }
    offRouteObserver?.let { nav.unregisterOffRouteObserver(it) }
    rerouteStateObserver?.let { nav.getRerouteController()?.unregisterRerouteStateObserver(it) }
    routesObserver = null
    routeProgressObserver = null
    locationObserver = null
    offRouteObserver = null
    rerouteStateObserver = null
  }

  /**
   * Translate a RouteProgress tick into trip-state + an emitted maneuver.
   * Mapbox gives us current step / upcoming maneuver / distance-remaining
   * directly, so no polyline bearing-scanning is needed for the live trip
   * (the bearing helpers remain for the dev walkers).
   */
  private fun handleRouteProgress(progress: RouteProgress, callbacks: Callbacks) {
    distanceToDestinationMeters = progress.distanceRemaining.toInt().coerceAtLeast(-1)
    timeToDestinationSeconds = progress.durationRemaining.toInt().coerceAtLeast(-1)

    // Arrival.
    if (progress.currentState == RouteProgressState.COMPLETE) {
      callbacks.onArrived()
      // In sim mode the puck is now parked at the SIMULATED destination, so
      // the app's idea of "where I am" is the sim endpoint, not reality.
      // Hand the location source back to real GPS so the idle map snaps to
      // the user's actual position. Guarded by `arrivedHandled` so the
      // repeated COMPLETE ticks the SDK emits after arrival don't reset the
      // session over and over.
      if (simulating && !arrivedHandled) {
        arrivedHandled = true
        returnToRealLocationAfterSimArrival()
      }
      return
    }

    val legProgress = progress.currentLegProgress
    val stepProgress = legProgress?.currentStepProgress
    val upcomingStep = legProgress?.upcomingStep
    val currentStep = stepProgress?.step

    // Show the maneuver the user is WALKING TOWARD — i.e. the UPCOMING step's
    // maneuver — together with the distance to it.
    //
    // In Mapbox, `currentStep.maneuver` is the maneuver that BEGAN the
    // current step (the depart, or the turn you just took), so showing it
    // means the card says "Walk on Market St" for the whole approach and
    // only flips to "Turn left" once you're already at the corner — one
    // step behind. The `upcomingStep.maneuver` is the NEXT turn (the one
    // ahead), and `stepProgress.distanceRemaining` is the distance to the
    // END of the current step == where that upcoming maneuver happens. So
    // upcomingStep.maneuver + distanceRemaining is the matched pair that
    // reads "In 120 m, turn left onto the walkway" the whole way in, then
    // "Now" inside the turn radius.
    //
    // The turn-display step (what we show) and its road:
    val turnStep = upcomingStep ?: currentStep // upcoming normally; current only on the final/arrival leg
    val distToManeuver = stepProgress?.distanceRemaining?.toInt() ?: -1
    distanceToManeuverMeters = distToManeuver

    val maneuver = turnStep?.maneuver()?.let { mapManeuver(it) } ?: "STRAIGHT"
    currentManeuverType = maneuver
    // Road the user is currently on = the current step's road; the road
    // being entered at the turn = the upcoming step's road.
    currentRoad = currentStep?.name()?.takeIf { it.isNotBlank() }
    nextStepRoad = upcomingStep?.name()?.takeIf { it.isNotBlank() }

    // Verbatim instruction for the maneuver we're showing (the upcoming
    // turn). Same step as `maneuver`/`distToManeuver` so they stay
    // consistent — the instruction describes the turn ahead, not the road
    // we're currently walking.
    val instruction = turnStep?.maneuver()?.instruction()?.takeIf { it.isNotBlank() }

    val payload = ManeuverPayload(
      maneuverType = maneuver,
      distanceMeters = distToManeuver,
      fromRoad = currentRoad,
      toRoad = currentRoad, // legacy field == fromRoad, matching Google behavior
      nextStepRoad = nextStepRoad,
      distanceToDestinationMeters = distanceToDestinationMeters,
      timeToDestinationSeconds = timeToDestinationSeconds,
      currentSpeedMps = lastSpeedMps,
      routeHeadingDeg = null,
      instruction = instruction,
    )
    emitManeuverIfChanged(payload, callbacks)
  }

  /**
   * Per-METRE dedup. ReplayRouteSession/RouteProgress ticks ~1 Hz while
   * moving, so a 1 m bucket means the maneuver "In X m" countdown updates
   * roughly once a second and stays in lockstep with the trip
   * distance-to-destination shown on the HUD. (The old 5 m / 10 m buckets
   * made "In 200 m" look frozen for several seconds and let the maneuver
   * distance drift out of agreement with the overall distance on the final
   * leg — e.g. card "In 70 m" while the HUD already said 65 m.)
   *
   * Both distance fields go into the key at 1 m granularity so a change in
   * EITHER re-emits — the card's "In X m" and the HUD's "Arriving in X m"
   * track the same value, to the metre, all the way to the door.
   */
  private fun emitManeuverIfChanged(payload: ManeuverPayload, callbacks: Callbacks) {
    val distBucket = if (payload.distanceMeters >= 0) payload.distanceMeters else -1
    val tripBucket = if (payload.distanceToDestinationMeters >= 0) payload.distanceToDestinationMeters else -1
    val key = "${payload.maneuverType}|$distBucket|$tripBucket"
    // Diagnostic: log EVERY tick (before the dedup early-return) so we can see
    // whether the step distance (top box) is actually moving in lockstep with
    // the trip distance (bottom box), and whether the dedup is suppressing it.
    android.util.Log.d(
      "NavManeuverDist",
      "step=${payload.distanceMeters}m trip=${payload.distanceToDestinationMeters}m type=${payload.maneuverType} key=$key emit=${key != lastEmittedKey}",
    )
    if (key == lastEmittedKey) return
    lastEmittedKey = key
    callbacks.onManeuver(payload)
  }

  private fun handleLocation(result: LocationMatcherResult, callbacks: Callbacks) {
    val loc = result.enhancedLocation

    // First-fix gate: if a route request is pending (start() deferred it
    // until we had a real origin), fire it now with the raw device
    // position — NOT any dev-shifted variant. Cleared so it runs once.
    val pending = pendingRouteRequest
    if (pending != null) {
      pendingRouteRequest = null
      pending(loc.latitude, loc.longitude)
    }

    var effectiveLat = loc.latitude
    var effectiveLng = loc.longitude

    if (wrongSidewalkOffsetEnabled) {
      val flat = activePolyline
      if (flat != null && flat.size >= 2) {
        val (idx, _) = closestSegmentIndex(flat, effectiveLat, effectiveLng)
        val a = flat[idx]
        val b = flat[(idx + 1).coerceAtMost(flat.size - 1)]
        val routeBearing = bearing(a.first, a.second, b.first, b.second)
        val perpBearing = (routeBearing + 90.0) % 360.0
        val (offLat, offLng) = movePoint(effectiveLat, effectiveLng, WRONG_SIDEWALK_OFFSET_M, perpBearing)
        effectiveLat = offLat
        effectiveLng = offLng
      }
    }

    prevFixLat = lastFixLat
    prevFixLng = lastFixLng
    lastFixLat = effectiveLat
    lastFixLng = effectiveLng
    lastSpeedMps = loc.speed?.toFloat()

    callbacks.onLocation(
      LocationPayload(
        lat = effectiveLat,
        lng = effectiveLng,
        accuracy = loc.horizontalAccuracy?.toFloat(),
        timestamp = System.currentTimeMillis(),
      ),
    )
    // Off-route detection is now FULLY owned by Mapbox (OffRouteObserver +
    // automatic reroute). No hand-rolled perpendicular-distance check here.
  }

  /** Perp distance from the last fix to the active polyline, or null. */
  private fun currentPerpDistanceMeters(): Double? {
    val flat = activePolyline ?: return null
    if (flat.size < 2 || lastFixLat.isNaN() || lastFixLng.isNaN()) return null
    val (_, perp) = closestSegmentIndex(flat, lastFixLat, lastFixLng)
    return perp
  }

  // =====================================================================
  // Route emit — flatten a NavigationRoute into the wire RoutePoint/RouteStep
  // shape. Mapbox carries steps inline, so unlike Google there's no deferred
  // re-emit waiting on a separate NavInfo service.
  // =====================================================================

  private fun emitRoute(route: NavigationRoute, callbacks: Callbacks) {
    try {
      val directionsRoute = route.directionsRoute
      val geometry = directionsRoute.geometry()
      val points: List<RoutePoint> = decodeGeometry(route)
      if (points.isEmpty()) {
        Log.w(TAG, "route geometry empty, nothing to emit")
        return
      }
      val steps = buildRouteSteps(directionsRoute, points)
      activePolyline = points.map { it.lat to it.lng }
      activeSteps = steps
      Log.d(TAG, "emit route — ${points.size} points, steps=${steps?.size ?: "null"}")
      callbacks.onRoute(points, steps)
    } catch (e: Exception) {
      Log.e(TAG, "emitRoute failed", e)
    }
  }

  /** Decode the route polyline. NavigationRoute exposes the full geometry. */
  private fun decodeGeometry(route: NavigationRoute): List<RoutePoint> {
    val out = ArrayList<RoutePoint>()
    // The directions route geometry honors the request's geometry
    // precision; NavigationRoute also exposes per-step geometry. Walk the
    // legs' steps' geometry to assemble the full polyline in order.
    val legs = route.directionsRoute.legs() ?: return out
    for (leg in legs) {
      val steps = leg.steps() ?: continue
      for (step in steps) {
        val geom = step.geometry() ?: continue
        val pts = com.mapbox.geojson.utils.PolylineUtils.decode(geom, 6)
        for (p in pts) out.add(RoutePoint(p.latitude(), p.longitude()))
      }
    }
    return out
  }

  /**
   * Build the wire-shape step list from the Directions legs/steps. Unlike
   * Google's StepInfo (no coordinates), Mapbox `LegStep` carries its own
   * geometry, so each step's start vertex is exact — no polyline-walking
   * by cumulative distance needed.
   */
  private fun buildRouteSteps(route: DirectionsRoute, points: List<RoutePoint>): List<RouteStep>? {
    val legs = route.legs() ?: return null
    val out = ArrayList<RouteStep>()
    var runningIndex = 0
    for (leg in legs) {
      val steps = leg.steps() ?: continue
      for (step in steps) {
        val maneuver = step.maneuver()?.let { mapManeuver(it) } ?: "STRAIGHT"
        val road = step.name()?.takeIf { it.isNotBlank() }
        val loc = step.maneuver()?.location()
        val lat = loc?.latitude() ?: continue
        val lng = loc.longitude()
        // routeIndex: nearest polyline vertex to this step's maneuver point.
        val idx = nearestPointIndex(points, lat, lng, runningIndex)
        runningIndex = idx
        out.add(
          RouteStep(
            lat = lat,
            lng = lng,
            routeIndex = idx,
            road = road,
            maneuver = maneuver,
            distanceMeters = step.distance().toInt(),
          ),
        )
      }
    }
    return if (out.isEmpty()) null else out
  }

  /** Nearest polyline vertex to (lat,lng), scanning forward from `from`. */
  private fun nearestPointIndex(points: List<RoutePoint>, lat: Double, lng: Double, from: Int): Int {
    var best = from.coerceIn(0, points.size - 1)
    var bestD = Double.MAX_VALUE
    for (i in from until points.size) {
      val dLat = points[i].lat - lat
      val dLng = points[i].lng - lng
      val d = dLat * dLat + dLng * dLng
      if (d < bestD) { bestD = d; best = i }
    }
    return best
  }

  // =====================================================================
  // Maneuver mapping — Mapbox `type` + `modifier` → our ManeuverKind union.
  // (Replaces NavInfoReceiverService.mapManeuver's Google-enum table.)
  // =====================================================================

  /**
   * Reduce a Mapbox StepManeuver (type + modifier) to the categorical
   * string vocabulary the bridge already uses: STRAIGHT, CONTINUE,
   * SLIGHT_LEFT, SLIGHT_RIGHT, TURN_LEFT, TURN_RIGHT, SHARP_LEFT,
   * SHARP_RIGHT, U_TURN, NAME_CHANGE, DEPART, ARRIVE.
   *
   * Per the migration doc §7. The PivotEngine trusts polyline geometry
   * over this string for left/right, so roundabout approximations degrade
   * gracefully.
   */
  @JvmStatic
  fun mapManeuver(maneuver: StepManeuver): String {
    val type = maneuver.type()
    val modifier = maneuver.modifier()
    return when (type) {
      StepManeuver.DEPART -> "DEPART"
      StepManeuver.ARRIVE -> "ARRIVE"
      StepManeuver.NEW_NAME -> "NAME_CHANGE"
      StepManeuver.CONTINUE, StepManeuver.MERGE -> "CONTINUE"
      StepManeuver.NOTIFICATION -> "STRAIGHT"
      // turn / end of road / fork / on ramp / off ramp / roundabout* →
      // classify by modifier.
      else -> classifyModifier(modifier)
    }
  }

  private fun classifyModifier(modifier: String?): String = when (modifier) {
    ManeuverModifier.UTURN -> "U_TURN"
    ManeuverModifier.SHARP_LEFT -> "SHARP_LEFT"
    ManeuverModifier.LEFT -> "TURN_LEFT"
    ManeuverModifier.SLIGHT_LEFT -> "SLIGHT_LEFT"
    ManeuverModifier.STRAIGHT -> "STRAIGHT"
    ManeuverModifier.SLIGHT_RIGHT -> "SLIGHT_RIGHT"
    ManeuverModifier.RIGHT -> "TURN_RIGHT"
    ManeuverModifier.SHARP_RIGHT -> "SHARP_RIGHT"
    else -> "STRAIGHT"
  }

  // =====================================================================
  // Dev simulation — full parity with the Google implementation, driven by
  // MapboxReplayer instead of Google's Navigator.simulator.
  // =====================================================================

  /**
   * Dev-only: shove the simulated puck OFF the active route so Mapbox's
   * built-in off-route detection + automatic rerouting kick in — exactly
   * like a real GPS divergence. We no longer hand-roll the off-route math
   * or call requestRoutes ourselves; we just teleport the replay puck
   * `DEVIATE_OFFSET_M` perpendicular to the route and let the SDK do the
   * rest (OffRouteObserver → onOffRoute, RerouteState → onRerouting,
   * RoutesObserver(REROUTE) → onRoute).
   *
   * Requires simulate mode (a replayer to inject into). On a real-GPS trip
   * there's nothing to push, so it no-ops with a log. `offsetMeters` from
   * the legacy protocol overrides the default jump distance when > 0.
   */
  @OptIn(ExperimentalPreviewMapboxNavigationAPI::class)
  fun simulateDeviation(offsetMeters: Double = 0.0) {
    val replayer = replayer ?: run {
      Log.w(TAG, "simulateDeviation: not in simulate mode — nothing to push off-route")
      return
    }
    if (lastFixLat.isNaN() || lastFixLng.isNaN()) {
      Log.w(TAG, "simulateDeviation: no last fix yet")
      return
    }

    val nav = mapboxNavigation ?: run { Log.w(TAG, "simulateDeviation: no navigation"); return }

    // Perpendicular bearing to walk along. Use the route's local bearing at
    // the puck so we step SIDEWAYS off the road; fall back to the user's
    // recent travel bearing + 90°.
    val flat = activePolyline
    val sideBearing: Double = if (flat != null && flat.size >= 2) {
      val (idx, _) = closestSegmentIndex(flat, lastFixLat, lastFixLng)
      val a = flat[idx]
      val b = flat[(idx + 1).coerceAtMost(flat.size - 1)]
      (bearing(a.first, a.second, b.first, b.second) + 90.0) % 360.0
    } else if (!prevFixLat.isNaN() && haversine(prevFixLat, prevFixLng, lastFixLat, lastFixLng) > 0.5) {
      (bearing(prevFixLat, prevFixLng, lastFixLat, lastFixLng) + 90.0) % 360.0
    } else {
      90.0 // arbitrary — due east
    }

    val maxJump = if (offsetMeters > 0.0) offsetMeters else DEVIATE_OFFSET_M

    // THE KEY: ReplayRouteSession keeps pushing ON-ROUTE locations every
    // RouteProgress tick (its internal RouteProgressObserver → pushEvents),
    // so a one-off off-route blip is immediately buried and the puck never
    // actually leaves the route. To force a real divergence we must:
    //   1. detach the session so it stops feeding on-route points,
    //   2. clear its queued on-route events,
    //   3. push a SUSTAINED stream walking progressively off-route (so the
    //      divergence persists long enough for Mapbox to detect it),
    //   4. once the reroute lands (RoutesObserver REROUTE), the session is
    //      re-attached so the puck resumes on the NEW route.
    try {
      replaySession?.onDetached(nav)
      replayer.clearEvents()

      // Walk from the puck outward to maxJump in ~10m steps, each a
      // separate replay location so the off-route position is held across
      // several ticks rather than a single frame.
      //
      // CRITICAL: the replayer plays events ordered/paced by eventTimestamp.
      // All-zero timestamps would collapse into a single instant and never
      // play as a sequence — so we stamp each event with a monotonically
      // increasing time (1s apart) to hold the off-route position over
      // several real seconds, which is what lets the detector latch.
      val baseLat = lastFixLat
      val baseLng = lastFixLng
      val events = ArrayList<ReplayEventBase>()
      var d = 10.0
      var ts = 0.0
      while (d <= maxJump) {
        val (oLat, oLng) = movePoint(baseLat, baseLng, d, sideBearing)
        events.add(ReplayRouteMapper.mapToUpdateLocation(ts, Point.fromLngLat(oLng, oLat)))
        d += 10.0
        ts += 1.0
      }
      // Hold at the farthest point for a few extra seconds so the off-route
      // condition is unambiguous and the detector latches.
      val (farLat, farLng) = movePoint(baseLat, baseLng, maxJump, sideBearing)
      val farPoint = Point.fromLngLat(farLng, farLat)
      repeat(6) {
        events.add(ReplayRouteMapper.mapToUpdateLocation(ts, farPoint))
        ts += 1.0
      }

      Log.d(TAG, "simulateDeviation: detached session, walking ${maxJump}m off-route in ${events.size} events")
      replayer.pushEvents(events)
      replayer.play()

      // The divergence above moves the puck off-route (which exercises the
      // OffRouteObserver / banner path). But to GUARANTEE a reroute even if
      // the replayed divergence is too brief for the native detector, also
      // ask the RerouteController to reroute directly — this is the reliable
      // trigger. It fetches a new route from the current (now off-route)
      // position and the result flows through RoutesObserver(REROUTE) →
      // onRoute exactly like an automatic reroute. Fire it slightly after
      // the off-route events start playing so the controller reroutes from
      // the diverged position, not the on-route one.
      val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
      mainHandler.postDelayed({
        try {
          val controller = mapboxNavigation?.getRerouteController()
          if (controller != null) {
            // onRerouting fires automatically via our RerouteStateObserver
            // (FetchingRoute) when reroute() runs — no manual call needed.
            Log.d(TAG, "simulateDeviation: requesting reroute() directly")
            controller.reroute(
              RerouteController.RoutesCallback { routes: List<NavigationRoute>, _: String ->
                // RoutesObserver(REROUTE) will also fire and emit the route;
                // we don't setNavigationRoutes here (the controller does).
                Log.d(TAG, "simulateDeviation: reroute() returned ${routes.size} route(s)")
              },
            )
          } else {
            Log.w(TAG, "simulateDeviation: no reroute controller (auto-reroute disabled?)")
          }
        } catch (e: Throwable) {
          Log.e(TAG, "simulateDeviation reroute() failed", e)
        }
      }, 1500L)

      // Re-attach the session so it resumes driving the puck once a route is
      // active again (locationResetEnabled snaps it onto the new route).
      // Delay until AFTER the off-route events + reroute fetch.
      val playSeconds = (ts / simulationSpeed.coerceAtLeast(0.1f)).toDouble()
      val reattachMs = ((playSeconds + 4.0) * 1000.0).toLong().coerceIn(5000L, 20000L)
      mainHandler.postDelayed({
        try {
          if (simulating) replaySession?.onAttached(nav)
        } catch (e: Throwable) {
          Log.w(TAG, "simulateDeviation: re-attach session failed: ${e.message}")
        }
      }, reattachMs)
    } catch (e: Throwable) {
      Log.e(TAG, "simulateDeviation push failed", e)
    }
  }

  /**
   * Dev toggle. Shift every emitted location ~8m perpendicular-right of the
   * route bearing, simulating a wrong-sidewalk pedestrian.
   */
  fun setWrongSidewalkOffset(enabled: Boolean) {
    Log.d(TAG, "setWrongSidewalkOffset($enabled)")
    wrongSidewalkOffsetEnabled = enabled
  }

  /**
   * Dev toggle. Take over from the replayer and walk a polyline with
   * crossing micro-steps removed. When disabled, hand control back to the
   * replayer on the active route.
   */
  fun setSkipCrossings(enabled: Boolean) {
    Log.d(TAG, "setSkipCrossings($enabled)")
    skipCrossingsEnabled = enabled
    if (enabled) startSkipCrossingsWalker() else stopSkipCrossingsWalker(resumeReplay = true)
  }

  private fun startSkipCrossingsWalker() {
    val flat = activePolyline
    if (flat == null || flat.size < 2) { Log.w(TAG, "startSkipCrossingsWalker: no route polyline"); return }
    try { replayer?.stop() } catch (_: Throwable) {}
    val modified = stripCrossings(flat)
    Log.d(TAG, "skip-crossings walker: original=${flat.size} pts, modified=${modified.size} pts")
    stopSkipCrossingsWalker(resumeReplay = false)
    val startIdx = if (!lastFixLat.isNaN() && !lastFixLng.isNaN()) {
      closestPolylineIndex(modified, lastFixLat, lastFixLng)
    } else 0
    val timer = java.util.Timer("skipCrossingsWalker", true)
    val stepMeters = SKIP_CROSSINGS_BASE_M_PER_TICK * simulationSpeed
    var cursor = startIdx.toDouble()
    val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
    timer.scheduleAtFixedRate(object : java.util.TimerTask() {
      override fun run() {
        mainHandler.post {
          try {
            if (!skipCrossingsEnabled) { cancel(); return@post }
            cursor = advanceCursor(modified, cursor, stepMeters)
            if (cursor >= modified.size - 1) { cancel(); return@post }
            val (lat, lng) = pointAt(modified, cursor)
            val brng = run {
              val (nlat, nlng) = pointAt(modified, (cursor + 0.5).coerceAtMost(modified.size - 1.0))
              bearing(lat, lng, nlat, nlng)
            }
            pushReplayLocation(lat, lng, brng)
            activeCallbacks?.onLocation(LocationPayload(lat, lng, null, System.currentTimeMillis()))
            prevFixLat = lastFixLat; prevFixLng = lastFixLng
            lastFixLat = lat; lastFixLng = lng
          } catch (e: Throwable) {
            Log.e(TAG, "skip-crossings walker tick failed", e)
          }
        }
      }
    }, 0L, SKIP_CROSSINGS_TICK_MS)
    skipCrossingsTimer = timer
  }

  private fun stopSkipCrossingsWalker(resumeReplay: Boolean) {
    skipCrossingsTimer?.cancel(); skipCrossingsTimer = null
    if (resumeReplay && simulating) restartReplayOnActiveRoute()
  }

  /**
   * (Re)start the replayer driving the current active route at
   * simulationSpeed. Called once the route lands (start) and on every
   * reroute.
   *
   * Ordering matters and was the source of the "sim sometimes doesn't go
   * off" bug:
   *   1. stop() the player first — if it's mid-playback on the old buffer
   *      (or the bootstrap seed location), pushing/clearing under it raced
   *      and play() could no-op.
   *   2. clearEvents() wipes the seed + any prior route events so the new
   *      route plays from its true start.
   *   3. set playbackSpeed BEFORE play so the first tick is already at the
   *      right rate.
   *   4. play() — starts from the head of the freshly-pushed buffer. We do
   *      NOT seekTo(firstEvent): seeking to a specific event object after a
   *      clear was unreliable (it occasionally landed past the start or on
   *      a stale reference), leaving the puck frozen.
   */
  private fun restartReplayOnActiveRoute() {
    val nav = mapboxNavigation ?: return
    val replayer = replayer ?: return
    val route = nav.getNavigationRoutes().firstOrNull() ?: return
    try {
      val events = replayRouteMapper.mapDirectionsRouteGeometry(route.directionsRoute)
      if (events.isEmpty()) {
        Log.w(TAG, "restartReplayOnActiveRoute: no replay events from route geometry")
        return
      }
      replayer.stop()
      replayer.clearEvents()
      replayer.pushEvents(events)
      replayer.playbackSpeed(simulationSpeed.toDouble())
      replayer.play()
      Log.d(TAG, "replay restarted — ${events.size} events @ ${simulationSpeed}×")
    } catch (e: Throwable) {
      Log.w(TAG, "restartReplayOnActiveRoute failed: ${e.message}")
    }
  }

  /** Push one synthetic location into the replayer (used by the dev walkers). */
  private fun pushReplayLocation(lat: Double, lng: Double, bearingDeg: Double) {
    val replayer = replayer ?: return
    // ReplayEventLocation(lon, lat, provider, time, altitude,
    //   accuracyHorizontal, bearing, speed) — positional; nullable fields
    //   are boxed Double?.
    val location = ReplayEventLocation(
      lng,
      lat,
      "mentra-dev-walker",
      null,
      null,
      null,
      bearingDeg,
      DEVIATE_BASE_MPS * simulationSpeed,
    )
    val event = ReplayEventUpdateLocation(0.0, location)
    try {
      replayer.pushEvents(listOf<ReplayEventBase>(event))
      replayer.play()
    } catch (e: Throwable) {
      Log.w(TAG, "pushReplayLocation failed: ${e.message}")
    }
  }

  // ---- crossing strip (unchanged math from the Google implementation) ----

  private fun stripCrossings(points: List<Pair<Double, Double>>): List<Pair<Double, Double>> {
    if (points.size < 4) return points
    val out = ArrayList<Pair<Double, Double>>(points.size)
    out.add(points[0])
    var i = 1
    while (i < points.size - 1) {
      val prev = points[i - 1]; val here = points[i]; val next = points[i + 1]
      val legOut = haversine(here.first, here.second, next.first, next.second)
      val bearIn = bearing(prev.first, prev.second, here.first, here.second)
      val bearOut = bearing(here.first, here.second, next.first, next.second)
      val bend = bearingDiffAbs(bearIn, bearOut)
      val looksLikeCrossingStart = legOut < CROSSING_MAX_LEG_METERS && bend > CROSSING_MIN_BEND_DEG
      if (looksLikeCrossingStart && i + 2 < points.size) {
        val afterNext = points[i + 2]
        val bearAfter = bearing(next.first, next.second, afterNext.first, afterNext.second)
        val bendBack = bearingDiffAbs(bearOut, bearAfter)
        val isCrossing = bendBack > CROSSING_MIN_BEND_DEG &&
          bearingDiffAbs(bearIn, bearAfter) < CROSSING_MIN_BEND_DEG
        if (isCrossing) {
          val legAfter = haversine(next.first, next.second, afterNext.first, afterNext.second)
          val skipDist = legOut + legAfter
          val (newLat, newLng) = movePoint(here.first, here.second, skipDist, bearIn)
          out.add(Pair(newLat, newLng))
          i += 3
          continue
        }
      }
      out.add(here)
      i++
    }
    if (out.last() != points.last()) out.add(points.last())
    return out
  }

  private fun bearingDiffAbs(a: Double, b: Double): Double {
    val d = (a - b + 540.0) % 360.0 - 180.0
    return kotlin.math.abs(d)
  }

  private fun closestPolylineIndex(points: List<Pair<Double, Double>>, lat: Double, lng: Double): Int {
    var best = 0; var bestD = Double.MAX_VALUE
    for (i in points.indices) {
      val (plat, plng) = points[i]
      val dx = plat - lat; val dy = plng - lng
      val d = dx * dx + dy * dy
      if (d < bestD) { bestD = d; best = i }
    }
    return best
  }

  private fun advanceCursor(points: List<Pair<Double, Double>>, cursor: Double, meters: Double): Double {
    if (points.size < 2) return cursor.coerceAtMost(0.0)
    var idx = cursor.toInt(); var frac = cursor - idx; var remaining = meters
    while (remaining > 0 && idx < points.size - 1) {
      val a = points[idx]; val b = points[idx + 1]
      val segLen = haversine(a.first, a.second, b.first, b.second)
      val segLeft = (1.0 - frac) * segLen
      if (remaining < segLeft) { frac += remaining / segLen; remaining = 0.0 }
      else { remaining -= segLeft; idx++; frac = 0.0 }
    }
    return idx.toDouble() + frac
  }

  private fun pointAt(points: List<Pair<Double, Double>>, cursor: Double): Pair<Double, Double> {
    val idx = cursor.toInt().coerceIn(0, points.size - 1)
    val frac = (cursor - idx).coerceIn(0.0, 1.0)
    if (idx >= points.size - 1) return points.last()
    val a = points[idx]; val b = points[idx + 1]
    return Pair(a.first + (b.first - a.first) * frac, a.second + (b.second - a.second) * frac)
  }

  private fun movePoint(lat: Double, lng: Double, meters: Double, bearingDeg: Double): Pair<Double, Double> {
    val r = 6_371_000.0
    val brng = Math.toRadians(bearingDeg)
    val lat1 = Math.toRadians(lat); val lng1 = Math.toRadians(lng)
    val ad = meters / r
    val lat2 = kotlin.math.asin(
      kotlin.math.sin(lat1) * kotlin.math.cos(ad) +
        kotlin.math.cos(lat1) * kotlin.math.sin(ad) * kotlin.math.cos(brng),
    )
    val lng2 = lng1 + kotlin.math.atan2(
      kotlin.math.sin(brng) * kotlin.math.sin(ad) * kotlin.math.cos(lat1),
      kotlin.math.cos(ad) - kotlin.math.sin(lat1) * kotlin.math.sin(lat2),
    )
    return Math.toDegrees(lat2) to Math.toDegrees(lng2)
  }

  // ---- math helpers (unchanged) ----

  private fun haversine(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
    val r = 6_371_000.0
    val dLat = Math.toRadians(lat2 - lat1)
    val dLng = Math.toRadians(lng2 - lng1)
    val a = kotlin.math.sin(dLat / 2).let { it * it } +
      kotlin.math.cos(Math.toRadians(lat1)) *
      kotlin.math.cos(Math.toRadians(lat2)) *
      kotlin.math.sin(dLng / 2).let { it * it }
    return 2 * r * kotlin.math.asin(kotlin.math.sqrt(a))
  }

  private fun bearing(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
    val phi1 = Math.toRadians(lat1); val phi2 = Math.toRadians(lat2)
    val lam1 = Math.toRadians(lng1); val lam2 = Math.toRadians(lng2)
    val y = kotlin.math.sin(lam2 - lam1) * kotlin.math.cos(phi2)
    val x = kotlin.math.cos(phi1) * kotlin.math.sin(phi2) -
      kotlin.math.sin(phi1) * kotlin.math.cos(phi2) * kotlin.math.cos(lam2 - lam1)
    val deg = Math.toDegrees(kotlin.math.atan2(y, x))
    return (deg + 360.0) % 360.0
  }

  private fun closestSegmentIndex(
    pts: List<Pair<Double, Double>>, lat: Double, lng: Double,
  ): Pair<Int, Double> {
    var bestIdx = 0; var bestDist = Double.POSITIVE_INFINITY
    for (i in 0 until pts.size - 1) {
      val d = perpDistanceMeters(lat, lng, pts[i].first, pts[i].second, pts[i + 1].first, pts[i + 1].second)
      if (d < bestDist) { bestDist = d; bestIdx = i }
    }
    return Pair(bestIdx, bestDist)
  }

  private fun perpDistanceMeters(
    pLat: Double, pLng: Double, aLat: Double, aLng: Double, bLat: Double, bLng: Double,
  ): Double {
    val mPerDegLat = 111_320.0
    val mPerDegLng = 111_320.0 * kotlin.math.cos(Math.toRadians(aLat))
    val px = (pLng - aLng) * mPerDegLng; val py = (pLat - aLat) * mPerDegLat
    val bx = (bLng - aLng) * mPerDegLng; val by = (bLat - aLat) * mPerDegLat
    val len2 = bx * bx + by * by
    if (len2 == 0.0) return kotlin.math.sqrt(px * px + py * py)
    var t = (px * bx + py * by) / len2
    t = t.coerceIn(0.0, 1.0)
    val projx = t * bx; val projy = t * by
    return kotlin.math.sqrt((px - projx).let { it * it } + (py - projy).let { it * it })
  }
}
