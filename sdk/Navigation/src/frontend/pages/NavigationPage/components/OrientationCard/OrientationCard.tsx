import type {ReactNode} from "react"
import {AnimatePresence, motion} from "motion/react"
import type {NavManeuver} from "@mentra/miniapp"

import {formatDistance} from "@/backend/lib/formatDistance/formatDistance"
import type {LatLng} from "@/backend/lib/geometry/geometry"
import {useUser} from "@/backend/hooks/useUser"

const SPRING = {type: "spring", stiffness: 400, damping: 32, mass: 0.6} as const

export function OrientationCard({
  maneuver,
  onClose,
}: {
  me: LatLng | null
  heading: number | null
  maneuver: NavManeuver | null
  routePoints: LatLng[] | null
  onClose?: () => void
}) {
  const fmt = useUser().navigation.format

  const {distance, instruction, street} = parseManeuver(maneuver, fmt)
  const maneuverType = maneuver?.maneuverType ?? "STRAIGHT"
  const {nextLabel, nextDistance, nextType} = parseNext(maneuver, fmt)

  return (
    <div className="mx-1 mt-2">
      <div className="[font-synthesis:none] relative flex py-4.5 px-5 gap-4 rounded-bl-sm rounded-[20px] items-center bg-[#FFFFFFC7] border border-solid border-[#FFFFFF99] [backdrop-filter:blur(40px)_saturate(180%)] [box-shadow:#FFFFFF80_0px_1px_0px_inset,#00000029_0px_8px_32px] antialiased ">
        {/* Maneuver arrow icon */}
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={maneuverType}
            initial={{opacity: 0, scale: 0.8}}
            animate={{opacity: 1, scale: 1}}
            exit={{opacity: 0, scale: 0.8}}
            transition={SPRING}
            className="flex items-center justify-center shrink-0 rounded-[18px] bg-[#5AC878] size-16">
            <ManeuverIcon type={maneuverType} />
          </motion.div>
        </AnimatePresence>

        {/* Text */}
        <div className="flex flex-col items-start gap-1.5 min-w-0 flex-1">
          {distance ? (
            <div className="self-stretch text-[#6B6B6B] font-sans text-sm/4.5">{distance}</div>
          ) : null}
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={instruction}
              initial={{opacity: 0, y: 6}}
              animate={{opacity: 1, y: 0}}
              exit={{opacity: 0, y: -6}}
              transition={SPRING}
              className="tracking-[-0.02em] self-stretch text-[#111111] font-sans font-semibold text-[28px]/8.5 truncate">
              {instruction}
            </motion.div>
          </AnimatePresence>
          {street ? (
            <div className="self-stretch text-[#111111] font-sans text-base/5.5 truncate">{street}</div>
          ) : null}
        </div>

        {/* Top-right pill: overflow menu + close */}

      </div>

      {/* NEXT maneuver pill */}
      <div className="flex">
      <AnimatePresence>
        {nextLabel ? (
          <motion.div
            key="next"
            initial={{opacity: 0, y: -4}}
            animate={{opacity: 1, y: 0}}
            exit={{opacity: 0, y: -4}}
            transition={SPRING}
            className="mt-1.5 flex items-center pr-3.5 pl-3 gap-3 rounded-tl-sm rounded-bl-2xl bg-[#FFFFFF80] border border-solid border-[#FFFFFF99] [backdrop-filter:blur(30px)_saturate(180%)] [box-shadow:#FFFFFF80_0px_1px_0px_inset,#0000001A_0px_6px_18px] py-2.5 rounded-r-2xl">
            <div className="w-9.5 h-9.5 flex items-center justify-center shrink-0 rounded-xl bg-[#0000000F]">
              <ManeuverIcon type={nextType} size={20} stroke />
            </div>
            <div className="grow shrink basis-0 min-w-0">
              <div className="tracking-[0.16em] uppercase text-[#00000073] font-sans font-bold text-[10px]/3">Next</div>
              <div className="flex items-baseline pt-0.5 gap-2">
                <div className="tracking-[-0.005em] text-[#000000E6] font-sans font-semibold text-sm/4.5 truncate">{nextLabel}</div>
                {nextDistance ? (
                  <div className="text-[#0000008C] font-sans font-medium text-[13px]/4 shrink-0">{nextDistance}</div>
                ) : null}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      </div>
    </div>
  )
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

  if (t === "TURN_RIGHT") return svg(
    <path d="M18 56 L18 38 Q18 26 30 26 L52 26 L52 14 L72 32 L52 50 L52 38 L34 38 L34 56 Z" fill={stroke ? "none" : color} stroke={stroke ? color : undefined} strokeWidth={sw} strokeLinejoin="round" />
  )
  if (t === "TURN_LEFT") return svg(
    <path d="M62 56 L62 38 Q62 26 50 26 L28 26 L28 14 L8 32 L28 50 L28 38 L46 38 L46 56 Z" fill={stroke ? "none" : color} stroke={stroke ? color : undefined} strokeWidth={sw} strokeLinejoin="round" />
  )
  if (t === "SLIGHT_RIGHT") return svg(<>
    <path d="M28 58 L28 42 L28 36 Q30 22 46 18 L60 14 L64 28 L50 32 Q42 34 42 42 L42 58 Z" fill={stroke ? "none" : color} stroke={stroke ? color : undefined} strokeWidth={sw} strokeLinejoin="round" />
    <path d="M54 10 L72 22 L58 36 Z" fill={stroke ? "none" : color} stroke={stroke ? color : undefined} strokeWidth={sw} strokeLinejoin="round" />
  </>)
  if (t === "SLIGHT_LEFT") return svg(<>
    <path d="M52 58 L52 42 L52 36 Q50 22 34 18 L20 14 L16 28 L30 32 Q38 34 38 42 L38 58 Z" fill={stroke ? "none" : color} stroke={stroke ? color : undefined} strokeWidth={sw} strokeLinejoin="round" />
    <path d="M26 10 L8 22 L22 36 Z" fill={stroke ? "none" : color} stroke={stroke ? color : undefined} strokeWidth={sw} strokeLinejoin="round" />
  </>)
  if (t === "SHARP_RIGHT") return svg(
    <path d="M20 58 L20 30 L44 30 L44 14 L68 30 L44 46 L44 44 L34 44 L34 58 Z" fill={stroke ? "none" : color} stroke={stroke ? color : undefined} strokeWidth={sw} strokeLinejoin="round" />
  )
  if (t === "SHARP_LEFT") return svg(
    <path d="M60 58 L60 30 L36 30 L36 14 L12 30 L36 46 L36 44 L46 44 L46 58 Z" fill={stroke ? "none" : color} stroke={stroke ? color : undefined} strokeWidth={sw} strokeLinejoin="round" />
  )
  if (t === "U_TURN") return svg(<>
    <path d="M50 58 L50 36 Q50 20 34 20 Q18 20 18 36 L18 58 L32 58 L32 36 Q32 34 34 34 Q36 34 36 36 L36 58 Z" fill={stroke ? "none" : color} stroke={stroke ? color : undefined} strokeWidth={sw} strokeLinejoin="round" />
    <path d="M42 46 L60 46 L52 58 L60 46 L52 34 Z" fill={stroke ? "none" : color} stroke={stroke ? color : undefined} strokeWidth={sw} strokeLinejoin="round" />
  </>)
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

/* -------------------------------------------------------------------------- */
/* Parsing helpers                                                             */

import type {ManeuverFormatter} from "@/client/session/managers/navigation/ManeuverFormatter"

const IMMINENT_M = 30

function parseManeuver(m: NavManeuver | null, fmt: ManeuverFormatter): {instruction: string; distance: string | null; street: string | null} {
  if (!m) return {instruction: "Waiting…", distance: null, street: null}

  if (m.maneuverType === "ARRIVE") {
    return {
      instruction: "Arriving",
      distance: m.distanceMeters > 0 ? `In ${formatDistance(m.distanceMeters)}` : null,
      street: null,
    }
  }

  // Imminent turn — verb is the headline, street is "onto X"
  if (!fmt.isStraight(m) && m.distanceMeters >= 0 && m.distanceMeters <= IMMINENT_M) {
    const verb = fmt.cap(fmt.humanize(m.maneuverType))
    return {
      instruction: verb,
      distance: null,
      street: m.toRoad ? `onto ${m.toRoad}` : null,
    }
  }

  // Normal state — show distance above, turn verb as headline, street below
  if (!fmt.isStraight(m)) {
    const verb = fmt.cap(fmt.humanize(m.maneuverType))
    const dist = m.distanceMeters > 0 ? `In ${formatDistance(m.distanceMeters)}` : null
    return {
      instruction: verb,
      distance: dist,
      street: m.toRoad ? `onto ${m.toRoad}` : null,
    }
  }

  // Straight
  const road = m.fromRoad?.trim() || null
  const dist = m.distanceMeters > 0 ? `In ${formatDistance(m.distanceMeters)}` : null
  return {
    instruction: road ? `Continue on ${road}` : "Continue straight",
    distance: dist,
    street: null,
  }
}

function parseNext(m: NavManeuver | null, fmt: ManeuverFormatter): {nextLabel: string | null; nextDistance: string | null; nextType: string} {
  // No maneuver, arriving, or already in an imminent turn — hide NEXT
  if (!m) return {nextLabel: null, nextDistance: null, nextType: "STRAIGHT"}
  if (m.maneuverType === "ARRIVE") return {nextLabel: null, nextDistance: null, nextType: "STRAIGHT"}
  if (!fmt.isStraight(m) && m.distanceMeters >= 0 && m.distanceMeters <= IMMINENT_M) return {nextLabel: null, nextDistance: null, nextType: "STRAIGHT"}

  const verb = fmt.cap(fmt.humanize(m.maneuverType))
  const dist = m.distanceMeters > 0 ? formatDistance(m.distanceMeters) : null

  if (fmt.isStraight(m)) {
    const road = m.fromRoad?.trim() || null
    return {
      nextLabel: road ? `Continue on ${road}` : "Continue straight",
      nextDistance: dist,
      nextType: m.maneuverType,
    }
  }

  return {
    nextLabel: verb,
    nextDistance: dist,
    nextType: m.maneuverType,
  }
}
