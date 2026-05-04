package com.mentra.crust.navigation

import android.app.Service
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.util.Log
import com.google.android.libraries.mapsplatform.turnbyturn.TurnByTurnManager
import com.google.android.libraries.mapsplatform.turnbyturn.model.Maneuver
import com.google.android.libraries.mapsplatform.turnbyturn.model.NavInfo
import com.google.android.libraries.mapsplatform.turnbyturn.model.StepInfo

/**
 * Receives NavInfo updates from the Google Nav SDK via Messenger IPC.
 *
 * The SDK's `Navigator.registerServiceForNavUpdates(...)` requires a
 * declared Service that exposes a Messenger. This service simply unmarshals
 * the NavInfo Bundle and forwards road names + maneuver type to
 * `NavInfoHolder` so `NavigationManager` can use the SDK's authoritative
 * step info instead of guessing from polyline bearings.
 */
class NavInfoReceiverService : Service() {

  private val turnByTurnManager: TurnByTurnManager by lazy {
    TurnByTurnManager.createInstance()
  }

  private val incomingHandler =
    object : Handler(Looper.getMainLooper()) {
      override fun handleMessage(msg: Message) {
        if (msg.what != TurnByTurnManager.MSG_NAV_INFO) return
        val navInfo: NavInfo? =
          try {
            turnByTurnManager.readNavInfoFromBundle(msg.data)
          } catch (e: Throwable) {
            Log.w(TAG, "readNavInfoFromBundle failed: ${e.message}")
            null
          }
        if (navInfo == null) return
        val current: StepInfo? = navInfo.currentStep

        // SDK semantics:
        //   currentStep         = the UPCOMING step (its road is where you'll
        //                         be AFTER the next maneuver, its maneuver is
        //                         HOW you'll get there)
        //   distanceToCurrentStepMeters = distance to the start of that step
        //                                 (i.e. distance to the upcoming turn)
        //
        // So the correct mapping for our payload:
        //   toRoad   = currentStep.road           (where you're heading)
        //   fromRoad = the PREVIOUS currentStep.road we saw
        //              (= the road you're physically on right now)
        val upcomingRoad = current?.simpleRoadName ?: current?.fullRoadName
        if (upcomingRoad != null && upcomingRoad != lastSeenStepRoad) {
          // currentStep just rolled to a new step — what was the upcoming
          // road is now the road we're on.
          previousStepRoad = lastSeenStepRoad
          lastSeenStepRoad = upcomingRoad
        } else if (lastSeenStepRoad == null && upcomingRoad != null) {
          lastSeenStepRoad = upcomingRoad
        }

        NavInfoHolder.update(
          currentRoad = previousStepRoad,
          nextRoad = upcomingRoad,
          sdkManeuverType = current?.maneuver?.let { mapManeuver(it) },
          distanceToCurrentStepMeters = navInfo.distanceToCurrentStepMeters,
          // Trip totals come straight off NavInfo. Treat negative SDK values
          // as "unknown" — caller decides how to surface that on the wire.
          distanceToFinalDestinationMeters = readPositive(navInfo, "getDistanceToFinalDestinationMeters"),
          timeToFinalDestinationSeconds = readPositive(navInfo, "getTimeToFinalDestinationSeconds"),
        )
      }
    }

  private val messenger = Messenger(incomingHandler)

  override fun onBind(intent: Intent?): IBinder = messenger.binder

