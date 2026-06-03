import {AnimatePresence, motion} from "motion/react"
import type {NavManeuver} from "@mentra/miniapp"

import type {Pivot} from "@mentra/miniapp"

import {useNavStore} from "@/ui/store/navStore"
import {formatDistance} from "@/ui/lib/formatDistance"
import {haversineMeters} from "@/ui/lib/geometry"
import {ManeuverIcon} from "@/ui/components/icons"
import type {Coords, LatLng, NavStatus} from "@/shared/types"

const SPRING = {type: "spring", stiffness: 400, damping: 32, mass: 0.6} as const

/**
 * Direction card with three lines (matches Apple/Google Maps layout):
 *
 *   In 150 m            ← distance to next pivot (live)
 *   Turn right          ← direction (or "Continue" / "Arrived")
 *   onto Market St      ← road name (toRoad on turns, fromRoad on continue)
 *
 * Pivot direction + position come from the SDK's pivot API
 * (`user.navigation.getActivePivot()` / `getUpcomingPivot()`), which
 * owns trip-wide pivot detection. Road names come from the pivot's
 * own `fromRoad` / `toRoad` (sourced from the SDK's step list at
 * route-build time) and from the live `NavManeuver` events.
 */
export function OrientationCard({
  maneuver,
  status,
}: {
  me: LatLng | null
  heading: number | null
  maneuver: NavManeuver | null
  routePoints: LatLng[] | null
  status?: NavStatus
  onClose?: () => void
}) {
  const activePivot = useNavStore((s) => s.activePivot)
  const upcomingPivot = useNavStore((s) => s.upcomingPivot)
  const coords = useNavStore((s) => s.coords)
  const snap = derivePivotView(activePivot, upcomingPivot, coords, maneuver, status)
  const real = pickDisplay(snap)

  // Diagnostic: dump every input the card uses to choose its text, so a
  // wrong card (e.g. "Arriving in 112 m" when there are pivots ahead)
  // can be traced to the exact missing/empty field. Logs both the raw
  // pivot store values and the derived snapshot.
  console.log(
    `[ManeuverCard] active=${activePivot ? `idx=${activePivot.index} dir=${activePivot.direction} to=${activePivot.toRoad ?? "—"}` : "null"} ` +
      `upcoming=${upcomingPivot ? `idx=${upcomingPivot.index} dir=${upcomingPivot.direction} to=${upcomingPivot.toRoad ?? "—"}` : "null"} ` +
      `distToNext=${snap.distanceToNextPivotMeters?.toFixed(0) ?? "—"}m ` +
      `distToDest=${snap.distanceToDestinationMeters?.toFixed(0) ?? "—"}m ` +
      `status=${status ?? "—"} arrived=${snap.arrived} → ` +
      `nextRoad="${real.nextRoad ?? ""}" label="${real.label}" icon=${real.icon}`,
  )

  // HARDCODED PREVIEW STUB — overrides every dynamic field with sample
  // text so we can iterate on the running-drawer layout. Remove this
  // block to restore live data.
  const HARDCODED_PREVIEW = false
  const {label, icon, road, nextRoad} = HARDCODED_PREVIEW
    ? {
        label: "Turn right in 500 m",
        icon: "TURN_RIGHT",
        nextRoad: "Laguna St",
        road: "onto Waller St",
      }
    : real

  return (
    <div className="mx-1 mt-2">
      <div className="[font-synthesis:none] relative flex py-4.5 px-5 gap-4  rounded-[20px] items-center bg-[#FFFFFFC7] border border-solid border-[#FFFFFF99] [backdrop-filter:blur(40px)_saturate(180%)] [box-shadow:#FFFFFF80_0px_1px_0px_inset,#00000029_0px_8px_32px] antialiased ">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={icon}
            initial={{opacity: 0, scale: 0.8}}
            animate={{opacity: 1, scale: 1}}
            exit={{opacity: 0, scale: 0.8}}
            transition={SPRING}
            className="flex items-center justify-center shrink-0 rounded-[18px] bg-[#5AC878] size-16">
            <ManeuverIcon type={icon} />
          </motion.div>
        </AnimatePresence>

        <div className="flex flex-col items-start gap-0.5 min-w-0 flex-1">
          {nextRoad ? (
            <div className="self-stretch text-[#6B6B6B] font-sans text-sm/4.5">Onto {nextRoad}</div>
          ) : null}
          {/* Animate only when the verb changes (e.g. "Turn right" → "Turn left"),
              not on every distance tick. Stripping the trailing "in 500 m" off
              the AnimatePresence key keeps the text from re-entering each
              second as the countdown updates. */}
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={label.replace(/\s+in\s+.*$/, "")}
              initial={{opacity: 0, y: 6}}
              animate={{opacity: 1, y: 0}}
              exit={{opacity: 0, y: -6}}
              transition={SPRING}
              className="tracking-[-0.02em] self-stretch text-[#111111] font-sans font-semibold text-[28px]/8.5 wrap-break-word">
              {label}
            </motion.div>
          </AnimatePresence>
          
          
        </div>
      </div>
    </div>
  )
}


/* -------------------------------------------------------------------------- */
/* Snapshot + maneuver -> display fields                                       */

