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
  /**
   * The sample BEFORE lastFix. Used by the Deviate dev button to
   * derive the user's actual direction of travel (prev → last) so the
   * straight-walk uses *their* bearing, not the route's local bearing.
   */
  private var prevFixLat: Double = Double.NaN
  private var prevFixLng: Double = Double.NaN
  /** Most recent speed in m/s, off the road-snapped Location. Null until first sample. */
  private var lastSpeedMps: Float? = null
  /** Set true once we cross the off-route threshold; cleared by the route-changed listener. */
  private var offRouteFired: Boolean = false
  /** Distance threshold (meters) at which we declare the user has left the route. */
  private val OFF_ROUTE_THRESHOLD_M = 30.0
  /**
   * Dev toggle: when true, every emitted location is shifted ~8m to the
   * right of the local route bearing before being reported. Simulates a
   * pedestrian walking on the wrong sidewalk so we can verify the
   * along-path pivot trigger fires even when they're never within the
   * 7m point radius of a pivot. Only meaningful in simulate mode; on a
   * real fix the road-snapped provider would just snap us back.
   */
  private var wrongSidewalkOffsetEnabled: Boolean = false
  private val WRONG_SIDEWALK_OFFSET_M = 8.0

  /**
   * Dev toggle: when true, takes over from the Google Nav SDK's
   * simulator and walks the user along a *modified* polyline that omits
   * crossing micro-steps. So when the route says "cross the road, then
   * turn right", the simulator pretends the user kept walking straight
   * on the same sidewalk — letting us reproduce the wrong-sidewalk-then-
   * missed-the-turn scenario. Only takes effect with simulate=true.
   */
  private var skipCrossingsEnabled: Boolean = false
  /** Monotonic timer driving our custom walker when skip-crossings is on. */
  private var skipCrossingsTimer: java.util.Timer? = null
  /** Per-tick step length in meters at simulationSpeed=1x; scaled by speed. */
  private val SKIP_CROSSINGS_BASE_M_PER_TICK = 0.56
  /** Walker tick interval. ~2.5Hz feels smooth and matches a stroll cadence. */
  private val SKIP_CROSSINGS_TICK_MS = 400L
  /** Polyline segment short enough to be considered a crosswalk leg. */
  private val CROSSING_MAX_LEG_METERS = 25.0
  /** Bearing change vs adjacent segments that flags a leg as a crosswalk. */
  private val CROSSING_MIN_BEND_DEG = 60.0

  /**
   * Timer driving the Deviate dev button's "walk straight for 10s"
   * behavior. We pause Google's simulator, feed setUserLocation()
   * waypoints along the user's current direction of travel, then
   * freeze when the duration elapses.
   */
  private var deviateTimer: java.util.Timer? = null
  /** How long the Deviate dev button keeps walking the user straight. */
  private val DEVIATE_DURATION_S = 10.0
  /** Walker tick interval (s); matches the skip-crossings walker. */
  private val DEVIATE_TICK_MS = 400L
  /** Baseline walking speed in m/s; scaled by simulationSpeed at tick time. */
  private val DEVIATE_BASE_MPS = 1.4
  /**
   * Cached StartOptions from the active trip. Used by the deviate
   * reroute to re-issue setDestination(s) with the same final stop +
   * routing prefs from the walker's current position.
   */
  private var activeOptions: StartOptions? = null
  /**
   * True while the Deviate walker owns the simulator. The road-snapped
   * location listener checks this flag and short-circuits — otherwise
   * Google's provider keeps snapping incoming locations back onto the
   * route polyline and the dot visibly jumps between the deviated
   * position (from our tick) and the snapped-back one.
   */
  private var deviateWalkerActive: Boolean = false
  /**
   * Perpendicular distance from the planned route (m) at which the
   * deviate walker considers the user truly off-route. Crossing this
   * threshold fires `off_route`, re-issues setDestinations from the
   * walker's current position to force a reroute, and cancels the
   * walk — the new route's first pivot is now ahead of them.
   *
   * Smaller than OFF_ROUTE_THRESHOLD_M (30m) on purpose — for the
   * dev button we want the reroute to kick in quickly during testing
   * rather than waiting for the user to drift further.
   */
  private val DEVIATE_OFF_ROUTE_TRIGGER_M = 12.0

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

  /**
   * One step along the active route — used by the SDK's pivot module
   * to enrich pivots with `fromRoad` / `toRoad` metadata. Lat/lng is
   * the step's START coordinate; the matching is by proximity to the
   * polyline, not exact index.
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
          // Audio guidance is suppressed — the glasses deliver
          // turn-by-turn instructions visually, so the phone playing its
          // own "in 50 feet, turn right" audio is redundant.
          try {
            nav.setAudioGuidance(Navigator.AudioGuidance.SILENT)
          } catch (e: Throwable) {
            Log.w(TAG, "setAudioGuidance(SILENT) failed", e)
          }
          // Suppress the SDK's built-in "off course, recalibrating"
          // and similar heads-up banner / toast notifications. Our UI
          // surfaces those events through `onRerouting`/`onOffRoute`
          // and renders them on the glasses, so the phone-side popup
          // is duplicate noise.
          try {
            nav.setHeadsUpNotificationEnabled(false)
          } catch (e: Throwable) {
            Log.w(TAG, "setHeadsUpNotificationEnabled(false) failed", e)
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
   * Dev-only. Pauses Google's simulator and walks the user STRAIGHT
   * FORWARD in their current direction of travel for DEVIATE_DURATION_S
   * seconds, then freezes the simulator. The bearing is derived from
   * prevFix → lastFix — *their* direction of travel, not the route's
   * local bearing — so this reproduces "user ignored the route and
   * kept walking the way they were going". After the window elapses,
   * everything stops. `offsetMeters` is ignored (kept for legacy
   * protocol back-compat).
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
    // Bearing source: derive from prev → last so we use the user's
    // *actual* direction of travel. Need a non-degenerate distance
    // between samples (>0.5m) to avoid using noise as bearing.
    val travelBearing: Double = if (
      !prevFixLat.isNaN() && !prevFixLng.isNaN() &&
      haversine(prevFixLat, prevFixLng, lastFixLat, lastFixLng) > 0.5
    ) {
      bearing(prevFixLat, prevFixLng, lastFixLat, lastFixLng)
    } else {
      // No usable prev sample — bail. We refuse to guess a direction.
      Log.w(TAG, "simulateDeviation: no recent movement to infer bearing — ignoring")
      return
    }

    // Cancel any existing walker, take over the simulator.
    deviateTimer?.cancel()
    deviateTimer = null
    try { sim.pause() } catch (_: Throwable) {}
    // Gate the road-snapped listener so it stops fighting us by
    // snapping incoming positions back onto the polyline. Cleared
    // when the walker stops (either timer end or off-route trigger).
    deviateWalkerActive = true

    val stepMeters = (DEVIATE_BASE_MPS * simulationSpeed * (DEVIATE_TICK_MS / 1000.0)).coerceAtLeast(0.1)
    val totalTicks = (DEVIATE_DURATION_S / (DEVIATE_TICK_MS / 1000.0)).toInt().coerceAtLeast(1)
    Log.d(
      TAG,
      "simulateDeviation: walk straight for ${DEVIATE_DURATION_S}s @ ${simulationSpeed}× — bearing=$travelBearing°, step=${stepMeters}m, ticks=$totalTicks",
    )
    @Suppress("UNUSED_VARIABLE") val _legacyOffset = offsetMeters // protocol back-compat; unused

    var cursorLat = lastFixLat
    var cursorLng = lastFixLng
    var ticksRemaining = totalTicks
    // Run SDK calls on the main looper; setUserLocation from a
    // background thread silently fails after the first call on some
    // SDK builds, which would make the dot teleport once and stop.
    val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
    val timer = java.util.Timer("deviateWalker", true)
    timer.scheduleAtFixedRate(object : java.util.TimerTask() {
      override fun run() {
        mainHandler.post {
          try {
            if (ticksRemaining <= 0) {
              cancel()
              deviateTimer = null
              deviateWalkerActive = false
              // Freeze the simulator. No handoff to Google sim — the
              // user wanted everything to stop after the 10s window.
              try { navigator?.simulator?.pause() } catch (_: Throwable) {}
              Log.d(TAG, "simulateDeviation: done; simulator frozen")
              return@post
            }
            val (nLat, nLng) = movePoint(cursorLat, cursorLng, stepMeters, travelBearing)
            cursorLat = nLat
            cursorLng = nLng
            navigator?.simulator?.setUserLocation(
              com.google.android.gms.maps.model.LatLng(cursorLat, cursorLng),
            )
            // Also forward the synthetic position directly to JS in
            // case the road-snapped provider isn't pumping locations
            // while the Google sim is paused. Mirrors the same payload
            // shape the location listener emits.
            activeCallbacks?.onLocation(
              LocationPayload(
                lat = cursorLat,
                lng = cursorLng,
                accuracy = null,
                timestamp = System.currentTimeMillis(),
              ),
            )
            // Slide the prev/last window forward so a follow-up
            // Deviate press can still infer a bearing while we walk.
            prevFixLat = lastFixLat
            prevFixLng = lastFixLng
            lastFixLat = cursorLat
            lastFixLng = cursorLng
            ticksRemaining--

            // Off-route trigger. Once we've drifted more than
            // DEVIATE_OFF_ROUTE_TRIGGER_M from the planned polyline,
            // fire off_route, force the Nav SDK to replan from here,
            // and stop the deviate walk — the user is now on a fresh
            // route whose first pivot is ahead of them.
            val nav = navigator
            if (nav != null && !offRouteFired) {
              val flatNow = flattenRoute(nav)
              if (flatNow != null && flatNow.size >= 2) {
                val (_, perp) = closestSegmentIndex(flatNow, cursorLat, cursorLng)
                if (perp > DEVIATE_OFF_ROUTE_TRIGGER_M) {
                  Log.d(TAG, "deviate: off-route at ${perp}m — triggering reroute")
                  offRouteFired = true
                  activeCallbacks?.onOffRoute(perp)
                  triggerDeviateReroute(nav, cursorLat, cursorLng)
                  cancel()
                  deviateTimer = null
                  deviateWalkerActive = false
                  return@post
                }
              }
            }
          } catch (e: Throwable) {
            Log.e(TAG, "simulateDeviation tick failed", e)
          }
        }
      }
    }, 0L, DEVIATE_TICK_MS)
    deviateTimer = timer
  }

  /**
   * Force the Nav SDK to plan a fresh route to the trip's final stop
   * from the deviate walker's current position. The SDK treats this as
   * a route recompute and fires routeChangedListener, which our
   * existing handler routes through onRerouting/emitRoute to JS.
   */
  private fun triggerDeviateReroute(nav: Navigator, fromLat: Double, fromLng: Double) {
    val options = activeOptions ?: run {
      Log.w(TAG, "triggerDeviateReroute: no active options cached")
      return
    }
    if (options.stops.isEmpty()) return
    // Seed the navigator's "current position" with the walker's
    // position so its replanner starts from where we are. Without
    // this the new route would still anchor at the last road-snapped
    // fix Google saw (which may be where the user was before we
    // paused its simulator).
    try {
      nav.simulator?.setUserLocation(
        com.google.android.gms.maps.model.LatLng(fromLat, fromLng),
      )
    } catch (_: Throwable) {}
    val waypoints = try {
      options.stops.mapIndexed { idx, (lat, lng) ->
        Waypoint.builder()
          .setLatLng(lat, lng)
          .setTitle(if (idx == options.stops.lastIndex) "Destination" else "Stop ${idx + 1}")
          .build()
      }
    } catch (e: Waypoint.UnsupportedPlaceIdException) {
      Log.w(TAG, "triggerDeviateReroute: bad waypoint: ${e.message}")
      return
    }
    val routingOptions = RoutingOptions()
      .travelMode(translateMode(options.mode))
      .avoidHighways(options.avoidHighways)
      .avoidTolls(options.avoidTolls)
      .avoidFerries(options.avoidFerries)
    try {
      if (waypoints.size == 1) {
        nav.setDestination(waypoints[0], routingOptions)
      } else {
        nav.setDestinations(waypoints, routingOptions)
      }
      Log.d(TAG, "triggerDeviateReroute: replanning from $fromLat,$fromLng")
    } catch (e: Throwable) {
      Log.e(TAG, "triggerDeviateReroute failed", e)
    }
  }

  /**
   * Dev toggle. When enabled, every emitted location is shifted ~8m
   * perpendicular-right of the route bearing before being reported to
   * JS, simulating a pedestrian walking on the wrong sidewalk. Lets us
   * verify the SDK's along-path pivot trigger fires even when the user
   * never comes within the 7m point radius of a pivot.
   */
  fun setWrongSidewalkOffset(enabled: Boolean) {
    Log.d(TAG, "setWrongSidewalkOffset($enabled)")
    wrongSidewalkOffsetEnabled = enabled
  }

  /**
   * Dev toggle. Enable/disable the "skip crossings" custom walker. When
   * enabled mid-trip, we pause Google's simulator and take over with
   * our own timer that feeds setUserLocation() waypoints along a
   * polyline with crossing micro-steps removed. When disabled, we stop
   * our walker and (if a trip is in progress) hand control back to the
   * Google simulator from the user's current position.
   */
  fun setSkipCrossings(enabled: Boolean) {
    Log.d(TAG, "setSkipCrossings($enabled)")
    skipCrossingsEnabled = enabled
    if (enabled) {
      startSkipCrossingsWalker()
    } else {
      stopSkipCrossingsWalker(resumeGoogleSim = true)
    }
  }

  /**
   * Build the modified polyline for the active route (with crossing
   * micro-steps replaced by straight-line projections) and start a
   * timer that walks it. If a previous walker is running we cancel it
   * first. Safe to call when no route is active — does nothing.
   */
  private fun startSkipCrossingsWalker() {
    val nav = navigator ?: run {
      Log.w(TAG, "startSkipCrossingsWalker: no navigator")
      return
    }
    val flat = flattenRoute(nav)
    if (flat == null || flat.size < 2) {
      Log.w(TAG, "startSkipCrossingsWalker: no route polyline")
      return
    }
    // Take over from Google's simulator so we don't fight over positions.
    try {
      nav.simulator?.pause()
    } catch (e: Throwable) {
      Log.w(TAG, "couldn't pause Google simulator: ${e.message}")
    }
    val modified = stripCrossings(flat)
    Log.d(TAG, "skip-crossings walker: original=${flat.size} pts, modified=${modified.size} pts")
    stopSkipCrossingsWalker(resumeGoogleSim = false)
    // Find the closest modified-polyline index to the user's last known
    // position so we resume from where they are instead of teleporting
    // back to the route start.
    val startIdx = if (!lastFixLat.isNaN() && !lastFixLng.isNaN()) {
      closestPolylineIndex(modified, lastFixLat, lastFixLng)
    } else {
      0
    }
    val timer = java.util.Timer("skipCrossingsWalker", true)
    val stepMeters = SKIP_CROSSINGS_BASE_M_PER_TICK * simulationSpeed
    var cursor = startIdx.toDouble() // float index along `modified`
    timer.scheduleAtFixedRate(object : java.util.TimerTask() {
      override fun run() {
        try {
          if (!skipCrossingsEnabled) {
            cancel()
            return
          }
          val advanced = advanceCursor(modified, cursor, stepMeters)
          cursor = advanced
          if (cursor >= modified.size - 1) {
            // Reached end of the modified polyline. Let the SDK handle
            // arrival via its own detection; just stop ticking.
            cancel()
            return
          }
          val (lat, lng) = pointAt(modified, cursor)
          val sim = navigator?.simulator
          if (sim != null) {
            sim.setUserLocation(com.google.android.gms.maps.model.LatLng(lat, lng))
          }
        } catch (e: Throwable) {
          Log.e(TAG, "skip-crossings walker tick failed", e)
        }
      }
    }, 0L, SKIP_CROSSINGS_TICK_MS)
    skipCrossingsTimer = timer
  }

  private fun stopSkipCrossingsWalker(resumeGoogleSim: Boolean) {
    skipCrossingsTimer?.cancel()
    skipCrossingsTimer = null
    if (resumeGoogleSim && simulating) {
      try {
        navigator?.simulator?.simulateLocationsAlongExistingRoute(
          SimulationOptions().speedMultiplier(simulationSpeed),
        )
      } catch (e: Throwable) {
        Log.w(TAG, "couldn't resume Google simulator: ${e.message}")
      }
    }
  }

  /**
   * Return a modified polyline with crossing micro-steps replaced by a
   * straight-line projection from the pre-crossing direction. A
   * crossing is detected when a short (<CROSSING_MAX_LEG_METERS) leg
   * turns sharply (>CROSSING_MIN_BEND_DEG) from the previous leg AND
   * the leg after it turns sharply back. We then drop those crossing
   * legs and project the user's pre-crossing direction forward by the
   * total crossing length, so the modified polyline keeps the same
   * along-path length as the original — letting Google's distance/eta
   * math stay roughly consistent.
   */
  private fun stripCrossings(points: List<Pair<Double, Double>>): List<Pair<Double, Double>> {
    if (points.size < 4) return points
    val out = ArrayList<Pair<Double, Double>>(points.size)
    out.add(points[0])
    var i = 1
    while (i < points.size - 1) {
      val prev = points[i - 1]
      val here = points[i]
      val next = points[i + 1]
      val legIn = haversine(prev.first, prev.second, here.first, here.second)
      val legOut = haversine(here.first, here.second, next.first, next.second)
      val bearIn = bearing(prev.first, prev.second, here.first, here.second)
      val bearOut = bearing(here.first, here.second, next.first, next.second)
      val bend = bearingDiffAbs(bearIn, bearOut)
      // A crossing's first leg is short and turns sharply.
      val looksLikeCrossingStart = legOut < CROSSING_MAX_LEG_METERS && bend > CROSSING_MIN_BEND_DEG
      if (looksLikeCrossingStart && i + 2 < points.size) {
        val afterNext = points[i + 2]
        val bearAfter = bearing(next.first, next.second, afterNext.first, afterNext.second)
        val bendBack = bearingDiffAbs(bearOut, bearAfter)
        // …and turns sharply back to roughly the original direction.
        val isCrossing = bendBack > CROSSING_MIN_BEND_DEG &&
          bearingDiffAbs(bearIn, bearAfter) < CROSSING_MIN_BEND_DEG
        if (isCrossing) {
          // Skip the crossing: project forward along bearIn by the
          // total crossing length (legOut + legAfter) so we don't
          // shorten the path.
          val legAfter = haversine(next.first, next.second, afterNext.first, afterNext.second)
          val skipDist = legOut + legAfter
          val (newLat, newLng) = movePoint(here.first, here.second, skipDist, bearIn)
          out.add(Pair(newLat, newLng))
          i += 3 // skip `next` and `afterNext`
          continue
        }
      }
      out.add(here)
      i++
    }
    // Always include the final point so the route still ends at the destination.
    if (out.last() != points.last()) out.add(points.last())
    return out
  }

  /** Absolute smallest bearing difference, in degrees [0, 180]. */
  private fun bearingDiffAbs(a: Double, b: Double): Double {
    val d = (a - b + 540.0) % 360.0 - 180.0
    return kotlin.math.abs(d)
  }

  /** Closest polyline vertex to (lat, lng) by squared lat/lng distance. */
  private fun closestPolylineIndex(points: List<Pair<Double, Double>>, lat: Double, lng: Double): Int {
    var best = 0
    var bestD = Double.MAX_VALUE
    for (i in points.indices) {
      val (plat, plng) = points[i]
      val dx = plat - lat
      val dy = plng - lng
      val d = dx * dx + dy * dy
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }

  /**
   * Advance a float-index cursor along the polyline by `meters`,
   * crossing vertex boundaries as needed. Returns the new cursor
   * value. Clamped to the polyline length.
   */
  private fun advanceCursor(points: List<Pair<Double, Double>>, cursor: Double, meters: Double): Double {
    if (points.size < 2) return cursor.coerceAtMost(0.0)
    var idx = cursor.toInt()
    var frac = cursor - idx
    var remaining = meters
    while (remaining > 0 && idx < points.size - 1) {
      val a = points[idx]
      val b = points[idx + 1]
      val segLen = haversine(a.first, a.second, b.first, b.second)
      val segLeft = (1.0 - frac) * segLen
      if (remaining < segLeft) {
        frac += remaining / segLen
        remaining = 0.0
      } else {
        remaining -= segLeft
        idx++
        frac = 0.0
      }
    }
    return idx.toDouble() + frac
  }

  /** Interpolated (lat, lng) at a float index along the polyline. */
  private fun pointAt(points: List<Pair<Double, Double>>, cursor: Double): Pair<Double, Double> {
    val idx = cursor.toInt().coerceIn(0, points.size - 1)
    val frac = (cursor - idx).coerceIn(0.0, 1.0)
    if (idx >= points.size - 1) return points.last()
    val a = points[idx]
    val b = points[idx + 1]
    return Pair(a.first + (b.first - a.first) * frac, a.second + (b.second - a.second) * frac)
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
    wrongSidewalkOffsetEnabled = false
    skipCrossingsEnabled = false
    skipCrossingsTimer?.cancel()
    skipCrossingsTimer = null
    deviateTimer?.cancel()
    deviateTimer = null
    deviateWalkerActive = false
    activeOptions = null
    prevFixLat = Double.NaN
    prevFixLng = Double.NaN
    lastFixLat = Double.NaN
    lastFixLng = Double.NaN
  }

  /**
   * Subscribe to NavInfo updates so we can pull road names off the
   * current/next StepInfo and surface them on each ManeuverPayload.
   * Best-effort — we still emit maneuvers even if the SDK never delivers
   * NavInfo (the road-name fields just stay null).
   */
  private fun registerNavInfoUpdates(activity: Activity, nav: Navigator) {
    try {
      // Request the FULL remaining step list (well above any real route's
      // depth). The miniapp's pivot engine matches each geometric pivot to
      // its corresponding step to derive `fromRoad` / `toRoad`; with only
      // 1 step previewed, pivots past the immediate turn get no match
      // and render as "∅". Google caps this at the route's actual size
      // internally — asking for 100 is safe.
      val ok = nav.registerServiceForNavUpdates(
        activity.packageName,
        NavInfoReceiverService::class.java.name,
        /* numNextStepsToPreview = */ 100,
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
    activeOptions = options
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
      if (points.isEmpty()) {
        Log.w(TAG, "route segments empty, nothing to emit")
        return
      }
      val steps = buildRouteSteps(points)
      Log.d(TAG, "emit route — ${points.size} points, steps=${steps?.size ?: "null"}")
      callbacks.onRoute(points, steps)
      // If we don't have steps yet, register to re-emit once they
      // arrive from the first NavInfo. One-shot — the holder clears
      // the listener after firing.
      if (steps == null) {
        NavInfoHolder.onAllStepsAvailable = {
          try {
            val laterSteps = buildRouteSteps(points)
            if (laterSteps != null) {
              Log.d(TAG, "re-emit route with steps now available — steps=${laterSteps.size}")
              callbacks.onRoute(points, laterSteps)
            }
          } catch (e: Throwable) {
            Log.w(TAG, "deferred route re-emit failed: ${e.message}")
          }
        }
      }
    } catch (e: Exception) {
      Log.e(TAG, "emitRoute failed", e)
    }
  }

  /**
   * Build the wire-shape step list from the polyline + the latest
   * `NavInfoHolder.allSteps`. The Google Nav SDK's `StepInfo` does
   * not expose step coordinates, so we walk the polyline with each
   * step's `distanceMeters` as the cumulative offset from the trip
   * start. The polyline vertex closest to that offset is the step's
   * start anchor.
   *
   * `distanceFromPrevStepMeters` semantics on the SDK side: the first
   * remaining step's value is the distance of the *current* step
   * (i.e. how far it spans), and subsequent steps describe their own
   * spans. We treat steps[0] as anchored at offset 0 (user's current
   * position along the route) and place steps[i>0] at the cumulative
   * sum of prior steps' lengths.
   *
   * Returns null when NavInfo hasn't supplied steps yet — caller
   * uses this signal to register a re-emit.
   */
  private fun buildRouteSteps(points: List<RoutePoint>): List<RouteStep>? {
    val src = NavInfoHolder.allSteps ?: return null
    if (src.isEmpty() || points.isEmpty()) return null

    val cumPolylineMeters = DoubleArray(points.size)
    for (i in 1 until points.size) {
      cumPolylineMeters[i] = cumPolylineMeters[i - 1] + haversine(
        points[i - 1].lat, points[i - 1].lng,
        points[i].lat, points[i].lng,
      )
    }

    val out = ArrayList<RouteStep>(src.size)
    val totalPolylineMeters = cumPolylineMeters.last()
    var cumStepOffset = 0.0
    for (s in src) {
      val idx = closestPolylineIndexByDistance(cumPolylineMeters, cumStepOffset)
      out.add(
        RouteStep(
          lat = points[idx].lat,
          lng = points[idx].lng,
          routeIndex = idx,
          road = s.road,
          maneuver = s.maneuver,
          distanceMeters = s.distanceMeters,
        ),
      )
      // Advance the offset by this step's own length so the next step
      // anchors at the right cumulative distance. `distanceMeters` on
      // a remaining step is the length of that step, so adding it
      // moves us to the start of the next. Cap at the polyline total
      // so a slight distance overshoot doesn't push us out of bounds.
      cumStepOffset = (cumStepOffset + s.distanceMeters.coerceAtLeast(0))
        .coerceAtMost(totalPolylineMeters)
    }
    return if (out.isEmpty()) null else out
  }

  /** Polyline vertex index whose cumulative distance is closest to `target`. */
  private fun closestPolylineIndexByDistance(cum: DoubleArray, target: Double): Int {
    if (target <= 0) return 0
    if (target >= cum.last()) return cum.size - 1
    var best = 0
    var bestD = Double.MAX_VALUE
    for (i in cum.indices) {
      val d = kotlin.math.abs(cum[i] - target)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
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
        if (skipCrossingsEnabled) {
          // Our walker owns the simulator while this flag is on. Stop
          // any in-progress timer and rebuild against the new route.
          startSkipCrossingsWalker()
        } else {
          try {
            nav.simulator?.simulateLocationsAlongExistingRoute(
              SimulationOptions().speedMultiplier(simulationSpeed),
            )
          } catch (e: Throwable) {
            Log.w(TAG, "failed to restart simulator after reroute: ${e.message}")
          }
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
        // While the deviate walker is in flight, the provider is still
        // alive but its snapped positions would fight the synthetic
        // ones our walker is emitting — the dot would jump between the
        // two. Short-circuit: walker owns location until it stops.
        if (deviateWalkerActive) return@LocationListener
        // Compute the effective (lat, lng) we'll report — either the raw
        // road-snapped fix or its wrong-sidewalk-shifted twin. Everything
        // downstream (lastFix tracking, off-route detection, JS event)
        // sees the same value so the system stays coherent.
        var effectiveLat = loc.latitude
        var effectiveLng = loc.longitude
        if (wrongSidewalkOffsetEnabled) {
          val nav = navigator
          val flat = if (nav != null) flattenRoute(nav) else null
          if (flat != null && flat.size >= 2) {
            val (idx, _) = closestSegmentIndex(flat, loc.latitude, loc.longitude)
            val a = flat[idx]
            val b = flat[(idx + 1).coerceAtMost(flat.size - 1)]
            val routeBearing = bearing(a.first, a.second, b.first, b.second)
            // Perpendicular-right of the route bearing.
            val perpBearing = (routeBearing + 90.0) % 360.0
            val (offLat, offLng) = movePoint(loc.latitude, loc.longitude, WRONG_SIDEWALK_OFFSET_M, perpBearing)
            effectiveLat = offLat
            effectiveLng = offLng
          }
        }
        // Slide the prev → last window so the Deviate dev button can
        // recover the user's actual direction of travel.
        prevFixLat = lastFixLat
        prevFixLng = lastFixLng
        lastFixLat = effectiveLat
        lastFixLng = effectiveLng
        lastSpeedMps = if (loc.hasSpeed()) loc.speed else null
        callbacks.onLocation(
          LocationPayload(
            lat = effectiveLat,
            lng = effectiveLng,
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
            val (_, perp) = closestSegmentIndex(flat, effectiveLat, effectiveLng)
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
