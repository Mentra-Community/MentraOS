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

  data class ManeuverPayload(
    val instruction: String,
    val roadName: String,
    val maneuverType: String,
    val distanceMeters: Int,
    /** Road the user will be on AFTER this maneuver completes. */
    val towardRoad: String,
    /** Categorical type of the maneuver after this one. Empty if unknown. */
    val nextManeuverType: String,
    /** UI hint label for the next maneuver, e.g. "Then". Empty if none. */
    val nextManeuverLabel: String,
  )

  data class LocationPayload(
    val lat: Double,
    val lng: Double,
    val accuracy: Float?,
    val timestamp: Long,
  )

  interface Callbacks {
    fun onManeuver(payload: ManeuverPayload)
    fun onRerouting()
    fun onArrived()
    fun onError(message: String)
    fun onLocation(payload: LocationPayload)
  }

  /** Start a navigation session. Initializes the Navigator on first call. */
  fun start(activity: Activity, lat: Double, lng: Double, callbacks: Callbacks) {
    Log.d(TAG, "start lat=$lat lng=$lng")

    NavigationApi.getNavigator(
      activity,
      object : NavigationApi.NavigatorListener {
        override fun onNavigatorReady(nav: Navigator) {
          Log.d(TAG, "navigator ready")
          navigator = nav
          attachListeners(nav, callbacks)
          attachLocationListener(activity, callbacks)
          setDestinationAndStart(nav, lat, lng, callbacks)
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
        nav.stopGuidance()
        nav.clearDestinations()
        detachListeners(nav)
      } catch (e: Exception) {
        Log.e(TAG, "stop failed", e)
      }
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
          startPolling()
          emitCurrentManeuverIfChanged(nav, callbacks)
        }
        else -> {
          val msg = "route status: $status"
          Log.e(TAG, msg)
          callbacks.onError(msg)
        }
      }
    }
  }

  private fun attachListeners(nav: Navigator, callbacks: Callbacks) {
    arrivalListener = Navigator.ArrivalListener { _: ArrivalEvent ->
      Log.d(TAG, "arrived")
      callbacks.onArrived()
    }
    routeChangedListener = Navigator.RouteChangedListener {
      Log.d(TAG, "route changed — emitting next maneuver")
      callbacks.onRerouting()
      lastEmittedKey = null // force re-emit after reroute
      emitCurrentManeuverIfChanged(nav, callbacks)
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
      Log.d(TAG, "emit skipped — payload null (info or segment unavailable)")
      return
    }
    val key = "${payload.maneuverType}|${payload.roadName}|${payload.towardRoad}|${payload.distanceMeters}"
    if (key == lastEmittedKey) {
      Log.d(TAG, "emit skipped — same key=$key")
      return
    }
    lastEmittedKey = key
    Log.d(TAG, "emit → $payload")
    callbacks.onManeuver(payload)
  }

  private fun buildManeuverPayload(nav: Navigator): ManeuverPayload? {
    val info = nav.currentTimeAndDistance
    val seg = nav.currentRouteSegment
    Log.d(TAG, "build: info=${info?.meters} seg=${seg?.destinationWaypoint?.title}")
    if (info == null) return null

    // Google Nav SDK 6.x exposes coarse step data on the current segment.
    // We extract what we can and fall back to safe defaults so the JS layer
    // always receives a complete shape.
    val curRoad = seg?.destinationWaypoint?.title ?: ""

    // Look ahead to the next segment for the "Then …" instruction.
    val remaining = try {
      nav.routeSegments
    } catch (_: Throwable) {
      null
    }
    val nextSeg = remaining?.let { list ->
      val idx = list.indexOf(seg)
      if (idx >= 0 && idx + 1 < list.size) list[idx + 1] else null
    }
    val nextRoad = nextSeg?.destinationWaypoint?.title ?: ""

    return ManeuverPayload(
      instruction = if (curRoad.isNotEmpty()) curRoad else "Continue",
      roadName = curRoad,
      maneuverType = "STRAIGHT",
      distanceMeters = info.meters,
      towardRoad = nextRoad,
      nextManeuverType = if (nextRoad.isNotEmpty()) "STRAIGHT" else "",
      nextManeuverLabel = if (nextRoad.isNotEmpty()) "Then" else "",
    )
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