/**
 * Snapshot derived purely from the SDK's pivot API plus trip status.
 * Pivots are the SOURCE OF TRUTH for road names — there is no
 * geocoder fallback and no read from the live NavManeuver event. If
 * a pivot doesn't have a road name, the UI shows nothing rather than
 * making something up.
 */
type PivotView = {
  arrived: boolean
  /** Direction of the pivot the user is currently turning at, if any. */
  activeDirection: "left" | "right" | null
  /** Maneuver string of the active pivot (e.g. CROSS_STREET, TURN_LEFT). */
  activeManeuver: string | null
  /** Road we're heading onto for the active turn, if known. */
  activeToRoad: string | null
  /** Direction of the next upcoming pivot, if any. */
  upcomingDirection: "left" | "right" | null
  /** Maneuver string of the upcoming pivot. */
  upcomingManeuver: string | null
  /** Road the user is currently on (i.e. approach road), if known. */
  upcomingFromRoad: string | null
  /** Road we'll be on after the upcoming turn, if known. */
  upcomingToRoad: string | null
  distanceToNextPivotMeters: number | null
  distanceToDestinationMeters: number | null
}

function derivePivotView(
  active: Pivot | null,
  upcoming: Pivot | null,
  coords: Coords | null,
  maneuver: NavManeuver | null,
  status?: NavStatus,
): PivotView {
  if (status === "arrived") {
    return {
      arrived: true,
      activeDirection: null,
      activeManeuver: null,
      activeToRoad: null,
      upcomingDirection: null,
      upcomingManeuver: null,
      upcomingFromRoad: null,
      upcomingToRoad: null,
      distanceToNextPivotMeters: null,
      distanceToDestinationMeters: null,
    }
  }

  let distanceToNextPivotMeters: number | null = null
  if (upcoming && coords) {
    distanceToNextPivotMeters = haversineMeters(
      {lat: coords.lat, lng: coords.lng},
      {lat: upcoming.lat, lng: upcoming.lng},
    )
  }

  const distanceToDestinationMeters =
    maneuver?.distanceToDestinationMeters != null && maneuver.distanceToDestinationMeters >= 0
      ? maneuver.distanceToDestinationMeters
      : null

  return {
    arrived: false,
    activeDirection: active?.direction ?? null,
    activeManeuver: active?.maneuver ?? null,
    activeToRoad: realRoadName(active?.toRoad),
    upcomingDirection: upcoming?.direction ?? null,
    upcomingManeuver: upcoming?.maneuver ?? null,
    upcomingFromRoad: realRoadName(upcoming?.fromRoad),
    upcomingToRoad: realRoadName(upcoming?.toRoad),
    distanceToNextPivotMeters,
    distanceToDestinationMeters,
  }
}

function pickDisplay(
  snap: PivotView,
): {label: string; icon: string; road: string | null; nextRoad: string | null} {
  if (snap.arrived) {
    return {label: "Arrived", icon: "ARRIVE", road: null, nextRoad: null}
  }

  // Active turn — user is inside the pivot's radius. Two-line layout:
  //   Onto <toRoad>
  //   Turn left|right
  // No distance, no "now" — the user is at the turn.
  if (snap.activeDirection) {
    const verb = snap.activeDirection === "right" ? "Turn right" : "Turn left"
    const icon = snap.activeDirection === "right" ? "TURN_RIGHT" : "TURN_LEFT"
    return {
      label: verb,
      icon,
      nextRoad: snap.activeToRoad,
      road: null,
    }
  }

  // Approaching the next turn. Two-line layout:
  //   Onto <toRoad>
  //   Turn left|right in <distance>
  if (snap.distanceToNextPivotMeters != null && snap.upcomingDirection) {
    const verb = snap.upcomingDirection === "right" ? "Turn right" : "Turn left"
    const distStr = formatDistance(snap.distanceToNextPivotMeters)
    const icon = snap.upcomingDirection === "right" ? "TURN_RIGHT" : "TURN_LEFT"
    return {
      label: `${verb} in ${distStr}`,
      icon,
      nextRoad: snap.upcomingToRoad,
      road: null,
    }
  }

  // No upcoming pivot — final approach to destination. Single-line:
  //   Arriving in <distance>
  if (snap.distanceToDestinationMeters != null) {
    const distStr = formatDistance(snap.distanceToDestinationMeters)
    return {
      label: `Arriving in ${distStr}`,
      icon: "ARRIVE",
      nextRoad: null,
      road: null,
    }
  }

  // No pivot, no destination distance — nothing actionable to say.
  return {label: "Arriving", icon: "ARRIVE", road: null, nextRoad: null}
}

/**
 * Sanitize a road label coming off the SDK. The Nav SDK occasionally
 * leaks its maneuver-instruction text (e.g. "Slight left", "Toward
 * Fell St", "Roundabout") into the road-name fields when the
 * underlying road has no real name. Rendered blindly these read as
 * "onto Slight left", so we treat any label starting with one of
 * those verbs as missing.
 *
 * If this returns null, the UI just shows nothing — there is no
 * fallback path. Pivot road names are the single source of truth.
 */
function realRoadName(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (/^(toward|turn|continue|destination|head|cross|slight|sharp|keep|merge|fork|exit|take|roundabout|u[\s-]?turn|arrive|arriving|depart|enter|leave|stay)\b/i.test(trimmed)) return null
  return trimmed
}

