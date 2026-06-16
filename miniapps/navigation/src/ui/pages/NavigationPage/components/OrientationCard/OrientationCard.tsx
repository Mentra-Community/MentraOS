import {AnimatePresence, motion} from "motion/react"
import {useLayoutEffect, useRef, useState} from "react"
import type {NavManeuver} from "@mentra/miniapp"

import type {Pivot} from "@mentra/miniapp"

import {useNavStore} from "@/ui/store/navStore"
import {formatDistance} from "@/ui/lib/formatDistance"
import {haversineMeters} from "@/ui/lib/geometry"
import {ManeuverIcon} from "@/ui/components/icons"
import type {Coords, LatLng, NavStatus} from "@/shared/types"

const SPRING = {type: "spring", stiffness: 400, damping: 32, mass: 0.6} as const

/**
 * Direction card — mirrors the glasses HUD layout verbatim so the
 * phone screen and the glasses always say the same thing:
 *
 *   In 198 m                    ← distance (small grey line)
 *   Turn right onto Market St   ← verb + road (big bold line)
 *
 * Or, with the `useRawInstructions` debug toggle on, the bottom line
 * becomes Google's raw `navigationInstruction` text instead:
 *
 *   In 198 m
 *   Head west on Hayes St toward Gough St
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
  const routeSteps = useNavStore((s) => s.trip.routeSteps)
  const useRawInstructions = useNavStore((s) => s.devSettings.useRawInstructions)
  const snap = derivePivotView(activePivot, upcomingPivot, coords, maneuver, status)
  const real = pickDisplay(snap, {
    useRawInstructions,
    activeInstruction: useRawInstructions ? lookupInstructionForPivot(activePivot, routeSteps) : null,
    upcomingInstruction: useRawInstructions ? lookupInstructionForPivot(upcomingPivot, routeSteps) : null,
  })

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
            <div className="self-stretch text-[#6B6B6B] font-sans text-sm/4.5">{nextRoad}</div>
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
      className="tracking-[-0.02em] text-[#111111] font-sans font-semibold wrap-break-word">
      {text}
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

type RawOpts = {
  useRawInstructions: boolean
  activeInstruction: string | null
  upcomingInstruction: string | null
}

function pickDisplay(
  snap: PivotView,
  raw: RawOpts = {useRawInstructions: false, activeInstruction: null, upcomingInstruction: null},
): {label: string; icon: string; road: string | null; nextRoad: string | null} {
  // Mirrors refreshHUD() in NavigationController so the card and the
  // glasses always say the same thing. `nextRoad` is the small grey
  // top line (distance / context); `label` is the big bold bottom
  // line (verb + road or Google's raw instruction).
  if (snap.arrived) {
    return {label: "Arrived", icon: "ARRIVE", road: null, nextRoad: null}
  }

  // Active turn — user is inside the pivot's radius. Two-line layout
  // (no distance, the user is AT the turn):
  //   <empty top line>
  //   Turn left|right [onto <toRoad>]
  if (snap.activeDirection) {
    const verb = snap.activeDirection === "right" ? "Turn right" : "Turn left"
    const icon = snap.activeDirection === "right" ? "TURN_RIGHT" : "TURN_LEFT"
    // At the pivot. Google's raw text already contains the verb
    // ("Turn right onto X St"); show "Now" as the top line instead of
    // duplicating our own "Turn right" line.
    if (raw.useRawInstructions && raw.activeInstruction) {
      return {label: raw.activeInstruction, icon, nextRoad: "Now", road: null}
    }
    const label = snap.activeToRoad ? `${verb} onto ${snap.activeToRoad}` : verb
    return {label, icon, nextRoad: null, road: null}
  }

  // Approaching the next turn. Mirror of the HUD's distance-first
  // layout:
  //   In <distance>
  //   Turn left|right onto <toRoad>     (or Google's raw text)
  if (snap.distanceToNextPivotMeters != null && snap.upcomingDirection) {
    const verb = snap.upcomingDirection === "right" ? "Turn right" : "Turn left"
    const distStr = formatDistance(snap.distanceToNextPivotMeters)
    const icon = snap.upcomingDirection === "right" ? "TURN_RIGHT" : "TURN_LEFT"
    const topLine = `In ${distStr}`
    if (raw.useRawInstructions && raw.upcomingInstruction) {
      return {label: raw.upcomingInstruction, icon, nextRoad: topLine, road: null}
    }
    const label = snap.upcomingToRoad ? `${verb} onto ${snap.upcomingToRoad}` : verb
    return {label, icon, nextRoad: topLine, road: null}
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
/**
 * Match a pivot to its corresponding step in `trip.routeSteps` by
 * `(lat, lng)` and return that step's cached Google `instruction`
 * string. Returns null when no match — usually means the cache hasn't
 * been refreshed after a reroute yet (the controller's silent refetch
 * handles that, this is the consumer side).
 */
function lookupInstructionForPivot(
  pivot: Pivot | null,
  steps: import("@/shared/types").NavRouteStep[] | null,
): string | null {
  if (!pivot || !steps || steps.length === 0) return null
  const EPS = 1e-5
  for (const s of steps) {
    if (Math.abs(s.lat - pivot.lat) < EPS && Math.abs(s.lng - pivot.lng) < EPS) {
      return s.instruction || null
    }
  }
  return null
}

function realRoadName(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (/^(toward|turn|continue|destination|head|cross|slight|sharp|keep|merge|fork|exit|take|roundabout|u[\s-]?turn|arrive|arriving|depart|enter|leave|stay)\b/i.test(trimmed)) return null
  return trimmed
}

