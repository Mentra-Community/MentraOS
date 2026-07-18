import {AnimatePresence, motion} from "motion/react"
import {useLayoutEffect, useRef, useState} from "react"

import {useDrawerOffset} from "@/ui/components/Drawer/DrawerOffsetContext"
import {useNavStore} from "@/ui/store/navStore"
import {formatDistance} from "@/ui/lib/formatDistance"
import {haversineMeters, remainingRouteMeters} from "@/ui/lib/geometry"
import type {LatLng, PlaceDetails} from "@/shared/types"

type Props = {
  destination: PlaceDetails | null
  me: LatLng | null
  /** Remaining route distance from the Nav SDK — follows the actual path. */
  routeDistanceMeters?: number | null
  /** Remaining route duration from the Nav SDK — mode-aware. */
  routeDurationSeconds?: number | null
  /** Active route polyline — used to compute a route-following distance
   *  fallback (matches the glasses) when the SDK value isn't in yet. */
  routePoints?: LatLng[] | null
  canRepeatDirection: boolean
  onRepeatDirection: () => void
  onStop: () => void
  onClose: () => void
}

// Fallback only — used when the Nav SDK hasn't sent a maneuver event yet
// so the drawer can render *something* during the brief startup window.
const FALLBACK_WALKING_M_PER_S = 1.4

