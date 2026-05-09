import type {ReactNode} from "react"
import {AnimatePresence, motion} from "motion/react"
import type {NavManeuver} from "@mentra/miniapp"

import {useUser} from "@/backend/hooks/useUser"
import {formatDistance} from "@/backend/lib/formatDistance/formatDistance"
import type {LatLng} from "@/backend/lib/geometry/geometry"
import type {PivotSnapshot} from "@/client/session/managers/navigation/PivotTracker"

const SPRING = {type: "spring", stiffness: 400, damping: 32, mass: 0.6} as const

/**
 * Direction card with three lines (matches Apple/Google Maps layout):
 *
 *   In 150 m            ← distance to next pivot (live)
 *   Turn right          ← direction (or "Continue" / "Arrived")
 *   onto Market St      ← road name (toRoad on turns, fromRoad on continue)
 *
 * Direction & distance come from `user.pivots` (geometry).
 * Road names come from the SDK's `NavManeuver` — `fromRoad` is the road
 * we're currently walking on, `toRoad` is the road we're turning onto.
 * The SDK updates these atomically when you transition streets, so they
 * don't flicker the way reverse-geocoding does at intersections.
 */
export function OrientationCard({
  maneuver,
}: {
  me: LatLng | null
  heading: number | null
  maneuver: NavManeuver | null
  routePoints: LatLng[] | null
  onClose?: () => void
}) {
  const user = useUser()
  const snap = user.pivots.getSnapshot()
  const roadSnap = user.road.getSnapshot()
  const {label, icon, road, distance} = pickDisplay(snap, maneuver, roadSnap.road)

  // Single source of truth — log exactly what the ManeuverCard is showing
  // on screen right now. This is the only road/maneuver log in the app.
  console.log(`[ManeuverCard] ${distance ?? "—"} | ${label} | ${road ?? "—"}`)

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
          {distance ? (
            <div className="self-stretch text-[#6B6B6B] font-sans text-sm/4.5">{distance}</div>
          ) : null}
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={label}
              initial={{opacity: 0, y: 6}}
              animate={{opacity: 1, y: 0}}
              exit={{opacity: 0, y: -6}}
              transition={SPRING}
              className="tracking-[-0.02em] self-stretch text-[#111111] font-sans font-semibold text-[28px]/8.5 truncate">
              {label}
            </motion.div>
          </AnimatePresence>
          {road ? (
            <div className="self-stretch text-[#111111] font-sans text-base/5.5 truncate">{road}</div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Snapshot + maneuver -> display fields                                       */

function pickDisplay(
  snap: PivotSnapshot,
  maneuver: NavManeuver | null,
  geocoderRoad: string | null,
): {label: string; icon: string; road: string | null; distance: string | null} {
  if (snap.arrived) {
    return {label: "Arrived", icon: "ARRIVE", road: null, distance: null}
  }

  // The SDK sometimes returns placeholder road names like "toward Fell St"
  // when it doesn't have a confirmed name. Treat those as missing.
  const namedToRoad = realRoadName(maneuver?.toRoad)

  if (snap.direction === "right") {
    return {
      label: "Turn right",
      icon: "TURN_RIGHT",
      road: namedToRoad ? `onto ${namedToRoad}` : null,
      distance: null,
    }
  }
  if (snap.direction === "left") {
    return {
      label: "Turn left",
      icon: "TURN_LEFT",
      road: namedToRoad ? `onto ${namedToRoad}` : null,
      distance: null,
    }
  }

  // Continue — always show a distance. Prefer the next-pivot distance and
  // label it with the upcoming turn so a value jump (e.g. 162m → 287m as we
  // pass one pivot and start counting down to the next one) reads as a
  // state change instead of a glitch. When no pivots are ahead (final
  // approach), fall back to destination distance with "to destination".
  let distance: string | null = null
  if (snap.distanceToNextPivotMeters != null && snap.nextPivotDirection) {
    const verb = snap.nextPivotDirection === "right" ? "turn right" : "turn left"
    distance = `In ${formatDistance(snap.distanceToNextPivotMeters)}, ${verb}`
  } else if (snap.distanceToDestinationMeters != null) {
    distance = `In ${formatDistance(snap.distanceToDestinationMeters)} to destination`
  }

  // SDK's fromRoad is authoritative when present; fall back to the
  // geocoder so we always show *some* street name on Continue.
  const road = realRoadName(maneuver?.fromRoad) ?? geocoderRoad
  return {label: "Continue", icon: "STRAIGHT", road, distance}
}

/**
 * The SDK sometimes returns placeholder road labels like "toward Fell St"
 * when it doesn't have a confirmed road name. Those are useless to show
 * (they read as "onto toward Fell St" / "Continue toward Fell St"). Treat
 * any name starting with "toward" — or a whitespace-only / empty string —
 * as missing.
 */
function realRoadName(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  // The Nav SDK leaks its maneuver-instruction text into fromRoad/toRoad when
  // the underlying road has no name ("Slight left", "Sharp right", "Keep
  // left", "Merge", "Roundabout", "Toward Fell St", "U-turn", etc.). Rendered
  // blindly these read as gibberish ("Continue | Slight left"), so we treat
  // anything starting with one of these verbs as missing — the geocoder
  // fallback in pickDisplay will fill in a real street name instead.
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
