import {AnimatePresence, motion} from "motion/react"
import type {NavManeuver} from "@mentra/miniapp"
import {Footprints} from "lucide-react"

import {formatDistance} from "@/backend/lib/formatDistance/formatDistance"
import type {LatLng} from "@/backend/lib/geometry/geometry"
import {useUser} from "@/backend/hooks/useUser"

const SPRING = {type: "spring", stiffness: 400, damping: 32, mass: 0.6} as const
const FADE = {duration: 0.15, ease: [0.4, 0, 0.2, 1]} as const

export function OrientationCard({
  maneuver,
}: {
  me: LatLng | null
  heading: number | null
  maneuver: NavManeuver | null
  routePoints: LatLng[] | null
}) {
  const fmt = useUser().navigation.format

  const {instruction, distance} = splitNow(maneuver, fmt)
  const nextText = showNext(maneuver, fmt) ? formatNext(maneuver, fmt) : null
  const nextArrow = maneuver && nextText ? nextGlyph(maneuver, fmt) : null

  return (
    <div className="mx-2 mt-2 mb-2">
      {/* NOW */}
      <div className="flex items-start gap-3 bg-white px-4 py-3 border-2 border-[#5a7a4f65] rounded-[10px] rounded-bl-none">
        <div className="flex items-center justify-center self-start shrink-0 rounded-full bg-[#5C7A4F] size-9">
          <Footprints size={18} color="#F5F1E8" strokeWidth={1.75} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-semibold text-[#5C7A4F] tracking-widest uppercase mb-0.5">Now</div>
          {/* Instruction only re-animates when the turn type changes */}
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={instruction}
              initial={{opacity: 0, y: 6}}
              animate={{opacity: 1, y: 0}}
              exit={{opacity: 0, y: -6}}
              transition={SPRING}
              className="text-[25px] font-semibold leading-tight text-[#1F1F1B]">
              {instruction}
            </motion.div>
          </AnimatePresence>
          {distance ? (
            <div className="text-[13px] font-medium text-[#8B8678] mt-0.5 tabular-nums">{distance}</div>
          ) : null}
        </div>
      </div>

      {/* NEXT */}
      <AnimatePresence initial={false}>
        {nextText ? (
          <motion.div
            key="next-row"
            initial={{opacity: 0, height: 0}}
            animate={{opacity: 1, height: "auto"}}
            exit={{opacity: 0, height: 0}}
            transition={FADE}
            style={{overflowX: "visible", overflowY: "hidden"}}>
            <div className="inline-flex items-center gap-3 bg-[#f0f0f0] pl-4 pr-10 py-1 border-2 border-[#E4DECD] border-t-0 rounded-br-[50px] rounded-bl-[10px]">
              {" "}
              <div className="flex items-center justify-center shrink-0 rounded-full bg-white border border-[#E4DECD] size-9">
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={nextArrow}
                    initial={{opacity: 0, scale: 0.7}}
                    animate={{opacity: 1, scale: 1}}
                    exit={{opacity: 0, scale: 0.7}}
                    transition={SPRING}
                    className="text-[18px] leading-none">
                    {nextArrow}
                  </motion.span>
                </AnimatePresence>
              </div>
              <div className=" min-w-0">
                <div className="text-[10px] font-semibold text-[#8B8678] tracking-widest uppercase mb-0.5">Next</div>
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.div
                    key={nextText}
                    initial={{opacity: 0, y: 4}}
                    animate={{opacity: 1, y: 0}}
                    exit={{opacity: 0, y: -4}}
                    transition={SPRING}
                    className="text-[13px] font-medium leading-tight text-[#1F1F1B] truncate">
                    {nextText}
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

import type {ManeuverFormatter} from "@/backend/session/managers/navigation/ManeuverFormatter"

const IMMINENT_M = 30

function showNext(m: NavManeuver | null, fmt: ManeuverFormatter): m is NavManeuver {
  if (!m) return false
  if (m.maneuverType === "ARRIVE") return false
  if (!fmt.isStraight(m) && m.distanceMeters >= 0 && m.distanceMeters <= IMMINENT_M) return false
  return true
}

/** Returns the stable instruction label and the frequently-changing distance separately. */
function splitNow(m: NavManeuver | null, fmt: ManeuverFormatter): {instruction: string; distance: string | null} {
  if (!m) return {instruction: "Waiting for route…", distance: null}

  if (m.maneuverType === "ARRIVE") {
    return {
      instruction: "Arriving",
      distance: m.distanceMeters > 0 ? `In ${formatDistance(m.distanceMeters)}` : null,
    }
  }

  // Imminent turn — show verb + road as the instruction, no separate distance
  if (m.distanceMeters >= 0 && m.distanceMeters <= IMMINENT_M && !fmt.isStraight(m)) {
    const verb = fmt.humanize(m.maneuverType)
    const onto = m.toRoad ? ` onto ${m.toRoad}` : ""
    return {instruction: `${fmt.cap(verb)}${onto}`, distance: null}
  }

  const road = m.fromRoad?.trim()
  const dist = m.distanceMeters > 0 ? formatDistance(m.distanceMeters) : null
  const instruction = road ? `Continue on ${road}` : "Continue straight"
  return {instruction, distance: dist ? `In ${dist}` : null}
}

function formatNext(m: NavManeuver, fmt: ManeuverFormatter): string {
  if (m.maneuverType === "STRAIGHT" || m.maneuverType === "CONTINUE") {
    return m.toRoad ? `Continue onto ${m.toRoad}` : "Continue straight"
  }
  const verb = fmt.humanize(m.maneuverType)
  const onto = m.toRoad ? ` onto ${m.toRoad}` : ""
  return `${fmt.cap(verb)}${onto}`
}

function nextGlyph(m: NavManeuver, fmt: ManeuverFormatter): string {
  if (m.maneuverType === "ARRIVE") return "📍"
  return fmt.arrow(m.maneuverType)
}