export function NavigationRunningDrawer({
  destination,
  me,
  routeDistanceMeters,
  routeDurationSeconds,
  routePoints,
  canRepeatDirection,
  onRepeatDirection,
  onStop,
}: Props) {
  const unitSystem = useNavStore((s) => s.unitSystem)
  // Distance precedence (most → least accurate), matching the glasses HUD so the
  // two screens agree:
  //   1. SDK's mode-correct remaining distance (routeDistanceMeters)
  //   2. route-following distance along the polyline (remainingRouteMeters)
  //   3. crow-flies straight line (haversine) — last resort during startup
  const routeRemaining = remainingRouteMeters(me, routePoints ?? null)
  const haversineDistance = destination && me ? haversineMeters(me, destination) : null
  const distanceMeters =
    routeDistanceMeters != null && routeDistanceMeters > 0
      ? routeDistanceMeters
      : routeRemaining != null && routeRemaining > 0
        ? routeRemaining
        : haversineDistance
  const durationSeconds =
    routeDurationSeconds != null && routeDurationSeconds > 0
      ? routeDurationSeconds
      : distanceMeters != null
        ? distanceMeters / FALLBACK_WALKING_M_PER_S
        : null
  const distanceLabel = distanceMeters != null ? formatDistance(distanceMeters, unitSystem) : "—"
  const etaLabel = durationSeconds != null ? formatEta(durationSeconds) : "—"
  const arrivalLabel = durationSeconds != null ? formatArrival(durationSeconds) : "—"

  // Publish the bar's measured height into the shared drawer-offset
  // MotionValue so the NavMap right-rail buttons sit just above us
  // when this drawer is the active one. We're not a `Drawer`, so we
  // mirror its publishing behavior manually.
  const drawerOffset = useDrawerOffset()
  const measureRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (!drawerOffset || !destination) return
    const node = measureRef.current
    if (!node) return
    const update = () => drawerOffset.set(node.getBoundingClientRect().height)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(node)
    return () => {
      ro.disconnect()
      // On unmount, drop our published height so the next drawer (or
      // empty state) doesn't inherit a stale bar height.
      drawerOffset.set(0)
    }
  }, [drawerOffset, destination])

  return (
    <AnimatePresence>
      {destination ? (
        <motion.div
          key="running-bar"
          initial={{y: "100%"}}
          animate={{y: 0}}
          exit={{y: "100%"}}
          transition={{type: "spring", stiffness: 320, damping: 42}}
          className="fixed left-0 right-0 bottom-0 z-40 pointer-events-none">
          <div ref={measureRef} className="[font-synthesis:none] pointer-events-auto mx-auto max-w-md flex items-center pt-4 pb-8.5 gap-2 bg-[#FFFFFFA6] dark:bg-[#161619CC] border-t border-t-solid border-t-[#FFFFFF80] dark:border-t-[#FFFFFF1A] [backdrop-filter:blur(40px)_saturate(180%)] antialiased px-4 rounded-t-[28px]">
            <StatRow
              items={[
                {label: arrivalLabel, sub: "Arrival"},
                {label: etaLabel, sub: "Time"},
                {label: distanceLabel, sub: "Distance"},
              ]}
            />
            {canRepeatDirection ? (
              <button
                type="button"
                onClick={onRepeatDirection}
                className="h-11 flex items-center justify-center rounded-[14px] px-3 bg-[#1A1A1A] dark:bg-zinc-700 shrink-0">
                <div className="tracking-[0.04em] uppercase text-white font-sans font-semibold text-xs/4.5">Repeat</div>
              </button>
            ) : null}
            <button
              type="button"
              onClick={onStop}
              className="h-11 flex items-center justify-center rounded-[14px] px-3.5 bg-[#C84A3D] shrink-0">
              <div className="tracking-[0.04em] uppercase text-white font-sans font-semibold text-sm/4.5">
                End
              </div>
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

/**
 * Three stats sharing a single font size: each stat measures itself at
 * the max size, then the row picks the smallest size any one stat
 * needed to fit on a single line, and renders all three at that size.
 * Keeps the values visually balanced — no one stat shrinks below the
 * others when, e.g., "3:25 PM" is narrower than "59 min".
 */
function StatRow({items}: {items: {label: string; sub: string}[]}) {
  // Font-size ladder for the value (px). The sub-label stays at its
  // original 13px regardless. Picking 18 as the max matches the
  // original `text-lg/5.5` (~18px) the design started at.
  const SIZES = [18, 16, 14, 13, 12] as const
  const LINE_RATIO = 1.22
  const [sizeIdx, setSizeIdx] = useState(0)
  const labelRefs = useRef<Array<HTMLDivElement | null>>([])

  useLayoutEffect(() => {
    // For each stat, find the smallest size index in SIZES that lets
    // the label fit without overflowing its column. The row then picks
    // the largest of those indices (= smallest font) so every stat
    // ends up at the same size.
    let worstIdx = 0
    for (const el of labelRefs.current) {
      if (!el) continue
      let i = 0
      while (i < SIZES.length) {
        const fontPx = SIZES[i]
        const linePx = Math.round(fontPx * LINE_RATIO)
        el.style.fontSize = `${fontPx}px`
        el.style.lineHeight = `${linePx}px`
        // +1px slack absorbs sub-pixel rounding.
        if (el.scrollWidth <= el.clientWidth + 1) break
        i++
      }
      if (i > worstIdx) worstIdx = i
    }
    setSizeIdx(Math.min(worstIdx, SIZES.length - 1))
  }, [items.map((i) => i.label).join("|")])

  const fontPx = SIZES[sizeIdx]
  const linePx = Math.round(fontPx * LINE_RATIO)

  return (
    <>
      {items.map((it, i) => (
        <>
          {i > 0 ? <div key={`sep-${i}`} className="w-px h-7 bg-[#0000001A] dark:bg-[#FFFFFF26] shrink-0" /> : null}
          <div
            key={`stat-${i}`}
            className="grow shrink basis-[0%] min-w-0 flex flex-col items-center gap-0.5">
            <div
              ref={(el) => {
                labelRefs.current[i] = el
              }}
              style={{fontSize: `${fontPx}px`, lineHeight: `${linePx}px`}}
              className="tracking-[-0.01em] text-[#000000E6] dark:text-zinc-50 font-sans font-bold whitespace-nowrap self-stretch text-center overflow-hidden">
              {it.label}
            </div>
            <div className="text-[#0000008C] dark:text-zinc-400 font-sans text-[13px]/4 whitespace-nowrap">{it.sub}</div>
          </div>
        </>
      ))}
    </>
  )
}

function formatEta(seconds: number): string {
  const minutes = seconds / 60
  if (minutes < 1) return "<1 min"
  if (minutes < 60) return `${Math.round(minutes)} min`
  const hours = Math.floor(minutes / 60)
  const rem = Math.round(minutes - hours * 60)
  return `${hours}h ${rem}m`
}

function formatArrival(seconds: number): string {
  const arrival = new Date(Date.now() + seconds * 1000)
  return arrival.toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})
}
