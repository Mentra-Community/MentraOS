import type {NavManeuver} from "@mentra/miniapp"

import {formatDistance} from "@/backend/lib/formatDistance/formatDistance"
import {nextSegmentBearing, signedAngleDiff} from "@/backend/lib/geometry/geometry"
import type {LatLng} from "@/backend/lib/geometry/geometry"
import {useUser} from "@/backend/hooks/useUser"

/**
 * OrientationCard
 *
 * Sits between the maneuver pill and the map. Three pieces of info:
 *
 *  1. A soft hint when the phone is pointed wrong relative to the route's
 *     current direction of travel (only when off by > ~30°).
 *  2. NOW row: what the user should do right this moment.
 *  3. NEXT row: the upcoming turn (hidden when NOW already is the turn).
 */
export function OrientationCard({
  me,
  heading,
  maneuver,
  routePoints,
}: {
  me: LatLng | null
  heading: number | null
  maneuver: NavManeuver | null
  routePoints: LatLng[] | null
}) {
  const fmt = useUser().navigation.format
  const segmentBearing = nextSegmentBearing(me, routePoints)
  const headingOffset =
    heading != null && segmentBearing != null ? signedAngleDiff(segmentBearing, heading) : null

  const offAxis = headingOffset != null ? Math.abs(headingOffset) > 30 : false
  const reversed = headingOffset != null ? Math.abs(headingOffset) > 90 : false

  return (
    <div className="my-3 p-3 border border-[#d6e4f0] bg-[#f4f8fc] rounded-xl">
      {/* Top row — orientation hint */}
      <div className="flex items-center gap-3">
        <div className="w-[38px] h-[38px] rounded-full bg-white border border-[#d6e4f0] flex items-center justify-center shrink-0">
          {headingOffset == null ? (
            <span className="text-[18px] text-neutral-400">•</span>
          ) : reversed ? (
            <span className="text-[22px] text-red-700 font-bold">↻</span>
          ) : offAxis ? (
            <span className="text-[22px] text-amber-600 font-bold">
              {headingOffset < 0 ? "↺" : "↻"}
            </span>
          ) : (
            <span className="text-[22px] text-emerald-700 font-bold">↑</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-semibold leading-tight text-neutral-900">
            {headingOffset == null
              ? "Hold the phone level to orient"
              : reversed
                ? "You're facing away from the route — turn around"
                : offAxis
                  ? `Slight ${headingOffset < 0 ? "left" : "right"} — face along the route`
                  : "You're aimed correctly"}
          </div>
          {headingOffset != null ? (
            <div className="text-[11px] text-neutral-500 mt-0.5 font-mono">
              {Math.abs(Math.round(headingOffset))}° off the route
            </div>
          ) : null}
        </div>
      </div>

      <div className="h-px bg-[#dde7f2] my-2.5" />

      {/* NOW */}
      <div className="flex items-center gap-3">
        <span className="text-[28px] font-bold text-blue-600 w-[38px] text-center shrink-0">
          {nowGlyph(maneuver, fmt)}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-bold text-blue-600 tracking-wider mb-0.5">NOW</div>
          <div className="text-base font-semibold leading-tight text-neutral-900">
            {formatNow(maneuver, fmt)}
          </div>
        </div>
      </div>

      {/* NEXT (hidden when NOW already shows the turn) */}
      {showNext(maneuver, fmt) ? (
        <>
          <div className="h-px bg-[#e6eef7] my-2" />
          <div className="flex items-center gap-3">
            <span className="text-[22px] font-bold text-slate-500 w-[38px] text-center shrink-0">
              {nextGlyph(maneuver, fmt)}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-bold text-slate-500 tracking-wider mb-0.5">NEXT</div>
              <div className="text-sm font-medium leading-tight text-neutral-700">
                {formatNext(maneuver, fmt)}
              </div>
            </div>
          </div>
        </>
      ) : null}
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

function formatNow(m: NavManeuver | null, fmt: ManeuverFormatter): string {
  if (!m) return "Waiting for route…"
  if (m.maneuverType === "ARRIVE") {
    return m.distanceMeters > 0 ? `Arriving in ${formatDistance(m.distanceMeters)}` : "Arriving"
  }
  if (m.distanceMeters >= 0 && m.distanceMeters <= IMMINENT_M && !fmt.isStraight(m)) {
    const verb = fmt.humanize(m.maneuverType)
    const onto = m.toRoad ? ` onto ${m.toRoad}` : ""
    return `${fmt.cap(verb)}${onto}`
  }
  const road = m.fromRoad?.trim()
  const dist = m.distanceMeters > 0 ? formatDistance(m.distanceMeters) : null
  if (road && dist) return `Continue on ${road} for ${dist}`
  if (road) return `Continue on ${road}`
  if (dist) return `Continue straight for ${dist}`
  return "Continue straight"
}

function formatNext(m: NavManeuver, fmt: ManeuverFormatter): string {
  const verb = fmt.humanize(m.maneuverType)
  const onto = m.toRoad ? ` onto ${m.toRoad}` : ""
  if (m.maneuverType === "STRAIGHT" || m.maneuverType === "CONTINUE") {
    return m.toRoad ? `Continue onto ${m.toRoad}` : "Continue straight"
  }
  return `${fmt.cap(verb)}${onto}`
}

function nowGlyph(m: NavManeuver | null, fmt: ManeuverFormatter): string {
  if (!m) return "•"
  if (m.maneuverType === "ARRIVE") return "📍"
  if (m.distanceMeters >= 0 && m.distanceMeters <= IMMINENT_M && !fmt.isStraight(m)) {
    return fmt.arrow(m.maneuverType)
  }
  return "↑"
}

function nextGlyph(m: NavManeuver, fmt: ManeuverFormatter): string {
  if (m.maneuverType === "ARRIVE") return "📍"
  return fmt.arrow(m.maneuverType)
}
