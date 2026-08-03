import {AnimatePresence, motion} from "motion/react"
import {useLayoutEffect, useRef, useState} from "react"
import type {NavManeuver} from "@mentra/miniapp"

import {useNavStore} from "@/ui/store/navStore"
import {formatDistance} from "@/ui/lib/formatDistance"
import {haversineMeters, remainingRouteMeters} from "@/ui/lib/geometry"
import {ManeuverIcon} from "@/ui/components/icons"
import {deriveManeuverDisplay, liveDistanceToNextTurn} from "@/shared/maneuverDisplay"
import type {LatLng, NavRouteStep, NavStatus, UnitSystem} from "@/shared/types"

const SPRING = {type: "spring", stiffness: 400, damping: 32, mass: 0.6} as const

/**
 * Direction card — mirrors the glasses HUD layout verbatim so the
 * phone screen and the glasses always say the same thing:
 *
 *   In 198 m                    ← distance (small grey line)
 *   Turn right onto Market St   ← verb + road (big bold line)
 *
 * The card follows Mapbox's OWN live step tracking — the `NavManeuver`
 * event, which the native layer derives from the Mapbox Navigation SDK's
 * RouteProgress (current step, maneuver type, distance-to-maneuver, and
 * the road being entered). We no longer re-derive turns via the SDK's
 * PivotEngine: Mapbox already map-matches the user to the route and tells
 * us what to do, so following it directly keeps the icon and the
 * instruction text from ever disagreeing.
 */
