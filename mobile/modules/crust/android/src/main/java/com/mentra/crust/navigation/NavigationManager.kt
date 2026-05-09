package com.mentra.crust.navigation

import android.app.Activity
import android.content.Context
import android.location.Location
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.android.libraries.navigation.ArrivalEvent
import com.google.android.libraries.navigation.NavigationApi
import com.google.android.libraries.navigation.Navigator
import com.google.android.libraries.navigation.RoadSnappedLocationProvider
import com.google.android.libraries.navigation.RoutingOptions
import com.google.android.libraries.navigation.SimulationOptions
import com.google.android.libraries.navigation.TermsAndConditionsCheckOption
import com.google.android.libraries.navigation.Waypoint

/**
 * NavigationManager
 *
 * Singleton wrapper around the Google Navigation SDK for Android.
 * Owns the Navigator lifecycle, attaches listeners, and exposes
 * coarse callbacks consumed by CrustModule (which forwards them as
 * events to JS).
 *
 * Headless: never mounts a NavigationView. The mobile app does not
 * render a map.
 */
object NavigationManager {
  private const val TAG = "NavigationManager"
  private const val POLL_INTERVAL_MS = 1000L

  private var navigator: Navigator? = null
  private var roadSnappedProvider: RoadSnappedLocationProvider? = null
  private var roadSnappedListener: RoadSnappedLocationProvider.LocationListener? = null
  private var arrivalListener: Navigator.ArrivalListener? = null
  private var routeChangedListener: Navigator.RouteChangedListener? = null
  private var pollHandler: Handler? = null
  private var pollRunnable: Runnable? = null
  private var lastEmittedKey: String? = null
  private var activeCallbacks: Callbacks? = null
  /** True iff the active trip is using simulated locations. Drives reroute-restart logic. */
  private var simulating: Boolean = false
  /** Saved speed multiplier so deviation/reroute can resume at the same pace. */
  private var simulationSpeed: Float = 1f
  /** Most recent road-snapped fix. Used to compute distance-to-maneuver. */
  private var lastFixLat: Double = Double.NaN
  private var lastFixLng: Double = Double.NaN
  /** Most recent speed in m/s, off the road-snapped Location. Null until first sample. */
  private var lastSpeedMps: Float? = null
  /** Set true once we cross the off-route threshold; cleared by the route-changed listener. */
  private var offRouteFired: Boolean = false
  /** Distance threshold (meters) at which we declare the user has left the route. */
  private val OFF_ROUTE_THRESHOLD_M = 30.0

  data class ManeuverPayload(
    /**
     * Categorical type of the upcoming maneuver, derived from the
     * bearing delta between consecutive route segments. One of:
     * STRAIGHT, SLIGHT_LEFT, SLIGHT_RIGHT, TURN_LEFT, TURN_RIGHT,
     * SHARP_LEFT, SHARP_RIGHT, U_TURN, ARRIVE.
     */
    val maneuverType: String,
    /** Meters from the user's current position to that maneuver. -1 if unknown. */
    val distanceMeters: Int,
    /** Road the user is currently on, per the Nav SDK. Null if unavailable. */
    val fromRoad: String?,
    /**
     * Legacy "next road" field — historically populated from the same
     * source as `fromRoad` (see NavInfoReceiverService). Kept for
     * back-compat; new consumers should read `nextStepRoad` instead,
     * which is the road of the step AFTER the upcoming maneuver.
     */
    val toRoad: String?,
    /**
     * Road the user will be on AFTER the upcoming maneuver, per the Nav
     * SDK's `remainingSteps[0]`. This is the value the UI uses for the
     * "next street" headline. Null when the SDK hasn't surfaced a
     * remaining step yet (e.g. before first NavInfo, on the final leg).
     */
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
  )

  data class LocationPayload(
    val lat: Double,
    val lng: Double,
    val accuracy: Float?,
    val timestamp: Long,
  )

  data class RoutePoint(val lat: Double, val lng: Double)

  interface Callbacks {
    fun onManeuver(payload: ManeuverPayload)
    fun onRerouting()
    fun onArrived()
    fun onError(message: String)
    fun onLocation(payload: LocationPayload)
    fun onRoute(points: List<RoutePoint>)
    /**
     * Fires once when the user crosses the off-route threshold. Always
     * arrives before `onRerouting` for the same deviation so a miniapp
     * can render an "off route" banner before the rebuild starts.
     */
    fun onOffRoute(perpendicularDistanceMeters: Double)
  }

