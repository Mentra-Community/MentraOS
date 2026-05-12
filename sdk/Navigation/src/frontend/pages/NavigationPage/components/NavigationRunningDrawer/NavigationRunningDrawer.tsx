import {AnimatePresence, motion} from "motion/react"
import {useLayoutEffect, useRef} from "react"

import {useDrawerOffset} from "@/frontend/components/Drawer/DrawerOffsetContext"
import {formatDistance} from "@/backend/lib/formatDistance/formatDistance"
import {haversineMeters} from "@/backend/lib/geometry/geometry"
import type {LatLng} from "@/backend/lib/geometry/geometry"
import type {PlaceDetails} from "@/backend/lib/places/places"

type Props = {
  destination: PlaceDetails | null
  me: LatLng | null
  onStop: () => void
  onClose: () => void
}

const WALKING_M_PER_S = 1.4

export function NavigationRunningDrawer({destination, me, onStop}: Props) {
  const distanceMeters = destination && me ? haversineMeters(me, destination) : null
  const distanceLabel = distanceMeters != null ? formatDistance(distanceMeters) : "—"
  const etaMinutes = distanceMeters != null ? Math.round(distanceMeters / WALKING_M_PER_S / 60) : null
  const etaLabel = etaMinutes != null ? formatEta(distanceMeters!) : "—"
  const arrivalLabel = etaMinutes != null ? formatArrival(etaMinutes) : "—"

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
          <div ref={measureRef} className="[font-synthesis:none] pointer-events-auto mx-auto max-w-md flex items-center pt-4 pb-8.5 gap-2 bg-[#FFFFFFA6] border-t border-t-solid border-t-[#FFFFFF80] [backdrop-filter:blur(40px)_saturate(180%)] antialiased px-4 rounded-t-[28px]">
            <Stat label={arrivalLabel} sub="Arrival" />
            <div className="w-px h-7 bg-[#0000001A] shrink-0" />
            <Stat label={etaLabel} sub="Time" />
            <div className="w-px h-7 bg-[#0000001A] shrink-0" />
            <Stat label={distanceLabel} sub="Distance" />
            <button
              type="button"
              onClick={onStop}
              className="h-11 flex items-center justify-center rounded-[14px] px-4.5 w-22.25 bg-[#C84A3D] shrink-0">
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

function Stat({label, sub}: {label: string; sub: string}) {
  return (
    <div className="grow shrink basis-[0%] flex flex-col items-center gap-0.5">
      <div className="tracking-[-0.01em] text-[#000000E6] font-sans font-bold text-lg/5.5">{label}</div>
      <div className="text-[#0000008C] font-sans text-[13px]/4">{sub}</div>
    </div>
  )
}

function formatEta(meters: number): string {
  const minutes = meters / WALKING_M_PER_S / 60
  if (minutes < 1) return "<1 min"
  if (minutes < 60) return `${Math.round(minutes)} min`
  const hours = Math.floor(minutes / 60)
  const rem = Math.round(minutes - hours * 60)
  return `${hours}h ${rem}m`
}

function formatArrival(etaMinutes: number): string {
  const arrival = new Date(Date.now() + etaMinutes * 60 * 1000)
  return arrival.toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})
}
