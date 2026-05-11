import type {ReactNode} from "react"
import {AnimatePresence, motion} from "motion/react"
import type {NavManeuver} from "@mentra/miniapp"

import {useUser} from "@/backend/hooks/useUser"
import {formatDistance} from "@/backend/lib/formatDistance/formatDistance"
import {haversineMeters, type LatLng} from "@/backend/lib/geometry/geometry"
import type {User} from "@/backend/session/User"
import type {NavStatus} from "@/frontend/pages/NavigationPage/NavigationPage"

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
  const user = useUser()
  const snap = derivePivotView(user, maneuver, status)
  const real = pickDisplay(snap)

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

  // Single source of truth — log exactly what the ManeuverCard is showing
  // on screen right now. This is the only road/maneuver log in the app.
  console.log(`[ManeuverCard] ${nextRoad ?? "—"} | ${label} | ${road ?? "—"}`)

  return (
    <div className="mx-1 mt-2">
      <div className="[font-synthesis:none] relative flex py-4.5 px-5 gap-4 rounded-bl-sm rounded-[20px] items-center bg-[#FFFFFFC7] border border-solid border-[#FFFFFF99] [backdrop-filter:blur(40px)_saturate(180%)] [box-shadow:#FFFFFF80_0px_1px_0px_inset,#00000029_0px_8px_32px] antialiased ">
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
              className="tracking-[-0.02em] self-stretch text-[#111111] font-sans font-semibold text-[28px]/8.5 truncate">
              {label}
            </motion.div>
          </AnimatePresence>
          
          
        </div>
      </div>
    </div>
  )
}

function LaneArrow({direction, highlight}: {direction: "left" | "straight" | "right"; highlight: boolean}) {
  const color = highlight ? "#111111" : "#9CA3AF"
  const path =
    direction === "left"
      ? "M14 4 L4 12 L14 20 M4 12 L20 12"
      : direction === "right"
        ? "M10 4 L20 12 L10 20 M20 12 L4 12"
        : "M12 4 L12 20 M6 10 L12 4 L18 10"
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d={path} stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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
  /** Road we're heading onto for the active turn, if known. */
  activeToRoad: string | null
  /** Direction of the next upcoming pivot, if any. */
  upcomingDirection: "left" | "right" | null
  /** Road the user is currently on (i.e. approach road), if known. */
  upcomingFromRoad: string | null
  /** Road we'll be on after the upcoming turn, if known. */
  upcomingToRoad: string | null
  distanceToNextPivotMeters: number | null
  distanceToDestinationMeters: number | null
}

function derivePivotView(user: User, maneuver: NavManeuver | null, status?: NavStatus): PivotView {
  if (status === "arrived") {
    return {
      arrived: true,
      activeDirection: null,
      activeToRoad: null,
      upcomingDirection: null,
      upcomingFromRoad: null,
      upcomingToRoad: null,
      distanceToNextPivotMeters: null,
      distanceToDestinationMeters: null,
    }
  }

  const active = user.navigation.getActivePivot()
  const upcoming = user.navigation.getUpcomingPivot()
  const coords = user.coords

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
    activeToRoad: realRoadName(active?.toRoad),
    upcomingDirection: upcoming?.direction ?? null,
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

  if (snap.activeDirection === "right") {
    return {
      label: "Turn right",
      icon: "TURN_RIGHT",
      road: snap.activeToRoad ? `onto ${snap.activeToRoad}` : null,
      nextRoad: null,
    }
  }
  if (snap.activeDirection === "left") {
    return {
      label: "Turn left",
      icon: "TURN_LEFT",
      road: snap.activeToRoad ? `onto ${snap.activeToRoad}` : null,
      nextRoad: null,
    }
  }

  // Continue layout: top small line is the road the user is currently
  // on (the upcoming pivot's fromRoad), big bold middle line is the
  // verb + distance to the upcoming turn, bottom line is the
  // destination road (the upcoming pivot's toRoad).
  if (snap.distanceToNextPivotMeters != null && snap.upcomingDirection) {
    const verb = snap.upcomingDirection === "right" ? "Turn right" : "Turn left"
    const distStr = formatDistance(snap.distanceToNextPivotMeters)
    const icon = snap.upcomingDirection === "right" ? "TURN_RIGHT" : "TURN_LEFT"
    return {
      label: `${verb} in ${distStr}`,
      icon,
      nextRoad: snap.upcomingFromRoad,
      road: snap.upcomingToRoad ? `onto ${snap.upcomingToRoad}` : null,
    }
  }

  // No upcoming pivot — final approach to destination.
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

/* -------------------------------------------------------------------------- */
/* Maneuver SVG arrows                                                         */

function ManeuverIcon({type, size = 32, stroke = false}: {type: string; size?: number; stroke?: boolean}) {
  const t = type.toUpperCase()
  const color = stroke ? "#000000D9" : "#FBF6E8"
  const sw = stroke ? 6 : 0

  const svg = (path: ReactNode) => (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      {path}
    </svg>
  )

  if (t === "TURN_RIGHT" || t === "SLIGHT_RIGHT" || t === "SHARP_RIGHT") return svg(
    <path d="M18 56 L18 38 Q18 26 30 26 L52 26 L52 14 L72 32 L52 50 L52 38 L34 38 L34 56 Z" fill={stroke ? "none" : color} stroke={stroke ? color : undefined} strokeWidth={sw} strokeLinejoin="round" />
  )
  if (t === "TURN_LEFT" || t === "SLIGHT_LEFT" || t === "SHARP_LEFT" || t === "U_TURN") return svg(
    <path d="M62 56 L62 38 Q62 26 50 26 L28 26 L28 14 L8 32 L28 50 L28 38 L46 38 L46 56 Z" fill={stroke ? "none" : color} stroke={stroke ? color : undefined} strokeWidth={sw} strokeLinejoin="round" />
  )
  if (t === "ARRIVE") return svg(<>
    <circle cx="40" cy="34" r="12" fill={color} />
    <path d="M40 46 L40 66" stroke={color} strokeWidth="8" strokeLinecap="round" />
    <circle cx="40" cy="34" r="5" fill="#5AC878" />
  </>)

  // Straight / continue / default
  if (stroke) return svg(
    <path d="M40 64 L40 28 L24 36 L40 12 L56 36 L40 28" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none" />
  )
  return svg(
    <path d="M32 62 L32 32 L20 32 L40 10 L60 32 L48 32 L48 62 Z" fill={color} />
  )
}