  /** Process-lifetime flag: set to true once the user has accepted T&C in
   *  this app run. Backstop in case `NavigationApi.areTermsAccepted()`
   *  returns stale data within the same process. */
  private var termsAcceptedThisProcess: Boolean = false

  private const val PREFS_NAME = "mentra_nav_prefs"
  private const val PREF_TERMS_ACCEPTED = "terms_accepted"

  private fun readTermsAcceptedPref(activity: Activity): Boolean {
    return activity.applicationContext
      .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .getBoolean(PREF_TERMS_ACCEPTED, false)
  }

  private fun writeTermsAcceptedPref(activity: Activity) {
    activity.applicationContext
      .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(PREF_TERMS_ACCEPTED, true)
      .apply()
  }

  /** Trip configuration. `stops` is the canonical destination list (last is final). */
  data class StartOptions(
    val stops: List<Pair<Double, Double>>,
    val mode: String = "driving",
    val avoidHighways: Boolean = false,
    val avoidTolls: Boolean = false,
    val avoidFerries: Boolean = false,
    val simulate: Boolean = false,
    val speedMultiplier: Float = 5f,
  )

  /**
   * Ensure the Google Nav SDK Terms & Conditions dialog has been accepted,
   * without starting a trip. Resolves immediately when acceptance is
   * already on file (SDK, on-disk pref, or in-process flag); otherwise
   * shows the dialog and resolves with the user's response.
   *
   * Designed to be called once, eagerly, when a navigation-aware miniapp
   * mounts — so by the time the user hits "start" the dialog is out of
   * the way. Idempotent and safe to call repeatedly.
   */
  fun ensureTermsAccepted(
    activity: Activity,
    onResult: (accepted: Boolean) -> Unit,
  ) {
    val sdkAccepted = NavigationApi.areTermsAccepted(activity.application)
    val prefAccepted = readTermsAcceptedPref(activity)
    Log.d(
      TAG,
      "ensureTermsAccepted — sdkAccepted=$sdkAccepted, prefAccepted=$prefAccepted, processFlag=$termsAcceptedThisProcess",
    )
    if (sdkAccepted || prefAccepted || termsAcceptedThisProcess) {
      termsAcceptedThisProcess = true
      onResult(true)
      return
    }
    NavigationApi.showTermsAndConditionsDialog(
      activity,
      "Mentra",
      object : NavigationApi.OnTermsResponseListener {
        override fun onTermsResponse(accepted: Boolean) {
          Log.d(TAG, "T&C dialog response: accepted=$accepted")
          if (accepted) {
            termsAcceptedThisProcess = true
            writeTermsAcceptedPref(activity)
          }
          onResult(accepted)
        }
      },
    )
  }

  /** Start a navigation session. Initializes the Navigator on first call.
   *
   *  Suppresses the "Welcome to Google Maps Navigation" toast and the
   *  "Don't forget to pay attention" reminder dialog by accepting Terms
   *  & Conditions once via our own explicit dialog call, then reusing
   *  that acceptance (`SKIPPED`) for every subsequent `getNavigator`. */
  fun start(
    activity: Activity,
    options: StartOptions,
    callbacks: Callbacks,
  ) {
    Log.d(TAG, "start stops=${options.stops.size} mode=${options.mode} simulate=${options.simulate} speed=${options.speedMultiplier}")
    if (options.stops.isEmpty()) {
      callbacks.onError("at least one stop is required")
      return
    }
    // Fall back to showing the T&C dialog here if a miniapp didn't call
    // ensureTermsAccepted() up front. Once accepted, proceed straight
    // into navigator init.
    ensureTermsAccepted(activity) { accepted ->
      if (!accepted) {
        callbacks.onError("Navigation terms not accepted")
        return@ensureTermsAccepted
      }
      startNavigatorSkippingTerms(activity, options, callbacks)
    }
  }

