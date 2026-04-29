import {useEffect, useState} from "react"
import {AnimatePresence, motion} from "motion/react"

import {Drawer} from "@/frontend/components/Drawer/Drawer"
import {haversineMeters} from "@/backend/lib/geometry/geometry"
import type {LatLng} from "@/backend/lib/geometry/geometry"
import type {PlaceDetails} from "@/backend/lib/places/places"

type Props = {
  destination: PlaceDetails | null
  me: LatLng | null
  running: boolean
  canStart: boolean
  simulate: boolean
  speedMultiplier: number
  onStart: () => void
  onStop: () => void
  /** Called when the user dismisses the drawer (swipe down or tap handle).
   *  The page should clear its destination state in response. */
  onClose: () => void
}

// Average walking pace, used to estimate ETA from straight-line distance.
const WALKING_M_PER_S = 1.4

const DM_SANS = "'DM Sans', system-ui, sans-serif"

export function DestinationDrawer({
  destination,
  me,
  running,
  canStart,
  simulate,
  speedMultiplier,
  onStart,
  onStop,
  onClose,
}: Props) {
  const distanceMeters = destination && me ? haversineMeters(me, destination) : null
  const distanceLabel = distanceMeters != null ? formatMiles(distanceMeters) : "—"
  const etaLabel = distanceMeters != null ? formatEta(distanceMeters) : "—"

  // Default: expanded when idle (showing full trip card), collapsed to
  // peek the moment a trip starts. Users can drag the handle either way.
  const [expanded, setExpanded] = useState(!running)
  useEffect(() => {
    setExpanded(!running)
  }, [running])

  return (
    <Drawer
      open={!!destination}
      onClose={onClose}
      dismissOnSwipeDown={!running}
      peekHeight={running ? 84 : undefined}
      expanded={expanded}
      onExpandedChange={setExpanded}
      className="pointer-events-auto mx-auto max-w-md flex flex-col rounded-tl-[22px] rounded-tr-[22px] pt-1 pr-4.5 pb-5.5 pl-4.5 bg-[#F5F1E8] [box-shadow:#1F1F1B0F_0px_-2px_16px] antialiased text-xs/4 [font-synthesis:none]">
      {destination ? (
        <AnimatePresence mode="popLayout" initial={false}>
          {running ? (
            <motion.div
              key="running"
              layout
              initial={{opacity: 0, y: 12}}
              animate={{opacity: 1, y: 0}}
              exit={{opacity: 0, y: 12}}
              transition={{duration: 0.22, ease: [0.22, 1, 0.36, 1]}}
              className="flex flex-col gap-3.5 pt-1"
              style={{fontFamily: DM_SANS}}>
              <RunningBody
                destination={destination}
                etaLabel={etaLabel}
                distanceLabel={distanceLabel}
                onStop={onStop}
              />
            </motion.div>
          ) : (
            <motion.div
              key="preview"
              layout
              initial={{opacity: 0, y: -12}}
              animate={{opacity: 1, y: 0}}
              exit={{opacity: 0, y: -12}}
              transition={{duration: 0.22, ease: [0.22, 1, 0.36, 1]}}
              className="flex flex-col gap-3.5 pt-1"
              style={{fontFamily: DM_SANS}}>
              <PreviewBody
                destination={destination}
                etaLabel={etaLabel}
                distanceLabel={distanceLabel}
                canStart={canStart}
                simulate={simulate}
                speedMultiplier={speedMultiplier}
                onStart={onStart}
              />
            </motion.div>
          )}
        </AnimatePresence>
      ) : null}
    </Drawer>
  )
}

/* -------------------------------------------------------------------------- */
/* Idle / preview mode — full place card + Start button. */

