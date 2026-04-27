package com.mentra.crust

import android.app.Activity
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
  /** Most recent road-snapped fix. Used to compute distance-to-maneuver. */
  private var lastFixLat: Double = Double.NaN
  private var lastFixLng: Double = Double.NaN

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
    /** Road the user will be on after the maneuver, per the Nav SDK. Null if unavailable. */
    val toRoad: String?,
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
  }

  /** Start a navigation session. Initializes the Navigator on first call. */
  fun start(
    activity: Activity,
    lat: Double,
    lng: Double,
    simulate: Boolean,
    speedMultiplier: Float,
    callbacks: Callbacks,
  ) {
    Log.d(TAG, "start lat=$lat lng=$lng simulate=$simulate speed=$speedMultiplier")

    NavigationApi.getNavigator(
      activity,
      object : NavigationApi.NavigatorListener {
        override fun onNavigatorReady(nav: Navigator) {
          Log.d(TAG, "navigator ready")
          navigator = nav
          attachListeners(nav, callbacks)
          attachLocationListener(activity, callbacks)
          registerNavInfoUpdates(activity, nav)
          setDestinationAndStart(nav, lat, lng, simulate, speedMultiplier, callbacks)
        }

        override fun onError(errorCode: Int) {
          val msg = errorCodeToString(errorCode)
          Log.e(TAG, "navigator init error: $msg")
          callbacks.onError(msg)
        }
      },
    )
  }

  fun stop() {
    Log.d(TAG, "stop")
    stopPolling()
    activeCallbacks = null
    lastEmittedKey = null
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
    lat: Double,
    lng: Double,
    simulate: Boolean,
    speedMultiplier: Float,
    callbacks: Callbacks,
  ) {
    val waypoint = try {
      Waypoint.builder()
        .setLatLng(lat, lng)
        .setTitle("Destination")
        .build()
    } catch (e: Waypoint.UnsupportedPlaceIdException) {
      callbacks.onError("Unsupported destination: ${e.message}")
      return
    }

    activeCallbacks = callbacks
    nav.setDestination(
      waypoint,
      RoutingOptions().travelMode(RoutingOptions.TravelMode.WALKING),
    ).setOnResultListener { status ->
      when (status) {
        Navigator.RouteStatus.OK -> {
          Log.d(TAG, "route OK, starting guidance")
          nav.startGuidance()
          if (simulate) {
            Log.d(TAG, "simulator engaged at ${speedMultiplier}x")
            nav.simulator?.simulateLocationsAlongExistingRoute(
              SimulationOptions().speedMultiplier(speedMultiplier.coerceIn(0.5f, 50f)),
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
        callbacks.onLocation(
          LocationPayload(
            lat = loc.latitude,
            lng = loc.longitude,
            accuracy = if (loc.hasAccuracy()) loc.accuracy else null,
            timestamp = loc.time,
          ),
        )
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
    // for every meter of movement.
    val distBucket = if (payload.distanceMeters >= 0) payload.distanceMeters / 5 else -1
    val key = "${payload.maneuverType}|$distBucket"
    if (key == lastEmittedKey) return
    lastEmittedKey = key
    Log.d(TAG, "emit → ${payload.maneuverType} in ${payload.distanceMeters}m")
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
    val sdkManeuver = NavInfoHolder.sdkManeuverType
    val sdkDistance = NavInfoHolder.distanceToCurrentStepMeters

    if (sdkManeuver != null && sdkDistance != null && sdkDistance >= 0) {
      return ManeuverPayload(
        maneuverType = sdkManeuver,
        distanceMeters = sdkDistance,
        fromRoad = fromRoad,
        toRoad = toRoad,
      )
    }

    val (startIdx, distToRoute) = closestSegmentIndex(flat, lastFixLat, lastFixLng)
    if (distToRoute > 50.0) {
      return ManeuverPayload(
        maneuverType = sdkManeuver ?: "STRAIGHT",
        distanceMeters = -1,
        fromRoad = fromRoad,
        toRoad = toRoad,
      )
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