  private fun startNavigatorSkippingTerms(
    activity: Activity,
    options: StartOptions,
    callbacks: Callbacks,
  ) {
    NavigationApi.getNavigator(
      activity,
      object : NavigationApi.NavigatorListener {
        override fun onNavigatorReady(nav: Navigator) {
          Log.d(TAG, "navigator ready")
          navigator = nav
          // Enable full SDK voice guidance (turn-by-turn announcements + alerts).
          try {
            nav.setAudioGuidance(Navigator.AudioGuidance.VOICE_ALERTS_AND_GUIDANCE)
          } catch (e: Throwable) {
            Log.w(TAG, "setAudioGuidance(VOICE_ALERTS_AND_GUIDANCE) failed", e)
          }
          attachListeners(nav, callbacks)
          attachLocationListener(activity, callbacks)
          registerNavInfoUpdates(activity, nav)
          setDestinationAndStart(nav, options, callbacks)
        }

        override fun onError(errorCode: Int) {
          val msg = errorCodeToString(errorCode)
          Log.e(TAG, "navigator init error: $msg")
          callbacks.onError(msg)
        }
      },
      TermsAndConditionsCheckOption.SKIPPED,
    )
  }

  /**
   * Dev-only: nudge the simulator off-route so we can verify the rerouting
   * pipeline end-to-end. Picks a small perpendicular offset (~`offsetMeters`)
   * from the user's current road-snapped position and teleports the
   * simulator there. The Nav SDK detects the user is off the polyline and
   * fires `onRerouting()`, which our existing listener already handles.
   *
   * Keep `offsetMeters` modest (15–25m) so the reroute is plausible — far
   * enough to leave the polyline tolerance, close enough that the rebuild
   * just patches the route rather than dragging the user across the city.
   */
  fun simulateDeviation(offsetMeters: Double = 20.0) {
    val nav = navigator ?: run {
      Log.w(TAG, "simulateDeviation: no navigator")
      return
    }
    if (lastFixLat.isNaN() || lastFixLng.isNaN()) {
      Log.w(TAG, "simulateDeviation: no last fix")
      return
    }
    val sim = nav.simulator ?: run {
      Log.w(TAG, "simulateDeviation: no simulator (real fixes only?)")
      return
    }

    // Pick a perpendicular bearing relative to the route's local direction
    // so the offset actually leaves the road, not slides along it.
    val flat = flattenRoute(nav)
    val routeBearing = if (flat != null && flat.size >= 2) {
      val (idx, _) = closestSegmentIndex(flat, lastFixLat, lastFixLng)
      val a = flat[idx]
      val b = flat[(idx + 1).coerceAtMost(flat.size - 1)]
      bearing(a.first, a.second, b.first, b.second)
    } else {
      0.0
    }
    val perpBearing = (routeBearing + 90.0) % 360.0

    val (offLat, offLng) = movePoint(lastFixLat, lastFixLng, offsetMeters, perpBearing)
    Log.d(TAG, "simulateDeviation: $lastFixLat,$lastFixLng → $offLat,$offLng (offset ${offsetMeters}m bearing ${perpBearing}°)")

    try {
      // ONLY teleport — do NOT call simulateLocationsAlongExistingRoute() here.
      // That method walks the *current* route from its start, which would
      // snap the user back to the trip origin. Instead, we let the SDK
      // notice we're off-route, fire onRouteChanged, and we restart the
      // simulator on the NEW route from the deviated position inside
      // routeChangedListener.
      sim.pause()
      sim.setUserLocation(com.google.android.gms.maps.model.LatLng(offLat, offLng))
    } catch (e: Throwable) {
      Log.e(TAG, "simulateDeviation failed", e)
    }
  }