export function OrientationCard({
  me,
  maneuver,
  routePoints,
  routeSteps,
  status,
}: {
  me: LatLng | null
  heading: number | null
  maneuver: NavManeuver | null
  routePoints: LatLng[] | null
  routeSteps: NavRouteStep[] | null
  status?: NavStatus
  onClose?: () => void
}) {
  const unitSystem = useNavStore((s) => s.unitSystem)
  // Destination name + arrival side (from the trip state) so the arrived
  // card can say "Arrived at <name>, on your left/right" (or "up ahead").
  const destinationName = useNavStore((s) => s.trip.activeDestinationName)
  const arrivalSide = useNavStore((s) => s.trip.arrivalSide)
  // LIVE distance to the next turn, recomputed from the user's current position
  // (`me`, fed by nav:coords) against the route on EVERY coords-driven re-render.
  // This is what keeps the "In X m" line ticking down smoothly: the maneuver
  // event's own distance only refreshes when a new native RouteProgress event
  // fires (slower), so without this the top line lagged while the bottom drawer
  // — which already recomputes from coords — stayed live. The glasses HUD does
  // the identical recompute (shared liveDistanceToNextTurn), so phone + glasses
  // agree. For the ARRIVE leg we pass distance-to-destination instead.
  const liveDist =
    maneuver?.maneuverType === "ARRIVE"
      ? remainingRouteMeters(me, routePoints)
      : liveDistanceToNextTurn(me, routePoints, routeSteps, remainingRouteMeters, haversineMeters)
  // The card now follows Mapbox's OWN live step tracking (the `maneuver`
  // event, derived natively from RouteProgress) rather than the SDK's
  // re-derived PivotEngine turns. Mapbox already map-matches the user to
  // the route and tells us the current step, its maneuver type, the
  // distance to it, and the road being entered — so re-deriving pivots was
  // redundant work that could disagree with Mapbox (the icon/label mismatch
  // seen on pedestrian routes). One source of truth: the maneuver event.
  const real = pickDisplayFromManeuver(
    maneuver,
    status,
    unitSystem,
    destinationName,
    arrivalSide,
    liveDist,
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
      <div className="[font-synthesis:none] relative flex py-4.5 px-5 gap-4  rounded-[20px] items-center bg-[#FFFFFFC7] dark:bg-[#161619D9] border border-solid border-[#FFFFFF99] dark:border-[#FFFFFF1A] [backdrop-filter:blur(40px)_saturate(180%)] [box-shadow:#FFFFFF80_0px_1px_0px_inset,#00000029_0px_8px_32px] antialiased ">
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
            <div className="self-stretch text-[#6B6B6B] dark:text-zinc-400 font-sans text-sm/4.5">{nextRoad}</div>
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
              className="self-stretch">
              <AutoFitLabel text={label} />
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}


/**
 * Single-line / two-line label that auto-shrinks its font size until
 * the text fits in ≤ 2 lines. The default size matches the original
 * card (text-[28px]/8.5 → 28px font, ~34px line). On each text change
 * we reset to the max, measure, and step down through a fixed ladder
 * until `scrollHeight <= 2 * lineHeight` or we hit the floor.
 *
 * Measurement runs in useLayoutEffect so the shrink commits before the
 * browser paints, avoiding a one-frame flash of overflowing text.
 */
function AutoFitLabel({text}: {text: string}) {
  // Font-size ladder (px). The line-height is held proportional at
  // ~1.22× so the two-line ceiling tracks the font size cleanly.
  const SIZES = [28, 24, 22, 20, 18, 16, 14] as const
  const LINE_RATIO = 1.22
  const [sizeIdx, setSizeIdx] = useState(0)
  const ref = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // Reset to the largest size and measure. If it overflows two lines,
    // step down until it fits or we hit the smallest tier.
    let i = 0
    while (i < SIZES.length) {
      const fontPx = SIZES[i]
      const linePx = Math.round(fontPx * LINE_RATIO)
      el.style.fontSize = `${fontPx}px`
      el.style.lineHeight = `${linePx}px`
      // +1px slack for sub-pixel rounding so we don't step down for a
      // ghost half-pixel of overflow.
      if (el.scrollHeight <= linePx * 2 + 1) break
      i++
    }
    setSizeIdx(Math.min(i, SIZES.length - 1))
  }, [text])

  const fontPx = SIZES[sizeIdx]
  const linePx = Math.round(fontPx * LINE_RATIO)
  return (
    <div
      ref={ref}
      style={{fontSize: `${fontPx}px`, lineHeight: `${linePx}px`}}
      className="tracking-[-0.02em] text-[#111111] dark:text-zinc-50 font-sans font-semibold wrap-break-word">
      {text}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Mapbox maneuver -> display fields                                           */

/**
 * Derive the card's display fields from the live `NavManeuver` event via
 * the SHARED `deriveManeuverDisplay` helper — the exact same logic the
 * glasses HUD uses, so the phone card and the glasses can never disagree on
 * instruction text, distance, or turn. This wrapper only adapts the shared
 * pieces into the card's field shape and formats the distance with the
 * user's unit system:
 *
 *   In <distance>                       ← nextRoad (small grey top line)
 *   <Mapbox's verbatim instruction>     ← label (big bold bottom line)
 */
function pickDisplayFromManeuver(
  maneuver: NavManeuver | null,
  status: NavStatus | undefined,
  unit: UnitSystem,
  destinationName?: string | null,
  arrivalSide?: "left" | "right" | null,
  liveDistanceMeters?: number | null,
): {label: string; icon: string; road: string | null; nextRoad: string | null} {
  if (status === "arrived") {
    // "You have arrived at <name>, on your left/right" — or "up ahead" when
    // the destination is straight in front (no side). Mirrors the glasses HUD.
    const at = destinationName ? ` at ${destinationName}` : ""
    const side = arrivalSide ? `, on your ${arrivalSide}` : ", up ahead"
    return {label: `You have arrived${at}${side}`, icon: "ARRIVE", road: null, nextRoad: null}
  }
  const d = deriveManeuverDisplay(maneuver, status, liveDistanceMeters)
  if (!d) {
    // No maneuver yet — typically the brief gap right after pressing Start,
    // before Mapbox emits the first step. Show a neutral "Starting…" rather
    // than "Arriving" (which wrongly implies we're about to reach the
    // destination). Straight-ahead icon, no distance line.
    return {label: "Starting…", icon: "STRAIGHT", road: null, nextRoad: null}
  }

  // Final-leg arrival countdown.
  if (d.arriving) {
    const label =
      d.distanceMeters != null ? `Arriving in ${formatDistance(d.distanceMeters, unit)}` : "Arriving"
    return {label, icon: "ARRIVE", nextRoad: null, road: null}
  }

  const topLine = d.distanceMeters != null ? `In ${formatDistance(d.distanceMeters, unit)}` : null
  // Turn icon ONLY at the turn ("Now"); straight-ahead while still
  // approaching ("In 90 m"). Mirrors the glasses ↑→←/→ arrow gate so the
  // phone card and the HUD show the same directional state at the same time.
  const icon = d.atTurn ? d.kind : "STRAIGHT"
  return {label: d.instruction, icon, nextRoad: d.atTurn ? "Now" : topLine, road: null}
}

