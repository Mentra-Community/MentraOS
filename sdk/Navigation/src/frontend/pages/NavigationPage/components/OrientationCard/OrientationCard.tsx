import type {ReactNode} from "react"
import {AnimatePresence, motion} from "motion/react"
import type {NavManeuver} from "@mentra/miniapp"

import {useUser} from "@/backend/hooks/useUser"
import type {LatLng} from "@/backend/lib/geometry/geometry"
import type {PivotSnapshot} from "@/client/session/managers/navigation/PivotTracker"

const SPRING = {type: "spring", stiffness: 400, damping: 32, mass: 0.6} as const

/**
 * Single-maneuver direction card.
 *
 * Driven by `user.pivots` — the geometry-based maneuver tracker that
 * extracts turn pivots from the SDK route polyline once at trip start, then
 * uses a 4m radius check on every GPS fix to decide WHEN to show the turn.
 * The SDK's `maneuverType` stream is intentionally ignored (it's noisy and
 * flips between LEFT/RIGHT on the same turn).
 *
 * Shows ONE thing at a time:
 *   - "Continue" between pivots
 *   - "Turn left" / "Turn right" inside a pivot's 4m radius
 *   - "Arrived" once within the destination radius
 */
export function OrientationCard(_: {
  me: LatLng | null
  heading: number | null
  maneuver: NavManeuver | null
  routePoints: LatLng[] | null
  onClose?: () => void
}) {
  const user = useUser()
  const snap = user.pivots.getSnapshot()
  const {nowLabel, nowIcon} = pickNow(snap)

  return (
    <div className="mx-1 mt-2">
      <div className="[font-synthesis:none] relative flex py-4.5 px-5 gap-4 rounded-bl-sm rounded-[20px] items-center bg-[#FFFFFFC7] border border-solid border-[#FFFFFF99] [backdrop-filter:blur(40px)_saturate(180%)] [box-shadow:#FFFFFF80_0px_1px_0px_inset,#00000029_0px_8px_32px] antialiased ">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={nowIcon}
            initial={{opacity: 0, scale: 0.8}}
            animate={{opacity: 1, scale: 1}}
            exit={{opacity: 0, scale: 0.8}}
            transition={SPRING}
            className="flex items-center justify-center shrink-0 rounded-[18px] bg-[#5AC878] size-16">
            <ManeuverIcon type={nowIcon} />
          </motion.div>
        </AnimatePresence>

        <div className="flex flex-col items-start gap-1.5 min-w-0 flex-1">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={nowLabel}
              initial={{opacity: 0, y: 6}}
              animate={{opacity: 1, y: 0}}
              exit={{opacity: 0, y: -6}}
              transition={SPRING}
              className="tracking-[-0.02em] self-stretch text-[#111111] font-sans font-semibold text-[28px]/8.5 truncate">
              {nowLabel}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* PivotSnapshot -> labels                                                     */

function pickNow(snap: PivotSnapshot): {nowLabel: string; nowIcon: string} {
  if (snap.arrived) return {nowLabel: "Arrived", nowIcon: "ARRIVE"}
  if (snap.direction === "right") return {nowLabel: "Turn right", nowIcon: "TURN_RIGHT"}
  if (snap.direction === "left") return {nowLabel: "Turn left", nowIcon: "TURN_LEFT"}
  return {nowLabel: "Continue", nowIcon: "STRAIGHT"}
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