  /** Project a point along a bearing in meters. */
  private fun movePoint(lat: Double, lng: Double, meters: Double, bearingDeg: Double): Pair<Double, Double> {
    val r = 6_371_000.0 // Earth radius m
    val brng = Math.toRadians(bearingDeg)
    val lat1 = Math.toRadians(lat)
    val lng1 = Math.toRadians(lng)
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

  fun stop() {
    Log.d(TAG, "stop")
    stopPolling()
    activeCallbacks = null
    lastEmittedKey = null
    simulating = false
    simulationSpeed = 1f
    navigator?.let { nav ->
      try {
        nav.simulator?.unsetUserLocation()
        nav.stopGuidance()
        nav.clearDestinations()
        detachListeners(nav)
        try {
          nav.unregisterServiceForNavUpdates()
        } catch (e: Throwable) {
          Log.w(TAG, "unregisterServiceForNavUpdates failed: ${e.message}")
        }
      } catch (e: Exception) {
        Log.e(TAG, "stop failed", e)
      }
    }
    NavInfoHolder.reset()
    lastSpeedMps = null
    offRouteFired = false
  }

  /**
   * Subscribe to NavInfo updates so we can pull road names off the
   * current/next StepInfo and surface them on each ManeuverPayload.
   * Best-effort — we still emit maneuvers even if the SDK never delivers
   * NavInfo (the road-name fields just stay null).
   */
  private fun registerNavInfoUpdates(activity: Activity, nav: Navigator) {
    try {
      val ok = nav.registerServiceForNavUpdates(
        activity.packageName,
        NavInfoReceiverService::class.java.name,
        /* numNextStepsToPreview = */ 1,
      )
      if (!ok) {
        Log.w(TAG, "registerServiceForNavUpdates returned false — road names unavailable")
      }
    } catch (e: Throwable) {
      Log.w(TAG, "registerServiceForNavUpdates failed: ${e.message}")
    }
  }

  private fun startPolling() {
    stopPolling()
    val handler = Handler(Looper.getMainLooper())
    pollHandler = handler
    pollRunnable = object : Runnable {
      override fun run() {
        val nav = navigator ?: return
        val cb = activeCallbacks ?: return
        emitCurrentManeuverIfChanged(nav, cb)
        handler.postDelayed(this, POLL_INTERVAL_MS)
      }
    }
    handler.post(pollRunnable!!)
  }

  private fun stopPolling() {
    pollRunnable?.let { pollHandler?.removeCallbacks(it) }
    pollRunnable = null
    pollHandler = null
  }

  private fun setDestinationAndStart(
    nav: Navigator,
    options: StartOptions,
    callbacks: Callbacks,
  ) {
    val waypoints = try {
      options.stops.mapIndexed { idx, (lat, lng) ->
        Waypoint.builder()
          .setLatLng(lat, lng)
          .setTitle(if (idx == options.stops.lastIndex) "Destination" else "Stop ${idx + 1}")
          .build()
      }
    } catch (e: Waypoint.UnsupportedPlaceIdException) {
      callbacks.onError("Unsupported destination: ${e.message}")
      return
    }

    val routingOptions = RoutingOptions()
      .travelMode(translateMode(options.mode))
      .avoidHighways(options.avoidHighways)
      .avoidTolls(options.avoidTolls)
      .avoidFerries(options.avoidFerries)

    activeCallbacks = callbacks
    val resultPending = if (waypoints.size == 1) {
      // Single-destination call path keeps using setDestination(), which is
      // the only API exposed by older SDK builds. Multi-stop trips upgrade
      // to setDestinations(...) below.
      nav.setDestination(waypoints[0], routingOptions)
    } else {
      nav.setDestinations(waypoints, routingOptions)
    }

    resultPending.setOnResultListener { status ->
      when (status) {
        Navigator.RouteStatus.OK -> {
          Log.d(TAG, "route OK, starting guidance")
          nav.startGuidance()
          simulating = options.simulate
          simulationSpeed = options.speedMultiplier.coerceIn(0.5f, 50f)
          if (options.simulate) {
            Log.d(TAG, "simulator engaged at ${simulationSpeed}x")
            nav.simulator?.simulateLocationsAlongExistingRoute(
              SimulationOptions().speedMultiplier(simulationSpeed),
            )
          }
          startPolling()
          emitCurrentManeuverIfChanged(nav, callbacks)
          emitRoute(nav, callbacks)
        }
        else -> {
          val msg = "route status: $status"
          Log.e(TAG, msg)
          callbacks.onError(msg)
        }
      }
    }
  }

  /**
   * Map the SDK-agnostic mode string to a Google Nav SDK TravelMode int
   * constant. The SDK's `TravelMode` is a holder class of `int` constants,
   * not an enum, so we read fields by name with reflection to stay
   * tolerant of SDK versions that don't ship every mode (e.g. CYCLING /
   * TWO_WHEELER). Falls back to DRIVING when the named constant is
   * missing so we never crash on a missing field.
   */
  private fun translateMode(mode: String): Int {
    val driving = readTravelModeConst("DRIVING") ?: 0
    return when (mode.lowercase()) {
      "walking" -> readTravelModeConst("WALKING") ?: driving
      "cycling" -> readTravelModeConst("CYCLING") ?: readTravelModeConst("WALKING") ?: driving
      "two_wheeler" -> readTravelModeConst("TWO_WHEELER") ?: driving
      else -> driving
    }
  }

  private fun readTravelModeConst(name: String): Int? {
    return try {
      val field = RoutingOptions.TravelMode::class.java.getField(name)
      (field.get(null) as? Number)?.toInt()
    } catch (_: Throwable) {
      null
    }
  }

  /**
   * Flatten every segment's decoded path into a single polyline and emit
   * it. Called on initial route + after any reroute.
   */
  private fun emitRoute(nav: Navigator, callbacks: Callbacks) {
    try {
      val segments = nav.routeSegments ?: return
      val points = mutableListOf<RoutePoint>()
      for (seg in segments) {
        val path = try {
          seg.latLngs
        } catch (_: Throwable) {
          null
        } ?: continue
        for (ll in path) {
          points.add(RoutePoint(ll.latitude, ll.longitude))
        }
      }
      if (points.isNotEmpty()) {
        Log.d(TAG, "emit route — ${points.size} points")
        callbacks.onRoute(points)
      } else {
        Log.w(TAG, "route segments empty, nothing to emit")
      }
    } catch (e: Exception) {
      Log.e(TAG, "emitRoute failed", e)
    }
  }

  private fun attachListeners(nav: Navigator, callbacks: Callbacks) {
    arrivalListener = Navigator.ArrivalListener { _: ArrivalEvent ->
      Log.d(TAG, "arrived")
      callbacks.onArrived()
    }
    routeChangedListener = Navigator.RouteChangedListener {
      Log.d(TAG, "route changed — emitting next maneuver + new route")
      callbacks.onRerouting()
      lastEmittedKey = null // force re-emit after reroute
      // Now that the route has been rebuilt, the user is on-route again.
      offRouteFired = false
      // If we're in simulate mode, the simulator was paused (either
      // organically by the off-route detection, or explicitly by
      // simulateDeviation). Restart it on the new route so the user keeps
      // "walking" without having to do anything.
      if (simulating) {
        try {
          nav.simulator?.simulateLocationsAlongExistingRoute(
            SimulationOptions().speedMultiplier(simulationSpeed),
          )
        } catch (e: Throwable) {
          Log.w(TAG, "failed to restart simulator after reroute: ${e.message}")
        }
      }
      emitCurrentManeuverIfChanged(nav, callbacks)
      emitRoute(nav, callbacks)
    }
    nav.addArrivalListener(arrivalListener)
    nav.addRouteChangedListener(routeChangedListener)
  }

  private fun detachListeners(nav: Navigator) {
    arrivalListener?.let { nav.removeArrivalListener(it) }
    routeChangedListener?.let { nav.removeRouteChangedListener(it) }
    arrivalListener = null
    routeChangedListener = null

    // Road-snapped location provider
    val provider = roadSnappedProvider
    val listener = roadSnappedListener
    if (provider != null && listener != null) {
      try {
        provider.removeLocationListener(listener)
      } catch (e: Exception) {
        Log.e(TAG, "removeLocationListener failed", e)
      }
    }
    roadSnappedProvider = null
    roadSnappedListener = null
  }

  private fun attachLocationListener(activity: Activity, callbacks: Callbacks) {
    try {
      val provider = NavigationApi.getRoadSnappedLocationProvider(activity.application)
      if (provider == null) {
        Log.w(TAG, "road-snapped provider unavailable")
        return
      }
      val listener = RoadSnappedLocationProvider.LocationListener { loc: Location ->
        lastFixLat = loc.latitude
        lastFixLng = loc.longitude
        lastSpeedMps = if (loc.hasSpeed()) loc.speed else null
        callbacks.onLocation(
          LocationPayload(
            lat = loc.latitude,
            lng = loc.longitude,
            accuracy = if (loc.hasAccuracy()) loc.accuracy else null,
            timestamp = loc.time,
          ),
        )
        // Off-route detection. We compute perpendicular distance to the
        // active polyline and fire onOffRoute once when it crosses the
        // threshold. The Nav SDK's reroute pipeline kicks in shortly
        // after; the routeChangedListener clears `offRouteFired` so the
        // next deviation can fire again.
        val nav = navigator
        if (nav != null && !offRouteFired) {
          val flat = flattenRoute(nav)
          if (flat != null && flat.size >= 2) {
            val (_, perp) = closestSegmentIndex(flat, loc.latitude, loc.longitude)
            if (perp > OFF_ROUTE_THRESHOLD_M) {
              offRouteFired = true
              callbacks.onOffRoute(perp)
            }
          }
        }
      }
      provider.addLocationListener(listener)
      roadSnappedProvider = provider
      roadSnappedListener = listener
    } catch (e: Exception) {
      Log.e(TAG, "attachLocationListener failed", e)
    }
  }

  private fun emitCurrentManeuverIfChanged(nav: Navigator, callbacks: Callbacks) {
    val payload = buildManeuverPayload(nav)
    if (payload == null) {
      Log.d(TAG, "emit skipped — no route data yet")
      return
    }
    // Bucket distance into 5 m steps so we don't spam JS with a new event
    // for every meter of movement. Also bucket the trip-total distance so
    // the countdown advances smoothly even when the upcoming-maneuver
    // bucket hasn't moved (long straight stretches).
    val distBucket = if (payload.distanceMeters >= 0) payload.distanceMeters / 5 else -1
    val tripBucket = if (payload.distanceToDestinationMeters >= 0) payload.distanceToDestinationMeters / 10 else -1
    val key = "${payload.maneuverType}|$distBucket|$tripBucket"
    if (key == lastEmittedKey) return
    lastEmittedKey = key
    Log.d(TAG, "emit → ${payload.maneuverType} in ${payload.distanceMeters}m (trip ${payload.distanceToDestinationMeters}m)")
    callbacks.onManeuver(payload)
  }

  /**
   * Find the next "real" maneuver in the route polyline.
   *
   * Walking polylines from Google contain many small zigzag artifacts —
   * sidewalk jogs, curve approximations, curb encodings — that look like
   * "turns" if you read them point-by-point. Naively reporting any
   * 30° bend produces flapping callouts every meter or two near every
   * intersection. We use three techniques together to give one stable
   * callout per actual intersection:
   *
   *   1. DEADZONE: skip the first DEADZONE_METERS of path ahead of the
   *      user before scanning. The polyline is noisiest right where
   *      the user is standing (especially right after completing a
   *      turn — curb geometry, etc.). Hiding that zone eliminates the
   *      "TURN_RIGHT 4m → TURN_LEFT 5m → ..." flapping while keeping
   *      the live distance countdown to the *real* next turn intact.
   *
   *   2. ACCUMULATION WINDOW: past the deadzone, walk forward
   *      integrating bearing changes. A turn fires at the *anchor*
   *      (start of the window) when the net heading change exceeds
   *      NET_TURN_DEG within WINDOW_METERS of path. Zigzags whose
   *      deltas cancel out within the window are silently ignored.
   *
   *   3. ANCHOR SLIDING: if the window expires without firing, slide
   *      the anchor forward and keep looking. So a long curving path
   *      with no real turn won't accidentally accumulate enough drift
   *      to fire.
   *
   * No "single-step hard turn" fast path — at intersections the
   * polyline often has 90°+ artifacts that we DON'T want to fire on.
   * The window's net-delta threshold catches real intersections by
   * itself (they produce >30° net change anyway).
   *
   * If no real turn remains in the route, emit ARRIVE.
   */
  private fun buildManeuverPayload(nav: Navigator): ManeuverPayload? {
    if (lastFixLat.isNaN() || lastFixLng.isNaN()) return null
    val flat = flattenRoute(nav) ?: return null
    if (flat.size < 2) return null

    // Best-effort signals from the Nav SDK's NavInfo updates. May be
    // null on routes/regions where the SDK doesn't supply them, or
    // before the first NavInfo arrives at trip start.
    //
    // CRITICAL: When NavInfo is available, type/distance/roads MUST be read
    // as a coherent set — they all describe the same step. Mixing the
    // SDK's type/roads with our bearing-derived distance produces nonsense
    // (e.g. "TURN_LEFT to Octavia in 17m" when the 17m is actually the
    // distance to the previous TURN_RIGHT onto Hayes). Prefer the SDK's
    // distance whenever we have it; only fall back to bearing-derived when
    // the SDK hasn't given us one yet.
    val fromRoad = NavInfoHolder.currentRoad
    val toRoad = NavInfoHolder.nextRoad
    val nextStepRoad = NavInfoHolder.nextStepRoad
    val sdkManeuver = NavInfoHolder.sdkManeuverType
    val sdkDistance = NavInfoHolder.distanceToCurrentStepMeters

    // Trip totals + speed are independent of the per-step maneuver selection,
    // so compute them once up front and stamp every payload below with the
    // same set. Negative trip totals stay negative on the wire — JS treats
    // -1 as "unknown" and renders accordingly.
    val distToDest = NavInfoHolder.distanceToFinalDestinationMeters ?: -1
    val timeToDest = NavInfoHolder.timeToFinalDestinationSeconds ?: -1
    val speedMps = lastSpeedMps

    if (sdkManeuver != null && sdkDistance != null && sdkDistance >= 0) {
      return ManeuverPayload(
        maneuverType = sdkManeuver,
        distanceMeters = sdkDistance,
        fromRoad = fromRoad,
        toRoad = toRoad,
        nextStepRoad = nextStepRoad,
        distanceToDestinationMeters = distToDest,
        timeToDestinationSeconds = timeToDest,
        currentSpeedMps = speedMps,
      )
    }

    val (startIdx, distToRoute) = closestSegmentIndex(flat, lastFixLat, lastFixLng)
    if (distToRoute > 50.0) {
      return ManeuverPayload(
        maneuverType = sdkManeuver ?: "STRAIGHT",
        distanceMeters = -1,
        fromRoad = fromRoad,
        toRoad = toRoad,
        nextStepRoad = nextStepRoad,
        distanceToDestinationMeters = distToDest,
        timeToDestinationSeconds = timeToDest,
        currentSpeedMps = speedMps,
      )
    }
    // Bearing of the closest segment, surfaced as routeHeadingDeg on the
    // payload so consumers can rotate map cones without recomputing it.
    val routeHeadingFloat: Float? = run {
      val a = flat[startIdx]
      val b = flat[(startIdx + 1).coerceAtMost(flat.size - 1)]
      bearing(a.first, a.second, b.first, b.second).toFloat()
    }

    val netTurnDeg = 30.0
    val windowMeters = 40.0
    val deadzoneMeters = 15.0

    // Path distance from the user to the start of segment `i`.
    var distFromUser = haversine(lastFixLat, lastFixLng, flat[startIdx].first, flat[startIdx].second)

    var anchorBearing: Double? = null
    var anchorDistFromUser = distFromUser

    var i = startIdx
    while (i < flat.size - 1) {
      val segBearing = bearing(
        flat[i].first, flat[i].second,
        flat[i + 1].first, flat[i + 1].second,
      )

      // Only start scanning for turns once we're past the deadzone.
      // Inside the deadzone we still walk the polyline forward (so
      // distFromUser keeps incrementing correctly) but ignore bearings.
      if (distFromUser >= deadzoneMeters) {
        if (anchorBearing == null) {
          anchorBearing = segBearing
          anchorDistFromUser = distFromUser
        } else {
          val netDelta = signedAngleDiff(segBearing, anchorBearing)
          if (kotlin.math.abs(netDelta) > netTurnDeg) {
            // Distance is from our bearing scanner (accurate to the bend).
            // Maneuver type prefers the SDK's authoritative StepInfo value
            // since the bearing-derived classification flickers as the
            // simulator wiggles. Fall back to bearing-derived only when
            // the SDK hasn't supplied one yet.
            return ManeuverPayload(
              maneuverType = sdkManeuver ?: classifyTurn(netDelta),
              distanceMeters = anchorDistFromUser.toInt(),
              fromRoad = fromRoad,
              toRoad = toRoad,
              nextStepRoad = nextStepRoad,
              distanceToDestinationMeters = distToDest,
              timeToDestinationSeconds = timeToDest,
              currentSpeedMps = speedMps,
              routeHeadingDeg = routeHeadingFloat,
            )
          }
          if (distFromUser - anchorDistFromUser > windowMeters) {
            anchorBearing = segBearing
            anchorDistFromUser = distFromUser
          }
        }
      }

      distFromUser += haversine(
        flat[i].first, flat[i].second,
        flat[i + 1].first, flat[i + 1].second,
      )
      i++
    }

    return ManeuverPayload(
      maneuverType = sdkManeuver ?: "ARRIVE",
      distanceMeters = distFromUser.toInt(),
      fromRoad = fromRoad,
      toRoad = toRoad,
      nextStepRoad = nextStepRoad,
      distanceToDestinationMeters = distToDest,
      timeToDestinationSeconds = timeToDest,
      currentSpeedMps = speedMps,
      routeHeadingDeg = routeHeadingFloat,
    )
  }

  /** Flatten the full route into a list of (lat, lng) points. */
  private fun flattenRoute(nav: Navigator): List<Pair<Double, Double>>? {
    val segments = try {
      nav.routeSegments
    } catch (_: Throwable) {
      null
    } ?: return null
    val out = ArrayList<Pair<Double, Double>>()
    for (seg in segments) {
      val path = try {
        seg.latLngs
      } catch (_: Throwable) {
        null
      } ?: continue
      for (ll in path) out.add(Pair(ll.latitude, ll.longitude))
    }
    return out.takeIf { it.isNotEmpty() }
  }

  /** Returns (segmentStartIndex, perpDistance) — closest segment to (lat, lng). */
  private fun closestSegmentIndex(
    pts: List<Pair<Double, Double>>,
    lat: Double,
    lng: Double,
  ): Pair<Int, Double> {
    var bestIdx = 0
    var bestDist = Double.POSITIVE_INFINITY
    for (i in 0 until pts.size - 1) {
      val d = perpDistanceMeters(
        lat, lng,
        pts[i].first, pts[i].second,
        pts[i + 1].first, pts[i + 1].second,
      )
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }
    return Pair(bestIdx, bestDist)
  }

  /** Map signed angle delta (degrees, [-180, 180]) to a categorical turn. */
  private fun classifyTurn(deltaDeg: Double): String {
    val abs = kotlin.math.abs(deltaDeg)
    val left = deltaDeg < 0
    return when {
      abs < 30.0 -> "STRAIGHT"
      abs < 60.0 -> if (left) "SLIGHT_LEFT" else "SLIGHT_RIGHT"
      abs < 120.0 -> if (left) "TURN_LEFT" else "TURN_RIGHT"
      abs < 150.0 -> if (left) "SHARP_LEFT" else "SHARP_RIGHT"
      else -> "U_TURN"
    }
  }

  // ---- math helpers ----

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
    val φ1 = Math.toRadians(lat1)
    val φ2 = Math.toRadians(lat2)
    val λ1 = Math.toRadians(lng1)
    val λ2 = Math.toRadians(lng2)
    val y = kotlin.math.sin(λ2 - λ1) * kotlin.math.cos(φ2)
    val x = kotlin.math.cos(φ1) * kotlin.math.sin(φ2) -
      kotlin.math.sin(φ1) * kotlin.math.cos(φ2) * kotlin.math.cos(λ2 - λ1)
    val deg = Math.toDegrees(kotlin.math.atan2(y, x))
    return (deg + 360.0) % 360.0
  }