function PreviewBody({
  destination,
  etaLabel,
  distanceLabel,
  canStart,
  simulate,
  speedMultiplier,
  onStart,
}: {
  destination: PlaceDetails
  etaLabel: string
  distanceLabel: string
  canStart: boolean
  simulate: boolean
  speedMultiplier: number
  onStart: () => void
}) {
  return (
    <>
      <div className="flex flex-col px-0.5 gap-1">
        <div
          className="tracking-[-0.01em] text-[#1F1F1B] font-semibold text-[22px] leading-[26px] truncate"
          style={{fontFamily: DM_SANS}}>
          {destination.name || "Unnamed place"}
        </div>
        {destination.address ? (
          <div
            className="text-[#6B675F] text-[13px] leading-[18px] truncate"
            style={{fontFamily: DM_SANS}}>
            {destination.address}
          </div>
        ) : null}
      </div>

      <div className="flex items-center pt-1.5 pb-1 gap-7 px-0.5">
        <Stat icon={<PinIcon />} label={distanceLabel} sub="Distance" />
        <Stat icon={<ClockIcon />} label={etaLabel} sub="Walking" />
      </div>

      <button
        onClick={onStart}
        disabled={!canStart}
        className="flex items-center justify-center w-full rounded-[14px] py-4 gap-2.5 bg-[#5C7A4F] disabled:bg-[#5C7A4F]/40 disabled:cursor-not-allowed">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
          <path d="M5 4l14 8-14 8V4z" fill="#F5F1E8" />
        </svg>
        <div
          className="tracking-[0.01em] text-[#F5F1E8] font-semibold text-base leading-[18px]"
          style={{fontFamily: DM_SANS}}>
          Start
        </div>
        {simulate ? (
          <div className="flex items-center rounded-full py-0.5 px-2 bg-[#F5F1E82E]">
            <div
              className="tracking-[0.04em] text-[#F5F1E8] font-medium text-[11px] leading-3"
              style={{fontFamily: DM_SANS}}>
              sim {speedMultiplier}×
            </div>
          </div>
        ) : null}
      </button>
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* Running mode — peek strip (always visible) + live stats + Cancel below.    */

function RunningBody({
  destination,
  etaLabel,
  distanceLabel,
  onStop,
}: {
  destination: PlaceDetails
  etaLabel: string
  distanceLabel: string
  onStop: () => void
}) {
  return (
    <>
      {/* Peek strip — name + live ETA/distance summary. */}
      <div className="flex flex-col px-0.5 gap-1">
        <div
          className="tracking-[-0.01em] text-[#1F1F1B] font-semibold text-[18px] leading-[22px] truncate"
          style={{fontFamily: DM_SANS}}>
          {destination.name || "Unnamed place"}
        </div>
        <div className="flex items-center gap-2 text-[13px] leading-[18px]" style={{fontFamily: DM_SANS}}>
          <span className="text-[#1F1F1B] font-semibold tabular-nums shrink-0">{etaLabel}</span>
          <span className="text-[#8B8678] shrink-0">·</span>
          <span className="text-[#1F1F1B] font-semibold tabular-nums shrink-0">{distanceLabel}</span>
        </div>
      </div>

      {/* Expanded body — stat tiles + Cancel. */}
      <div className="flex items-center pt-1.5 pb-1 gap-7 px-0.5">
        <Stat icon={<PinIcon />} label={distanceLabel} sub="Distance" />
        <Stat icon={<ClockIcon />} label={etaLabel} sub="Walking" />
      </div>

      <button
        onClick={onStop}
        className="flex items-center justify-center w-full rounded-[14px] py-4 gap-2.5 bg-[#B23A3A]">
      
        <div
          className="tracking-[0.01em] text-[#F5F1E8] font-semibold text-base leading-[18px]"
          style={{fontFamily: DM_SANS}}>
          END TRIP
        </div>
      </button>
    </>
  )
}

function Stat({icon, label, sub}: {icon: React.ReactNode; label: string; sub: string}) {
  return (
    <div className="flex items-center shrink-0 gap-3">
      <div className="flex items-center justify-center shrink-0 rounded-full bg-white border border-solid border-[#E4DECD] size-9">
        {icon}
      </div>
      <div className="flex flex-col gap-0.5 min-w-0">
        <div
          className="text-[#1F1F1B] font-semibold text-base leading-[18px] truncate"
          style={{fontFamily: DM_SANS}}>
          {label}
        </div>
        <div
          className="tracking-[0.12em] uppercase text-[#8B8678] font-medium text-[10px] leading-3"
          style={{fontFamily: DM_SANS}}>
          {sub}
        </div>
      </div>
    </div>
  )
}

function PinIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{flexShrink: 0}}>
      <path
        d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"
        stroke="#5C7A4F"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="9" r="2.5" stroke="#5C7A4F" strokeWidth="1.6" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{flexShrink: 0}}>
      <circle cx="12" cy="12" r="9" stroke="#5C7A4F" strokeWidth="1.6" />
      <path
        d="M12 7v5l3 2"
        stroke="#5C7A4F"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function formatMiles(meters: number): string {
  const miles = meters / 1609.344
  if (miles < 0.1) return `${Math.round(meters * 3.28084)} ft`
  if (miles < 10) return `${miles.toFixed(1)} mi`
  return `${Math.round(miles)} mi`
}

function formatEta(meters: number): string {
  const minutes = meters / WALKING_M_PER_S / 60
  if (minutes < 1) return "<1 min"
  if (minutes < 60) return `${Math.round(minutes)} min`
  const hours = Math.floor(minutes / 60)
  const rem = Math.round(minutes - hours * 60)
  return `${hours}h ${rem}m`
}