  companion object {
    private const val TAG = "NavInfoReceiverSvc"

    // Step tracking — see the comment in incomingHandler. Process-wide
    // because NavInfoHolder.reset() needs to clear these on trip stop, and
    // we don't have direct access to a service instance from there.
    @Volatile private var previousStepRoad: String? = null
    @Volatile private var lastSeenStepRoad: String? = null

    fun resetStepTracking() {
      previousStepRoad = null
      lastSeenStepRoad = null
    }

    /**
     * Pull a non-negative number off NavInfo via reflection. The Google Nav
     * SDK exposes total-trip getters on `NavInfo` but the exact method
     * names + signatures vary by SDK version, so we probe defensively
     * instead of pinning to one shape and crashing on a mismatch. Returns
     * null when the method is missing or the value is negative ("unknown"
     * per SDK convention).
     */
    private fun readPositive(navInfo: NavInfo, getter: String): Int? {
      return try {
        val m = navInfo::class.java.methods.firstOrNull { it.name == getter && it.parameterCount == 0 }
        val v = m?.invoke(navInfo) as? Number ?: return null
        val i = v.toInt()
        if (i >= 0) i else null
      } catch (_: Throwable) {
        null
      }
    }

    /**
     * Reduce the SDK's ~70-value Maneuver enum to the small set of
     * categorical strings we already use across the bridge:
     * STRAIGHT, SLIGHT_LEFT, SLIGHT_RIGHT, TURN_LEFT, TURN_RIGHT,
     * SHARP_LEFT, SHARP_RIGHT, U_TURN, ARRIVE.
     *
     * Roundabouts/forks/ramps/merges all collapse to their dominant
     * direction — we lose nuance but keep the surface compact for the
     * miniapp UI.
     */
    @JvmStatic
    fun mapManeuver(@Maneuver code: Int): String = when (code) {
      Maneuver.DESTINATION,
      Maneuver.DESTINATION_LEFT,
      Maneuver.DESTINATION_RIGHT -> "ARRIVE"

      Maneuver.DEPART,
      Maneuver.STRAIGHT,
      Maneuver.NAME_CHANGE,
      Maneuver.FERRY_BOAT,
      Maneuver.FERRY_TRAIN -> "STRAIGHT"

      Maneuver.TURN_SLIGHT_LEFT,
      Maneuver.TURN_KEEP_LEFT,
      Maneuver.MERGE_LEFT,
      Maneuver.FORK_LEFT,
      Maneuver.ON_RAMP_SLIGHT_LEFT,
      Maneuver.ON_RAMP_KEEP_LEFT,
      Maneuver.OFF_RAMP_SLIGHT_LEFT,
      Maneuver.OFF_RAMP_KEEP_LEFT,
      Maneuver.ROUNDABOUT_SLIGHT_LEFT_CLOCKWISE,
      Maneuver.ROUNDABOUT_SLIGHT_LEFT_COUNTERCLOCKWISE -> "SLIGHT_LEFT"

      Maneuver.TURN_SLIGHT_RIGHT,
      Maneuver.TURN_KEEP_RIGHT,
      Maneuver.MERGE_RIGHT,
      Maneuver.FORK_RIGHT,
      Maneuver.ON_RAMP_SLIGHT_RIGHT,
      Maneuver.ON_RAMP_KEEP_RIGHT,
      Maneuver.OFF_RAMP_SLIGHT_RIGHT,
      Maneuver.OFF_RAMP_KEEP_RIGHT,
      Maneuver.ROUNDABOUT_SLIGHT_RIGHT_CLOCKWISE,
      Maneuver.ROUNDABOUT_SLIGHT_RIGHT_COUNTERCLOCKWISE -> "SLIGHT_RIGHT"

      Maneuver.TURN_LEFT,
      Maneuver.ON_RAMP_LEFT,
      Maneuver.OFF_RAMP_LEFT,
      Maneuver.ROUNDABOUT_LEFT_CLOCKWISE,
      Maneuver.ROUNDABOUT_LEFT_COUNTERCLOCKWISE,
      Maneuver.ROUNDABOUT_EXIT_CLOCKWISE,
      Maneuver.ROUNDABOUT_EXIT_COUNTERCLOCKWISE -> "TURN_LEFT"

      Maneuver.TURN_RIGHT,
      Maneuver.ON_RAMP_RIGHT,
      Maneuver.OFF_RAMP_RIGHT,
      Maneuver.ROUNDABOUT_RIGHT_CLOCKWISE,
      Maneuver.ROUNDABOUT_RIGHT_COUNTERCLOCKWISE -> "TURN_RIGHT"

      Maneuver.TURN_SHARP_LEFT,
      Maneuver.ON_RAMP_SHARP_LEFT,
      Maneuver.OFF_RAMP_SHARP_LEFT,
      Maneuver.ROUNDABOUT_SHARP_LEFT_CLOCKWISE,
      Maneuver.ROUNDABOUT_SHARP_LEFT_COUNTERCLOCKWISE -> "SHARP_LEFT"

      Maneuver.TURN_SHARP_RIGHT,
      Maneuver.ON_RAMP_SHARP_RIGHT,
      Maneuver.OFF_RAMP_SHARP_RIGHT,
      Maneuver.ROUNDABOUT_SHARP_RIGHT_CLOCKWISE,
      Maneuver.ROUNDABOUT_SHARP_RIGHT_COUNTERCLOCKWISE -> "SHARP_RIGHT"

      Maneuver.TURN_U_TURN_CLOCKWISE,
      Maneuver.TURN_U_TURN_COUNTERCLOCKWISE,
      Maneuver.ON_RAMP_U_TURN_CLOCKWISE,
      Maneuver.ON_RAMP_U_TURN_COUNTERCLOCKWISE,
      Maneuver.OFF_RAMP_U_TURN_CLOCKWISE,
      Maneuver.OFF_RAMP_U_TURN_COUNTERCLOCKWISE,
      Maneuver.ROUNDABOUT_U_TURN_CLOCKWISE,
      Maneuver.ROUNDABOUT_U_TURN_COUNTERCLOCKWISE -> "U_TURN"

      // Roundabout straight / unspecified ramp-merge / unknown — fall back
      // to bearing-based detection by leaving as STRAIGHT (caller may
      // override with bearing-derived type when there's a real bend).
      else -> "STRAIGHT"
    }
  }
}