  /** Smallest signed angular difference: target - actual, in [-180, 180]. */
  private fun signedAngleDiff(target: Double, actual: Double): Double {
    return ((target - actual + 540.0) % 360.0) - 180.0
  }

  /** Perpendicular distance from p to segment a→b in meters (small-angle). */
  private fun perpDistanceMeters(
    pLat: Double, pLng: Double,
    aLat: Double, aLng: Double,
    bLat: Double, bLng: Double,
  ): Double {
    val mPerDegLat = 111_320.0
    val mPerDegLng = 111_320.0 * kotlin.math.cos(Math.toRadians(aLat))
    val px = (pLng - aLng) * mPerDegLng
    val py = (pLat - aLat) * mPerDegLat
    val bx = (bLng - aLng) * mPerDegLng
    val by = (bLat - aLat) * mPerDegLat
    val len2 = bx * bx + by * by
    if (len2 == 0.0) return kotlin.math.sqrt(px * px + py * py)
    var t = (px * bx + py * by) / len2
    t = t.coerceIn(0.0, 1.0)
    val projx = t * bx
    val projy = t * by
    return kotlin.math.sqrt((px - projx).let { it * it } + (py - projy).let { it * it })
  }


  private fun errorCodeToString(code: Int): String = when (code) {
    NavigationApi.ErrorCode.NOT_AUTHORIZED ->
      "NOT_AUTHORIZED — API key missing/invalid or Navigation SDK not enabled in GCP"
    NavigationApi.ErrorCode.TERMS_NOT_ACCEPTED -> "TERMS_NOT_ACCEPTED — user did not accept T&C"
    NavigationApi.ErrorCode.NETWORK_ERROR -> "NETWORK_ERROR"
    NavigationApi.ErrorCode.LOCATION_PERMISSION_MISSING -> "LOCATION_PERMISSION_MISSING"
    else -> "UNKNOWN_ERROR ($code)"
  }
}
