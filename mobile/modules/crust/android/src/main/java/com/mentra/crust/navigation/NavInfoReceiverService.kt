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

        // SDK semantics (corrected from earlier mis-reading of the docs):
        //   currentStep             = the segment the user is currently
        //                             traversing. Its `simpleRoadName` is
        //                             the road they're on right now. Its
        //                             `maneuver` is how they'll exit at
        //                             the end of this segment.
        //   distanceToCurrentStepMeters = distance to the END of the
        //                                 current segment (i.e. to the
        //                                 upcoming turn).
        //   remainingSteps[0]       = the FIRST step after the current one
        //                             — i.e. the road the user will be on
        //                             AFTER the upcoming turn. That's the
        //                             "next road" the UI wants to show.
        //
        // Mapping into our wire fields:
        //   currentRoad  = currentStep.simpleRoadName      (road on now)
        //   nextStepRoad = remainingSteps[0].simpleRoadName (road after turn)
        //
        // `nextRoad` is left as the legacy upcoming-road value (same as
        // currentStep.road) for back-compat with any consumer that hasn't
        // migrated to nextStepRoad yet.
        val currentRoad = current?.simpleRoadName ?: current?.fullRoadName
        val nextStepRoad = readNextStepRoad(navInfo)
        // Full ordered step list (currentStep + remainingSteps) for the
        // SDK's pivot enrichment. Pulled here once per NavInfo tick so
        // NavigationManager.emitRoute can attach it atomically.
        val allSteps = readAllSteps(navInfo)

        NavInfoHolder.update(
          currentRoad = currentRoad,
          nextRoad = currentRoad,
          nextStepRoad = nextStepRoad,
          allSteps = allSteps,
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

    /** Kept as a public no-op so older callers that invoke this on
     *  trip teardown don't break. The previous lag-by-one step
     *  tracking it cleared is gone. */
    fun resetStepTracking() {
      // intentionally empty
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
     * Read the road name of the FIRST step after the current one — i.e.
     * the road the user will be on AFTER the upcoming maneuver. This is
     * what the UI shows as the "next road" (e.g. "King St W" while
     * approaching a turn).
     *
     * Defensive reflection: `NavInfo.getRemainingSteps()` is documented
     * but its presence / shape varies across Nav SDK versions. We try
     * both `remainingSteps` (List<StepInfo>) and `getRemainingSteps()`
     * (StepInfo[]) and read whichever returns. Returns null when the
     * method is missing, the list is empty, or the step has no road
     * name (Google leaves it blank on unnamed segments).
     */
    private fun readNextStepRoad(navInfo: NavInfo): String? {
      return try {
        val m = navInfo::class.java.methods.firstOrNull { it.name == "getRemainingSteps" && it.parameterCount == 0 }
          ?: return null
        val raw = m.invoke(navInfo) ?: return null
        val first: StepInfo? = when (raw) {
          is Array<*> -> raw.firstOrNull() as? StepInfo
          is List<*> -> raw.firstOrNull() as? StepInfo
          else -> null
        }
        val name = first?.simpleRoadName ?: first?.fullRoadName
        name?.takeIf { it.isNotBlank() }
      } catch (_: Throwable) {
        null
      }
    }

    /**
     * Pull the full step list from NavInfo for pivot enrichment.
     * Concatenates `currentStep` (where the user is now) + the
     * remaining steps (everything ahead). Each entry carries the
     * step's road name + exit maneuver — the SDK consumer uses these
     * to label pivots with fromRoad / toRoad.
     *
     * Returns null when NavInfo isn't yet shaped to deliver them
     * (e.g. SDK version differences or pre-first-NavInfo).
     */
    private fun readAllSteps(navInfo: NavInfo): List<RouteStepInfo>? {
      return try {
        val out = ArrayList<RouteStepInfo>()
        navInfo.currentStep?.let { stepToInfo(it) }?.let { out.add(it) }
        val m = navInfo::class.java.methods.firstOrNull { it.name == "getRemainingSteps" && it.parameterCount == 0 }
        if (m != null) {
          val raw = m.invoke(navInfo)
          val list: List<StepInfo>? = when (raw) {
            is Array<*> -> raw.filterIsInstance<StepInfo>()
            is List<*> -> raw.filterIsInstance<StepInfo>()
            else -> null
          }
          if (list != null) {
            for (s in list) {
              stepToInfo(s)?.let { out.add(it) }
            }
          }
        }
        if (out.isEmpty()) null else out
      } catch (_: Throwable) {
        null
      }
    }

    /**
     * Convert a single StepInfo into the wire shape. Reads coords +
     * road + categorical maneuver + distance defensively — different
     * Nav SDK builds expose subtly different APIs and we don't want
     * to crash if a getter is missing.
     */
    private fun stepToInfo(step: StepInfo): RouteStepInfo? {
      return try {
        val road = (step.simpleRoadName ?: step.fullRoadName)?.takeIf { it.isNotBlank() }
        val maneuver = step.maneuver.let { mapManeuver(it) }
        val distance: Int = try {
          (step.distanceFromPrevStepMeters as Number).toInt()
        } catch (_: Throwable) {
          0
        }
        // The Nav SDK's StepInfo does NOT expose step coordinates — only
        // road name, maneuver type, ordinal index, and step length. We
        // capture those here; the consumer (NavigationManager.buildRouteSteps)
        // walks the route polyline using `distanceMeters` as cumulative
        // offsets to derive each step's start vertex.
        RouteStepInfo(road = road, maneuver = maneuver, distanceMeters = distance)
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
 * Wire shape of one step in the active route, captured from
 * `NavInfo.currentStep + remainingSteps`. The Google Nav SDK's
 * `StepInfo` does not expose coordinates, so we carry only the
 * non-spatial fields here. The consumer derives each step's
 * geographic anchor by walking the polyline with `distanceMeters`
 * (each step's own length) as cumulative offset.
 */
data class RouteStepInfo(
  val road: String?,
  val maneuver: String,
  val distanceMeters: Int,
)

/**
 * Process-wide latest NavInfo signals from the Google Nav SDK.
 * NavigationManager reads these when constructing ManeuverPayloads.
 * Best-effort — fields stay null until the first NavInfo arrives, and may
 * stay null on routes/regions where the SDK doesn't supply them.
 */
object NavInfoHolder {
  @Volatile var currentRoad: String? = null
  @Volatile var nextRoad: String? = null
  /**
   * Road the user will be on AFTER the upcoming maneuver. Sourced from
   * `NavInfo.remainingSteps[0].simpleRoadName`. This is what the
   * miniapp UI shows as "the road we're turning onto" — distinct from
   * `nextRoad` (legacy, equals `currentRoad`).
   */
  @Volatile var nextStepRoad: String? = null
  /**
   * Ordered list of all known route steps (current + remaining), for
   * pivot enrichment downstream. Null until the first NavInfo tick.
   * NavigationManager subscribes to `onAllStepsAvailable` to
   * re-emit the route once steps land, so the SDK's pivot module
   * can fill in `fromRoad` / `toRoad` for the initial trip.
   */
  @Volatile var allSteps: List<RouteStepInfo>? = null
  /**
   * Listener fired the FIRST time `allSteps` becomes non-null after
   * the last `reset()`. Set by NavigationManager at trip start;
   * cleared by the holder after firing. Single-use per trip.
   */
  @Volatile var onAllStepsAvailable: (() -> Unit)? = null
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
    nextStepRoad: String?,
    allSteps: List<RouteStepInfo>?,
    sdkManeuverType: String?,
    distanceToCurrentStepMeters: Int?,
    distanceToFinalDestinationMeters: Int? = null,
    timeToFinalDestinationSeconds: Int? = null,
  ) {
    this.currentRoad = currentRoad?.takeIf { it.isNotBlank() }
    this.nextRoad = nextRoad?.takeIf { it.isNotBlank() }
    this.nextStepRoad = nextStepRoad?.takeIf { it.isNotBlank() }
    val wasMissingSteps = this.allSteps == null
    this.allSteps = allSteps?.takeIf { it.isNotEmpty() }
    this.sdkManeuverType = sdkManeuverType
    this.distanceToCurrentStepMeters = distanceToCurrentStepMeters
    this.distanceToFinalDestinationMeters = distanceToFinalDestinationMeters
    this.timeToFinalDestinationSeconds = timeToFinalDestinationSeconds

    // First time steps become available after a reset → notify the
    // pending NavigationManager so it can re-emit the route with the
    // step list folded in. One-shot per trip — we clear the listener
    // after firing.
    if (wasMissingSteps && this.allSteps != null) {
      val cb = onAllStepsAvailable
      onAllStepsAvailable = null
      cb?.invoke()
    }
  }

  fun reset() {
    currentRoad = null
    nextRoad = null
    nextStepRoad = null
    allSteps = null
    onAllStepsAvailable = null
    sdkManeuverType = null
    distanceToCurrentStepMeters = null
    distanceToFinalDestinationMeters = null
    timeToFinalDestinationSeconds = null
    NavInfoReceiverService.resetStepTracking()
  }
}