/**
 * Process-wide latest NavInfo signals from the Google Nav SDK.
 * NavigationManager reads these when constructing ManeuverPayloads.
 * Best-effort — fields stay null until the first NavInfo arrives, and may
 * stay null on routes/regions where the SDK doesn't supply them.
 */
object NavInfoHolder {
  @Volatile var currentRoad: String? = null
  @Volatile var nextRoad: String? = null
  /** Mapped string per CrustModule's maneuver vocabulary. Null = use bearing-derived. */
  @Volatile var sdkManeuverType: String? = null
  /**
   * Distance in meters from the user to the *current* step's anchor, per the
   * SDK. This is the authoritative pairing for `sdkManeuverType` /
   * `currentRoad` / `nextRoad` — read all four together, otherwise the
   * bearing-derived distance can describe a different step than the
   * SDK-derived type/roads. Null until first NavInfo arrives or when the
   * SDK doesn't supply it.
   */
  @Volatile var distanceToCurrentStepMeters: Int? = null
  /** Total trip distance remaining in meters. Null = SDK didn't supply. */
  @Volatile var distanceToFinalDestinationMeters: Int? = null
  /** Total trip time remaining in seconds. Null = SDK didn't supply. */
  @Volatile var timeToFinalDestinationSeconds: Int? = null

  fun update(
    currentRoad: String?,
    nextRoad: String?,
    sdkManeuverType: String?,
    distanceToCurrentStepMeters: Int?,
    distanceToFinalDestinationMeters: Int? = null,
    timeToFinalDestinationSeconds: Int? = null,
  ) {
    this.currentRoad = currentRoad?.takeIf { it.isNotBlank() }
    this.nextRoad = nextRoad?.takeIf { it.isNotBlank() }
    this.sdkManeuverType = sdkManeuverType
    this.distanceToCurrentStepMeters = distanceToCurrentStepMeters
    this.distanceToFinalDestinationMeters = distanceToFinalDestinationMeters
    this.timeToFinalDestinationSeconds = timeToFinalDestinationSeconds
  }

  fun reset() {
    currentRoad = null
    nextRoad = null
    sdkManeuverType = null
    distanceToCurrentStepMeters = null
    distanceToFinalDestinationMeters = null
    timeToFinalDestinationSeconds = null
    NavInfoReceiverService.resetStepTracking()
  }
}
